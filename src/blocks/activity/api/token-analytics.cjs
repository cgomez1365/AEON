// routes/token-analytics.js — Daily activity tracking for GitHub-style heatmap
// Aggregates audit + chat logs into per-day token/request counts.
const express = require('express');
const fs = require('fs');
const path = require('path');

module.exports = function createTokenAnalyticsRouter(deps) {
  const router = express.Router();
  const { getLocalFile, getDataFile, AUDIT_FILE, LOG_FILE, TOKEN_LEDGER_FILE } = deps;

  // Manifest declares filesystem:'none' but this ran an unguarded mkdirSync
  // at module-load time regardless — on Vercel (read-only FS) that throws
  // synchronously on cold start, which can take down the whole bundled
  // function. getDataFile() redirects to /tmp on Vercel automatically.
  const ACTIVITY_FILE = getDataFile
    ? getDataFile('activity/activity_heatmap.json')
    : require('path').join(__dirname, '../db/activity_heatmap.json');
  const ACTIVITY_DIR  = require('path').dirname(ACTIVITY_FILE);
  try { if (!fs.existsSync(ACTIVITY_DIR)) fs.mkdirSync(ACTIVITY_DIR, { recursive: true }); } catch {}

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

  function getLocalDateString(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function today() {
    return getLocalDateString();
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

  // GET /token-analytics/heatmap — 365-day activity data for heatmap
  router.get('/token-analytics/heatmap', (req, res) => {
    const data = readActivity();
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - 364);

    const days = [];
    const cursor = new Date(start);
    while (cursor <= end) {
      const key = getLocalDateString(cursor);
      const entry = data[key] || { requests: 0, tokens: 0 };
      days.push({
        date: key,
        requests: entry.requests,
        tokens: entry.tokens,
        weekday: cursor.getDay(),
      });
      cursor.setDate(cursor.getDate() + 1);
    }

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
    const data = readActivity();
    const allDays = Object.keys(data).sort();

    let totalRequests = 0;
    let totalTokens = 0;
    let activeDays = 0;
    const modelTotals = {};
    const last30 = {};
    const last7 = {};
    const now = new Date();

    for (const [day, entry] of Object.entries(data)) {
      totalRequests += entry.requests;
      totalTokens += entry.tokens;
      if (entry.requests > 0) activeDays++;
      for (const [model, m] of Object.entries(entry.models || {})) {
        if (!modelTotals[model]) modelTotals[model] = { requests: 0, tokens: 0 };
        modelTotals[model].requests += m.requests;
        modelTotals[model].tokens += m.tokens;
      }
      const dayDate = new Date(day + 'T00:00:00');
      const diffDays = Math.floor((now - dayDate) / (1000 * 60 * 60 * 24));
      if (diffDays < 30) {
        last30[day] = entry;
      }
      if (diffDays < 7) {
        last7[day] = entry;
      }
    }

    const last7Requests = Object.values(last7).reduce((s, e) => s + e.requests, 0);
    const last30Requests = Object.values(last30).reduce((s, e) => s + e.requests, 0);
    const last7Tokens = Object.values(last7).reduce((s, e) => s + e.tokens, 0);
    const last30Tokens = Object.values(last30).reduce((s, e) => s + e.tokens, 0);

    const modelBreakdown = Object.entries(modelTotals)
      .map(([name, m]) => ({ name, ...m }))
      .sort((a, b) => b.requests - a.requests);

    // Streak calculation
    let currentStreak = 0;
    let longestStreak = 0;
    let streak = 0;
    const checkDate = new Date(now);
    for (let i = 0; i < 365; i++) {
      const key = getLocalDateString(checkDate);
      if (data[key] && data[key].requests > 0) {
        streak++;
        if (i === 0 || streak > 0) currentStreak = streak;
      } else {
        if (i === 0) currentStreak = 0;
        streak = 0;
      }
      if (streak > longestStreak) longestStreak = streak;
      checkDate.setDate(checkDate.getDate() - 1);
    }

    // Also fold in existing audit/chat logs for a richer first-time experience
    let auditCount = 0;
    let chatCount = 0;
    try {
      if (AUDIT_FILE && fs.existsSync(AUDIT_FILE)) {
        auditCount = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8')).length;
      }
    } catch {}
    try {
      if (LOG_FILE && fs.existsSync(LOG_FILE)) {
        chatCount = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')).length;
      }
    } catch {}

    // D2g — read the per-call ledger, not the {date, cost} file that the
    // live code paths never created. Cost is derived from the same records
    // every other aggregate comes from, so the panels cannot disagree.
    let tokenLedgerCost = 0;
    try {
      if (TOKEN_LEDGER_FILE) {
        const { createLedger } = require('../../../kernel/llm-ledger.cjs');
        const led = createLedger({ file: path.join(path.dirname(TOKEN_LEDGER_FILE), 'llm_calls.jsonl') });
        tokenLedgerCost = led.dailyCost({
          pricePerToken: { gemini: 0.00000015, groq: 0.00000060, local: 0 },
        });
      }
    } catch {}

    res.json({
      totalRequests: totalRequests || chatCount || auditCount,
      totalTokens,
      activeDays,
      currentStreak,
      longestStreak,
      last7: { requests: last7Requests, tokens: last7Tokens },
      last30: { requests: last30Requests, tokens: last30Tokens },
      modelBreakdown,
      dailyCost: tokenLedgerCost,
      firstDay: allDays[0] || today(),
    });
  });

  // Internal hook — called directly by server.cjs on every LLM call (not HTTP)
  router._recordActivity = recordActivity;

  // GET /token-analytics/daily/:date — detailed breakdown for a single day
  router.get('/token-analytics/daily/:date', (req, res) => {
    const data = readActivity();
    const entry = data[req.params.date];
    if (!entry) return res.json({ date: req.params.date, requests: 0, tokens: 0, models: {} });
    res.json({ date: req.params.date, ...entry });
  });

  // Expose recordActivity for other routes to call internally
  router._recordActivity = recordActivity;

  return router;
};
