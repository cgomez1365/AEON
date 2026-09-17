/**
 * AEON — credential rotation policy.
 *
 * WHY THIS EXISTS. An endpoint used to carry exactly one credential: the
 * resolver read a single `auth_ref` out of the vault (endpoints.cjs) and every
 * transport in services/ai.js consumed that one key. The rotation the operator
 * actually configured — "several free accounts, and AEON moves between them" —
 * lived in services/ai.js as a Gemini-shaped special case over process.env,
 * and nothing that resolved through the registry could reach it. Real code,
 * unreachable from the path every chat turn takes.
 *
 * So rotation is a kernel concern now, not a provider's. This module works on
 * vault REFS and never on key material: choosing a credential decrypts
 * nothing, and no secret is ever held here. The caller resolves the one ref it
 * is handed, which is why a pool of ten keys costs the same single decrypt per
 * turn that a pool of one always did.
 *
 * ROUND-ROBIN, not sticky-until-failure. The budget being spread is a per-key
 * one: three free keys at 15 rpm are 45 rpm only if the calls are spread
 * across them. Sticky spends one key to its limit, burns a request discovering
 * the 429, and leaves the other two idle until it does.
 *
 * A 429/402/401 is a fact about the KEY, not about the provider. Cooling the
 * key and moving on is what keeps one exhausted free account from taking a
 * whole provider — and the operator's other five accounts — out of service.
 *
 * Module-scope state, on the same reasoning as pacing.cjs: the rotation
 * belongs to the endpoint, not to whichever subsystem happens to be calling.
 */
'use strict';

/**
 * How long a credential sits out, by what the provider said.
 *
 * A rate limit is a one-minute window, so a minute is the honest wait. The
 * other two are not going to resolve on their own: no credit is no credit
 * until someone tops it up, and a rejected key is still rejected a second
 * later. Sitting those out for longer keeps AEON from spending every turn
 * re-discovering the same answer — while still re-checking often enough that
 * a fixed key comes back without a restart.
 */
const COOLDOWN_MS = {
  429: 60_000,
  402: 10 * 60_000,
  401: 30 * 60_000,
  403: 30 * 60_000,
};
const MAX_COOLDOWN_MS = 60 * 60_000;

/** Is this status the credential's fault, or the provider's? */
function isCredentialFault(status) {
  const s = Number(status);
  return s === 401 || s === 402 || s === 403 || s === 429;
}

/** Retry-After, in ms. Accepts the seconds form and the HTTP-date form. */
function parseRetryAfter(value) {
  if (!value) return null;
  const v = String(value).trim();
  if (/^\d+$/.test(v)) return parseInt(v, 10) * 1000;
  const at = new Date(v).getTime();
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

const _state = new Map(); // endpointId -> { cursor, cool: Map<ref, {until,status,reason}> }

function stateFor(endpointId) {
  const id = endpointId || '_';
  let s = _state.get(id);
  if (!s) { s = { cursor: 0, cool: new Map() }; _state.set(id, s); }
  return s;
}

/**
 * Take the next usable credential for this endpoint.
 *
 * Walks one full lap from where the last call left off, skipping anything
 * still cooling. If every credential is cooling it returns the one that
 * recovers soonest, flagged `healthy: false` — the call then goes out and
 * fails with the provider's own words, which is a truer answer than AEON
 * inventing one on the provider's behalf.
 *
 * @returns {{ref, index, total, healthy, retryInMs}|null}
 */
function acquire(endpointId, refs) {
  const list = [...new Set((refs || []).filter(Boolean))];
  if (!list.length) return null;
  const st = stateFor(endpointId);
  const now = Date.now();

  for (let i = 0; i < list.length; i++) {
    const index = (st.cursor + i) % list.length;
    const ref = list[index];
    const cd = st.cool.get(ref);
    if (cd && cd.until > now) continue;
    if (cd) st.cool.delete(ref); // the wait is over — it is a normal key again
    st.cursor = (index + 1) % list.length;
    return { ref, index, total: list.length, healthy: true, retryInMs: 0 };
  }

  let ref = list[0];
  let until = Infinity;
  for (const r of list) {
    const u = st.cool.get(r)?.until ?? 0;
    if (u < until) { until = u; ref = r; }
  }
  return { ref, index: list.indexOf(ref), total: list.length, healthy: false, retryInMs: Math.max(0, until - now) };
}

/**
 * Sit this credential out. Returns the cooldown record, or null when the
 * status was not the credential's fault — a 500 or a timeout says nothing
 * about the key, and benching a good key over the provider's bad minute would
 * shrink the pool for no reason.
 */
function penalize(endpointId, ref, info = {}) {
  if (!ref) return null;
  const status = Number(info.status) || 0;
  if (!isCredentialFault(status)) return null;
  const retry = Number.isFinite(info.retryAfterMs) && info.retryAfterMs > 0 ? info.retryAfterMs : null;
  const ms = Math.min(retry ?? COOLDOWN_MS[status] ?? 60_000, MAX_COOLDOWN_MS);
  const rec = {
    until: Date.now() + ms,
    status,
    reason: String(info.message || '').slice(0, 160),
  };
  stateFor(endpointId).cool.set(ref, rec);
  return rec;
}

/** A credential that just answered is healthy, whatever it did last time. */
function succeed(endpointId, ref) {
  if (!ref) return;
  stateFor(endpointId).cool.delete(ref);
}

/**
 * What the operator sees in Settings. Refs only — the ref is a name the
 * operator chose, never key material — plus whether each one is resting and
 * for how much longer.
 */
function snapshot(endpointId, refs) {
  const list = [...new Set((refs || []).filter(Boolean))];
  const st = _state.get(endpointId || '_');
  const now = Date.now();
  return {
    total: list.length,
    next_index: list.length ? ((st?.cursor ?? 0) % list.length) : 0,
    keys: list.map((ref, index) => {
      const cd = st?.cool.get(ref);
      const cooling = !!cd && cd.until > now;
      return {
        ref,
        index,
        cooling,
        status: cooling ? cd.status : null,
        retry_in_ms: cooling ? cd.until - now : 0,
        reason: cooling ? cd.reason : null,
      };
    }),
    available: list.filter((ref) => {
      const cd = st?.cool.get(ref);
      return !(cd && cd.until > now);
    }).length,
  };
}

/** Forget an endpoint entirely — it was deleted, or its pool was rewritten. */
function forget(endpointId) { _state.delete(endpointId || '_'); }

/** Test seam only. */
function _reset() { _state.clear(); }

module.exports = {
  acquire, penalize, succeed, snapshot, forget,
  isCredentialFault, parseRetryAfter,
  COOLDOWN_MS, _reset,
};
