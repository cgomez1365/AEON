// routes/token-analytics.js — Daily activity for the heatmap, streaks and
// model breakdown.
//
// SOURCE OF TRUTH: the kernel's per-call ledger (<db>/llm_calls.jsonl, written
// by services/ai.js at the one seam every provider crosses). Counts used to
// come from activity_heatmap.json while cost came from the ledger — two
// sources that parted ways whenever the heatmap recorder was not attached
// (Settings → telemetry off records the ledger only; server.js's direct mount
// can fail). The heatmap file is still written, and still read for history
// that predates the ledger (see _ledgerView.mergeDays).
const express = require('express');
const fs = require('fs');
const path = require('path');
const view = require('./_ledgerView.cjs');

// List prices the kernel uses for its own spend derivation (services/ai.js
// PRICE_PER_TOKEN). Only used when the kernel's getDailyCost is not handed in
// — server.js's direct mount of this file does not pass it.
const PRICE_PER_TOKEN = { gemini: 0.00000015, groq: 0.00000060, local: 0 };

module.exports = function createTokenAnalyticsRouter(deps) {
  const router = express.Router();
  const { getDataFile, TOKEN_LEDGER_FILE } = deps;

  // Manifest declares filesystem:'none' but this ran an unguarded mkdirSync
  // at module-load time regardless — on Vercel (read-only FS) that throws
  // synchronously on cold start, which can take down the whole bundled
  // function. getDataFile() redirects to /tmp on Vercel automatically.
  const ACTIVITY_FILE = getDataFile
    ? getDataFile('activity/activity_heatmap.json')
    : require('path').join(__dirname, '../db/activity_heatmap.json');
  const ACTIVITY_DIR  = require('path').dirname(ACTIVITY_FILE);
  try { if (!fs.existsSync(ACTIVITY_DIR)) fs.mkdirSync(ACTIVITY_DIR, { recursive: true }); } catch {}

  // The ledger sits beside TOKEN_LEDGER_FILE — the exact path services/ai.js
  // writes (path.join(path.dirname(TOKEN_LEDGER_FILE), 'llm_calls.jsonl')).
  const ledger = (() => {
    if (!TOKEN_LEDGER_FILE) return null;
    try {
      const { createLedger } = require('../../../kernel/llm-ledger.cjs');
      return createLedger({ file: path.join(path.dirname(TOKEN_LEDGER_FILE), 'llm_calls.jsonl') });
    } catch { return null; }
  })();

  function readActivity() {
    if (!fs.existsSync(ACTIVITY_FILE)) return {};
    try { return JSON.parse(fs.readFileSync(ACTIVITY_FILE, 'utf8')); } catch { return {}; }
  }

  function writeActivity(data) {
    try {
      if (!fs.existsSync(ACTIVITY_DIR)) fs.mkdirSync(ACTIVITY_DIR, { recursive: true });
      fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch {}
  }

  /** Ledger rows + the merged day map every route reads. */
  function snapshot() {
    const rows = ledger ? ledger.read() : [];
    const ledgerDays = ledger ? ledger.byDay(rows) : {};
    const { days, firstLedgerDay } = view.mergeDays(ledgerDays, readActivity());
    return { rows, days, firstLedgerDay };
  }

  function today() {
    return view.dayKey(new Date());
  }

  // D2g — `meta` carries the outcome. Without it a day of failed calls was
  // indistinguishable from a day nobody worked, because only the request
  // count and token total were ever kept.
  function recordActivity(tokens = 0, model = '', engine = '', meta = {}) {
    const day = today();
    const data = readActivity();
    if (!data[day]) data[day] = { requests: 0, tokens: 0, models: {} };
    data[day].requests++;
    data[day].tokens += tokens;
    if (meta.success === false) data[day].errors = (data[day].errors || 0) + 1;
    if (model) {
      if (!data[day].models[model]) data[day].models[model] = { requests: 0, tokens: 0 };
      data[day].models[model].requests++;
      data[day].models[model].tokens += tokens;
    }
    const keys = Object.keys(data).sort();
    if (keys.length > 400) {
      for (const k of keys.slice(0, keys.length - 365)) delete data[k];
    }
    writeActivity(data);
  }

  // POST /token-analytics/record — called by other routes after LLM calls
  router.post('/token-analytics/record', (req, res) => {
    const { tokens = 0, model = '', engine = '' } = req.body;
    recordActivity(tokens, model, engine);
    res.json({ ok: true });
  });

  // GET /token-analytics/heatmap — 365 calendar days ending today
  router.get('/token-analytics/heatmap', (req, res) => {
    const { days: data } = snapshot();
    const days = view.lastNDayKeys(365).map((key) => {
      const e = data[key] || {};
      return {
        date: key,
        requests: e.requests || 0,
        tokens: e.tokens || 0,
        errors: e.errors || 0,
        weekday: view.weekdayOf(key),
      };
    });

    let maxRequests = 0;
    let totalRequests = 0;
    let totalTokens = 0;
    let activeDays = 0;
    for (const d of days) {
      if (d.requests > maxRequests) maxRequests = d.requests;
      totalRequests += d.requests;
      totalTokens += d.tokens;
      if (d.requests > 0) activeDays++;
    }

    res.json({ days, maxRequests, totalRequests, totalTokens, activeDays });
  });

  // GET /token-analytics/summary — aggregate stats
  router.get('/token-analytics/summary', (req, res) => {
    const { rows, days, firstLedgerDay } = snapshot();
    const now = new Date();
    const allDays = Object.keys(days).sort();

    let totalRequests = 0;
    let totalTokens = 0;
    let errors = 0;
    let activeDays = 0;
    for (const e of Object.values(days)) {
      totalRequests += e.requests || 0;
      totalTokens += e.tokens || 0;
      errors += e.errors || 0;
      if (e.requests > 0) activeDays++;
    }

    // Per-model: every ledger call, plus the per-day model counts of legacy
    // days that predate the ledger. Provider, failures and latency are only
    // known for ledger calls.
    const models = {};
    const bump = (name) => (models[name] || (models[name] = { name, provider: null, requests: 0, tokens: 0, errors: 0, latencyMs: 0, timed: 0 }));
    for (const r of rows) {
      const m = bump(r.model || 'unknown');
      m.provider = m.provider || r.provider || null;
      m.requests++;
      m.tokens += r.tokens || 0;
      if (r.success === false) m.errors++;
      if (r.latencyMs > 0) { m.latencyMs += r.latencyMs; m.timed++; }
    }
    for (const [day, e] of Object.entries(days)) {
      if (firstLedgerDay && day >= firstLedgerDay) continue;
      for (const [name, v] of Object.entries(e.models || {})) {
        const m = bump(name);
        m.requests += v.requests || 0;
        m.tokens += v.tokens || 0;
      }
    }
    const modelBreakdown = Object.values(models)
      .map(({ latencyMs, timed, ...m }) => ({ ...m, avgLatency: timed ? Math.round(latencyMs / timed) : null }))
      .sort((a, b) => b.requests - a.requests);

    const { current: currentStreak, longest: longestStreak } = view.streaks(days, now);

    // Today's spend. The kernel's own derivation when it is handed in — the
    // same number its cost guard reads — else the same formula over the
    // same ledger. Providers without a list price (local, custom, openrouter)
    // count as $0, which the UI must say rather than imply they are free.
    let dailyCost = 0;
    try {
      if (typeof deps.getDailyCost === 'function') dailyCost = Number(deps.getDailyCost()) || 0;
      else if (ledger) dailyCost = ledger.dailyCost({ pricePerToken: PRICE_PER_TOKEN });
    } catch {}

    res.json({
      totalRequests,
      totalTokens,
      errors,
      activeDays,
      currentStreak,
      longestStreak,
      today: view.windowTotals(days, 1, now),
      last7: view.windowTotals(days, 7, now),
      last30: view.windowTotals(days, 30, now),
      last90: view.windowTotals(days, 90, now),
      modelBreakdown,
      dailyCost,
      pricedProviders: Object.keys(PRICE_PER_TOKEN).filter(p => PRICE_PER_TOKEN[p] > 0),
      firstDay: allDays[0] || today(),
      source: { ledger: !!ledger, ledgerCalls: rows.length, firstLedgerDay },
    });
  });

  // GET /token-analytics/calls — the newest ledger records, failures with the
  // HTTP status and error the kernel kept. `?failed=1` for failures only.
  router.get('/token-analytics/calls', (req, res) => {
    const limit = Math.max(1, Math.min(Number(req.query?.limit) || 20, 200));
    const failedOnly = req.query?.failed === '1' || req.query?.failed === 'true';
    const rows = ledger ? ledger.read() : [];
    const out = [];
    for (let i = rows.length - 1; i >= 0 && out.length < limit; i--) {
      const r = rows[i];
      if (failedOnly && r.success !== false) continue;
      out.push({
        ts: r.ts, provider: r.provider, model: r.model, tokens: r.tokens || 0,
        latencyMs: r.latencyMs || 0, success: r.success !== false,
        status: r.status ?? null, error: r.error ?? null,
      });
    }
    res.json({ calls: out, ledger: !!ledger });
  });

  // GET /token-analytics/daily/:date — detailed breakdown for a single day
  router.get('/token-analytics/daily/:date', (req, res) => {
    const { days } = snapshot();
    const entry = days[req.params.date];
    if (!entry) return res.json({ date: req.params.date, requests: 0, tokens: 0, errors: 0, models: {} });
    res.json({ date: req.params.date, errors: 0, ...entry });
  });

  // Internal hook — called directly by server.cjs on every LLM call (not HTTP)
  router._recordActivity = recordActivity;

  return router;
};
