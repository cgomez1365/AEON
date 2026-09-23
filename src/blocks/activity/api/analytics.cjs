module.exports = (deps) => {
  const express = require('express');
  const router = express.Router();
  const fs = require('fs');
  const path = require('path');

  const {
    supabase,
    AUDIT_FILE, TOKEN_LEDGER_FILE,
    GEMINI_PRICE_PER_TOKEN, GROQ_PRICE_PER_TOKEN,
    validateSDI
  } = deps;
  // Retired 2026-09-23 (Bible §21; tests/activity-retired-routes.test.js):
  // POST /api/activity/search, GET /api/telemetry/live, GET /api/pipeline-metrics.
  // No caller anywhere; each was broken on a running install (see the test).

  // GET /api/telemetry — all-time usage per provider, from the call ledger.
  //
  // The kernel's live counters (/api/llm-telemetry) are in memory and reset on
  // restart; TelemetryContext falls back to this route whenever they read
  // zero, i.e. after every restart. It used to count chat-log MESSAGES —
  // `Number(msg.tokens) || 150` — so a fresh install with no LLM call at all
  // reported 1 request / 150 tokens for "aeon_cortex", the seeded
  // "SYSTEM INITIALIZED" line (measured 2026-09-23).
  // A trusted meter never fakes data: this reads the per-call ledger every
  // other surface reads, and a blank ledger is a blank answer.
  router.get('/telemetry', async (req, res) => {
    try {
      let rows = [];
      let dailyCost = 0;
      if (TOKEN_LEDGER_FILE) {
        const { createLedger } = require('../../../kernel/llm-ledger.cjs');
        const ledger = createLedger({ file: path.join(path.dirname(TOKEN_LEDGER_FILE), 'llm_calls.jsonl') });
        rows = ledger.read();
        dailyCost = typeof deps.getDailyCost === 'function'
          ? Number(deps.getDailyCost()) || 0
          : ledger.dailyCost({ pricePerToken: { gemini: GEMINI_PRICE_PER_TOKEN, groq: GROQ_PRICE_PER_TOKEN, local: 0 } });
      }

      const staffUsage = {};
      let totalTokens = 0;
      for (const r of rows) {
        const key = String(r.provider || 'unknown');
        const s = staffUsage[key] || (staffUsage[key] = { requests: 0, tokens: 0, errors: 0 });
        s.requests++;
        s.tokens += Number(r.tokens) || 0;
        if (r.success === false) s.errors++;
        totalTokens += Number(r.tokens) || 0;
      }

      res.json({
        totalTokens,
        totalRequests: rows.length,
        // Today's spend, derived the kernel's way — not an all-time figure.
        totalCost: dailyCost,
        costScope: 'today',
        staffUsage,
      });
    } catch (error) {
      console.error('Error reading telemetry:', error);
      res.status(500).json({ error: 'Failed to read telemetry data' });
    }
  });

  router.get('/audit', async (req, res) => {
    try {
      if (supabase) {
        const { data, error } = await supabase.from('aeon_audit_log').select('*').order('timestamp', { ascending: false }).limit(200);
        if (!error && data) {
          const auditLog = data.reverse();
          fs.writeFileSync(AUDIT_FILE, JSON.stringify(auditLog, null, 2), 'utf8');
          return res.json(auditLog);
        }
      }
    } catch (e) {
      console.error('[AEON] Supabase audit sync failed:', e.message);
    }

    try {
      if (!fs.existsSync(AUDIT_FILE)) fs.writeFileSync(AUDIT_FILE, JSON.stringify([], null, 2));
      const data = fs.readFileSync(AUDIT_FILE, 'utf8');
      res.json(JSON.parse(data));
    } catch (error) {
      res.status(500).json({ correlation_id: req.correlationId, error: 'Failed to read audit log' });
    }
  });

  router.post('/audit', (req, res) => {
    const sdiCheck = validateSDI('audit', req.body);
    if (!sdiCheck.valid) return res.status(400).json({ correlation_id: req.correlationId, error: 'SDI Validation Failed', errors: sdiCheck.errors });
    try {
      const { agent, action, details } = req.body;
      const newEntry = {
        id: `audit_${Date.now()}`,
        agent: agent || 'SYSTEM',
        action: action || 'UNKNOWN',
        details: details || '',
        status_code: 200,
        telemetry_tokens: 0,
        timestamp: new Date().toISOString()
      };

      if (supabase) {
        supabase.from('aeon_audit_log').insert([newEntry]).then();
      }

      if (!fs.existsSync(AUDIT_FILE)) {
        fs.writeFileSync(AUDIT_FILE, JSON.stringify([], null, 2));
      }
      const data = fs.readFileSync(AUDIT_FILE, 'utf8');
      const audit = JSON.parse(data);
      audit.push(newEntry);
      if (audit.length > 50) audit.shift();
      fs.writeFileSync(AUDIT_FILE, JSON.stringify(audit, null, 2));
      res.json(newEntry);
    } catch (error) {
      res.status(500).json({ correlation_id: req.correlationId, error: 'Failed to write audit log' });
    }
  });

  return router;
};
