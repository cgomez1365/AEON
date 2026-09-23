/**
 * Day-wise views over the LLM call ledger — pure functions, no I/O.
 *
 * `_`-prefixed, so the block host never mounts it (blockHost.cjs skips helper
 * files) and gen-block-routes never reads it as a router.
 *
 * Every calendar walk here builds dates from components at local NOON —
 * `new Date(y, m, d - i, 12)` — never by stepping a Date with setDate(±1).
 * Stepping keeps the wall-clock time, and on the spring-forward day 02:xx does
 * not exist: the walk silently jumped to 03:xx and, 365 steps later, today
 * failed `cursor <= now` and vanished from the heatmap (measured 2026-09-23 at
 * 02:09 PDT). Noon exists on every day in every zone.
 */

const pad = (n) => String(n).padStart(2, '0');

/** YYYY-MM-DD in local time — the same key llm-ledger.cjs's byDay() uses. */
function dayKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Noon, local, `offset` calendar days from `now` (negative = past). */
function noonOf(now, offset = 0) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 12);
}

/** The last `n` calendar-day keys, oldest first, ending with today. */
function lastNDayKeys(n, now = new Date()) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(dayKey(noonOf(now, -i)));
  return out;
}

/** Weekday (0 = Sunday) of a YYYY-MM-DD key, in local time. */
function weekdayOf(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d, 12).getDay();
}

/** The calendar day after `key`. */
function nextKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return dayKey(new Date(y, m - 1, d + 1, 12));
}

/**
 * One day-map from two sources.
 *
 * The ledger (per-call JSONL) is the record every other surface reads, so it
 * wins wherever it has data. activity_heatmap.json is kept for the history
 * that predates the ledger — and for the ledger's own first day, which may
 * have been partly pruned (the ledger keeps the newest 50,000 calls), the
 * larger of the two counts is the truer one.
 */
function mergeDays(ledgerDays = {}, legacyDays = {}) {
  const ledgerKeys = Object.keys(ledgerDays).sort();
  if (!ledgerKeys.length) return { days: { ...legacyDays }, firstLedgerDay: null };
  const first = ledgerKeys[0];
  const days = {};
  for (const [k, v] of Object.entries(legacyDays)) {
    if (k < first) days[k] = v;
  }
  for (const [k, v] of Object.entries(ledgerDays)) days[k] = v;
  const legacyFirst = legacyDays[first];
  if (legacyFirst && (legacyFirst.requests || 0) > (ledgerDays[first].requests || 0)) {
    days[first] = legacyFirst;
  }
  return { days, firstLedgerDay: first };
}

const isActive = (e) => !!(e && e.requests > 0);

/**
 * Current streak: the run of active days reaching today — or reaching
 * yesterday, when today has no call yet (a day is not "missed" until it is
 * over). Longest: the longest run anywhere in the history.
 */
function streaks(days = {}, now = new Date()) {
  let current = 0;
  let offset = isActive(days[dayKey(noonOf(now, 0))]) ? 0 : -1;
  while (isActive(days[dayKey(noonOf(now, offset))])) { current++; offset--; }

  let longest = 0;
  let run = 0;
  let prev = null;
  for (const k of Object.keys(days).filter(k => isActive(days[k])).sort()) {
    run = prev && nextKey(prev) === k ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = k;
  }
  return { current, longest };
}

/** Totals over the last `n` calendar days, today included. */
function windowTotals(days = {}, n, now = new Date()) {
  const t = { requests: 0, tokens: 0, errors: 0 };
  for (const k of lastNDayKeys(n, now)) {
    const e = days[k];
    if (!e) continue;
    t.requests += e.requests || 0;
    t.tokens += e.tokens || 0;
    t.errors += e.errors || 0;
  }
  return t;
}

module.exports = { dayKey, noonOf, lastNDayKeys, weekdayOf, nextKey, mergeDays, streaks, windowTotals };
