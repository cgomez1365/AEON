/**
 * The LLM call ledger — one append-only record per call, aggregates derived.
 *
 * BO-D2g. What this replaces, and why the replacement is a different shape
 * rather than the same file written from more places:
 *
 * WRONG SEAM. Recording hung off addRunCost(), a COST calculation called
 * from exactly one route — dashboard/api/chat.cjs, the legacy non-streaming
 * /api/chat that nothing in the product uses. The streaming terminal,
 * /api/ai, Writer, Council and the agent loop never called it. So
 * db/token_ledger.json was never created, and every consumer — heatmap,
 * Activity, Fleet Control, token-analytics, analytics — correctly reported
 * zero while live telemetry showed calls in the same viewport.
 *
 * Telemetry belongs where _trackLLM already fires: the single seam every
 * provider, local and cloud, already crosses.
 *
 * WRONG SHAPE. The file was {date, cost} — one day's total, overwritten.
 * Even written perfectly it could never answer the questions asked of it. A
 * heatmap needs per-day history. A model chart needs per-call records. A
 * streak needs continuity. So the record is per-call and append-only, and
 * every aggregate is derived on read.
 *
 * COST IS NOW A DERIVED FIELD, not the reason the record exists. That
 * matters more than it sounds: local inference has no cost and is most of
 * the traffic, so a ledger built around cost cannot describe the product's
 * actual workload at all.
 *
 * JSONL, not JSON: appending a line cannot corrupt the lines already
 * written, and a torn write costs one record instead of the file.
 *
 * Lives in the kernel because services/ai.js writes it and the activity
 * block reads it — and a block may only reach into the kernel.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_RECORDS = 50_000;

/** YYYY-MM-DD in local time — the key every day-wise consumer already uses. */
function dayKey(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function createLedger({ file, maxRecords = DEFAULT_MAX_RECORDS } = {}) {
  if (!file) throw new Error('createLedger requires a file path');

  /**
   * Persist one call.
   *
   * Never throws. Telemetry that can break inference is worse than telemetry
   * that is missing — and a failed write here must not be the reason an
   * operator's answer disappears.
   */
  function record(entry = {}) {
    try {
      const row = {
        ts: Number(entry.ts) || Date.now(),
        provider: String(entry.provider || 'unknown'),
        model: String(entry.model || 'unknown'),
        tokens: Number(entry.tokens) || 0,
        latencyMs: Number(entry.latencyMs) || 0,
        // Failures are recorded. A day of failed calls used to be
        // indistinguishable from a day nobody worked.
        success: entry.success !== false,
      };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
      _pruneIfNeeded();
      return row;
    } catch { return null; }
  }

  function read() {
    try {
      if (!fs.existsSync(file)) return [];
      const out = [];
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const s = line.trim();
        if (!s) continue;
        // A corrupt line loses one record, never the file.
        try { out.push(JSON.parse(s)); } catch { /* skip */ }
      }
      return out;
    } catch { return []; }
  }

  function _pruneIfNeeded() {
    try {
      const rows = read();
      if (rows.length <= maxRecords) return;
      const keep = rows.slice(rows.length - maxRecords);
      fs.writeFileSync(file, keep.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    } catch { /* pruning is best-effort */ }
  }

  /** Per-day history — what a heatmap and a streak need. */
  function byDay(rows = read()) {
    const out = {};
    for (const r of rows) {
      const k = dayKey(r.ts);
      if (!out[k]) out[k] = { requests: 0, tokens: 0, errors: 0, models: {} };
      out[k].requests++;
      out[k].tokens += r.tokens || 0;
      if (r.success === false) out[k].errors++;
      const m = out[k].models[r.model] || (out[k].models[r.model] = { requests: 0, tokens: 0 });
      m.requests++;
      m.tokens += r.tokens || 0;
    }
    return out;
  }

  /** Per-model breakdown — what a model chart needs. */
  function byModel(rows = read()) {
    const out = {};
    for (const r of rows) {
      const m = out[r.model] || (out[r.model] = { provider: r.provider, requests: 0, tokens: 0, errors: 0 });
      m.requests++;
      m.tokens += r.tokens || 0;
      if (r.success === false) m.errors++;
    }
    return out;
  }

  function totals(rows = read()) {
    return rows.reduce((a, r) => {
      a.requests++;
      a.tokens += r.tokens || 0;
      if (r.success === false) a.errors++;
      return a;
    }, { requests: 0, tokens: 0, errors: 0 });
  }

  /**
   * Today's spend, derived. `pricePerToken` is per provider; anything absent
   * costs nothing, which is the correct answer for local inference rather
   * than an omission.
   */
  function dailyCost({ pricePerToken = {}, day = dayKey(Date.now()) } = {}) {
    let cost = 0;
    for (const r of read()) {
      if (dayKey(r.ts) !== day) continue;
      cost += (r.tokens || 0) * (pricePerToken[r.provider] || 0);
    }
    return cost;
  }

  return { record, read, byDay, byModel, totals, dailyCost, file };
}

module.exports = { createLedger, dayKey, DEFAULT_MAX_RECORDS };
