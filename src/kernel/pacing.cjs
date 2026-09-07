/**
 * AEON — per-endpoint request pacing.
 *
 * Extracted from services/ai.js (BO-EMB) so chat and embedding share ONE
 * budget per address. Two copies of this bucket would let an indexing run and
 * a chat turn each believe they had the endpoint's full quota, and the free
 * tier would answer with the 429 the pacing exists to avoid.
 *
 * Module-scope state on purpose: the budget belongs to the address, not to
 * whichever subsystem happens to be calling it.
 */
'use strict';

const _buckets = new Map(); // key -> { stamps: number[] }

/** Buckets are keyed by address so two endpoints cannot poison each other. */
function paceKey(baseUrl, provider) {
  try { const u = new URL(baseUrl); return `${u.protocol}//${u.host}`; }
  catch { return provider || 'unknown'; }
}

/**
 * Wait until this endpoint's budget allows another call. Delays rather than
 * rejecting, so a long run slows down instead of failing — but never waits
 * unboundedly: past the cap it throws a flagged error the caller can report.
 */
async function pace(key, rpm, { maxWaitMs = 60_000 } = {}) {
  if (!rpm || rpm <= 0) return;
  const started = Date.now();
  for (;;) {
    const b = _buckets.get(key) || { stamps: [] };
    const cutoff = Date.now() - 60_000;
    b.stamps = b.stamps.filter(t => t > cutoff);
    if (b.stamps.length < rpm) {
      b.stamps.push(Date.now());
      _buckets.set(key, b);
      return;
    }
    _buckets.set(key, b);
    const waitFor = Math.max(250, (b.stamps[0] + 60_000) - Date.now());
    if (Date.now() - started + waitFor > maxWaitMs) {
      const err = new Error('This endpoint is at its requests-per-minute limit. Wait a moment and try again, or raise the limit in Settings → Connections.');
      err.localThrottle = true; // structural — never scraped from message text
      throw err;
    }
    await new Promise(r => setTimeout(r, Math.min(waitFor, 2000)));
  }
}

/**
 * How long until this endpoint could take one more call, in ms. 0 = now.
 * Read-only: consumes no budget. Used to estimate an indexing run before it
 * starts, rather than discovering the cost halfway through.
 */
function waitEstimateMs(key, rpm) {
  if (!rpm || rpm <= 0) return 0;
  const b = _buckets.get(key);
  if (!b) return 0;
  const stamps = b.stamps.filter(t => t > Date.now() - 60_000);
  if (stamps.length < rpm) return 0;
  return Math.max(0, (stamps[0] + 60_000) - Date.now());
}

/** Test seam only. */
function _reset() { _buckets.clear(); }

module.exports = { pace, paceKey, waitEstimateMs, _reset };
