const express = require('express');
const fs = require('fs');
const path = require('path');

module.exports = function createSystemRouter(deps) {
  const router = express.Router();
  const {
    requireShellAuth, supabase, isVercel,
    LOG_FILE, AUDIT_FILE, NOTES_FILE, TERMINAL_HISTORY_FILE,
    SDI_SCHEMAS, validateSDI, SDI_VIOLATION_LOG,
    getLocalFile, runReaper
  } = deps;

  // SDI: View all violations
  router.get('/sdi/violations', (req, res) => {
    if (!fs.existsSync(SDI_VIOLATION_LOG)) return res.json([]);
    try {
      res.json(JSON.parse(fs.readFileSync(SDI_VIOLATION_LOG, 'utf8')));
    } catch { res.json([]); }
  });

  // SDI: Validate a payload against a named schema
  router.post('/sdi/validate', (req, res) => {
    const { schema, payload } = req.body;
    if (!schema || !payload) return res.status(400).json({ correlation_id: req.correlationId || 'AEON-SYS', error: 'schema and payload required.' });
    const result = validateSDI(schema, payload);
    res.json(result);
  });

  // SDI: List all registered schemas
  router.get('/sdi/schemas', (req, res) => {
    const summary = {};
    for (const [name, schema] of Object.entries(SDI_SCHEMAS)) {
      summary[name] = { required: schema.required, fields: Object.keys(schema.fields) };
    }
    res.json(summary);
  });

  // GAS status stub (silences frontend polling)
  router.get('/gas/status', (req, res) => {
    res.json({ configured: false });
  });

  // Health check
  router.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      environment: isVercel ? 'vercel' : 'local',
      time: new Date().toISOString(),
      uptime: process.uptime()
    });
  });

  // Desktop task queue
  let desktopTasks = [];

  router.get('/desktop-tasks', (req, res) => {
    res.json(desktopTasks);
    desktopTasks = [];
  });

  router.post('/desktop-tasks', requireShellAuth, (req, res) => {
    const { command } = req.body;
    if (command) {
      desktopTasks.push(command);
      res.json({ success: true, message: 'Task queued.' });
    } else {
      res.status(400).json({ correlation_id: req.correlationId || 'AEON-SYS', error: 'Command missing.' });
    }
  });

  // Force sync to Supabase
  router.post('/force-sync', async (req, res) => {
    if (!supabase || isVercel) return res.json({ success: false, reason: 'ignored' });
    try {
      if (fs.existsSync(LOG_FILE)) {
        const chatData = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
        await supabase.from('aeon_chat_log').upsert(chatData.slice(-50));
      }
      if (fs.existsSync(AUDIT_FILE)) {
        const auditData = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
        await supabase.from('aeon_audit_log').upsert(auditData.slice(-50));
      }
      res.json({ success: true });
    } catch (e) {
      console.error('[AEON] Force sync failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // System restart
  router.post('/system/restart', requireShellAuth, (req, res) => {
    if (isVercel) return res.json({ success: false, message: 'SYSTEM: Command unavailable in Cloud environment. Please run via Local Command Center.' });
    console.log('[AEON SYSTEM] FULL RESTART INITIATED BY CEO');
    res.json({ success: true, message: 'Restarting AEON Command Center...' });
    const { spawn } = require('child_process');
    // NOTE: restart.bat moved to scripts/ during the repo reorg (BUILD_LOG.md
    // 2026-07 entry). __dirname is src/blocks/host_os/api, so this walks up to
    // the repo root before descending into scripts/.
    const restartScript = path.join(__dirname, '..', '..', '..', '..', 'scripts', 'restart.bat');
    // aeon-shell-allow: launching a .bat requires cmd.exe; restartScript is a
    // server-side path.join constant, never request-derived.
    const child = spawn('cmd.exe', ['/c', restartScript], {
      detached: true, stdio: 'ignore', windowsHide: false
    });
    child.on('error', (e) => console.error('[AEON SYSTEM] restart.bat spawn failed:', e.message));
    child.unref();
    setTimeout(() => process.exit(0), 500);
  });

  // System scan & sync
  router.post('/system/scan', requireShellAuth, async (req, res) => {
    try {
      let logs = [];
      if (supabase) {
        const { data, error } = await supabase.from('aeon_notes').select('*').order('updated_at', { ascending: false });
        if (!error && data) {
          if (!isVercel) fs.writeFileSync(NOTES_FILE, JSON.stringify(data, null, 2), 'utf-8');
          logs.push('✔ Supabase notes merged.');
        }
      }
      if (supabase) {
        const { data, error } = await supabase.from('aeon_terminal_history').select('*').order('created_at', { ascending: false }).limit(50);
        if (!error && data) {
          if (!isVercel) fs.writeFileSync(TERMINAL_HISTORY_FILE, JSON.stringify(data.reverse(), null, 2), 'utf-8');
          logs.push('✔ Supabase terminal history merged.');
        }
      }
      if (isVercel) {
        logs.push('⚠ Local filesystem scan skipped (Cloud environment).');
        return res.json({ success: true, logs });
      }
      // NOTE: this used to spawn tools/index-brain.js directly, but that script
      // was archived when Second Brain indexing moved into the aeon_matrix block
      // (POST /api/crn/second-brain/ingest/scan-docs, SSE). server/server.js now
      // runs an incremental Second Brain sync on every boot automatically, so a
      // manual full reindex is rarely needed — trigger one from the Neural
      // Terminal's /index-brain command (aeon_matrix-owned) if a hard rescan is
      // required. Kept as a no-op log line rather than silently deleting the step.
      logs.push('ℹ Matrix indexing is handled by aeon_matrix (boot auto-sync + /index-brain) — skipped here.');
      // Auto-push all blocks to Supabase after scan
      if (supabase && !isVercel) {
        try {
          const syncRes = await new Promise((resolve) => {
            const http = require('http');
            const selfPort = Number(process.env.PORT) || 3001;
            const req = http.request({ hostname: 'localhost', port: selfPort, path: '/api/sync/bulk-push', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (r) => {
              let body = '';
              r.on('data', c => body += c);
              r.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
            });
            req.on('error', () => resolve(null));
            req.end('{}');
          });
          if (syncRes?.success) {
            const pushed = Object.values(syncRes.results || {}).filter(r => r.pushed).length;
            logs.push(`✔ ${pushed} blocks synced to Supabase.`);
          }
        } catch (e) {
          logs.push('⚠ Supabase bulk-push failed: ' + e.message);
        }
      }

      res.json({ success: true, logs });
    } catch (e) {
      console.error('[AEON] Scan error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  // [MOVED] Second Brain graph → now owned by the self-contained
  // second_brain block at /block/second_brain/crn/second-brain/graph.

  return router;
};
