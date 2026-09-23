const express = require('express');
const fs = require('fs');
const path = require('path');
const { requireOperator } = require('../../../kernel/server-utils/requireOperator.cjs');
const capabilities = require('../../../kernel/capabilities.cjs');

module.exports = function createSystemRouter(deps) {
  const router = express.Router();
  const {
    requireShellAuth, supabase, isVercel,
    LOG_FILE, AUDIT_FILE, NOTES_FILE, TERMINAL_HISTORY_FILE,
    SDI_SCHEMAS, validateSDI, SDI_VIOLATION_LOG,
    getLocalFile, getDataFile, runReaper
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

  // ── Restart: only when something will bring AEON back ─────────────
  //
  // Measured 2026-09-23 on macOS: this answered { success: true, "Restarting
  // AEON Command Center..." }, spawned `cmd.exe /c scripts/restart.bat` — a
  // Windows binary, and a script that exists on NO platform since the repo
  // reorg — and exited 500 ms later. launch.js exits when its server child
  // exits, so nothing relaunched AEON: the header RESTART button told the
  // operator it was restarting and left a dead app. settings' /restart already
  // refuses in this case (BO-SHIP P8f); this route now applies the same rule.
  //
  // A relauncher must be PROVEN present before the process is allowed to die:
  // restart.bat on Windows (it is cmd.exe-only), or a supervisor that restarts
  // on exit (the same env signals settings reads).
  const RESTART_SCRIPT = path.join(__dirname, '..', '..', '..', '..', 'scripts', 'restart.bat');
  function restartCapability() {
    if (isVercel) {
      return { canRestart: false, reason: 'AEON in the cloud is restarted by its host, not from inside the app.', remedy: 'Redeploy from your hosting dashboard.' };
    }
    if (process.platform === 'win32' && fs.existsSync(RESTART_SCRIPT)) return { canRestart: true, via: 'restart.bat' };
    const supervisor = ['AEON_SUPERVISED', 'PM2_HOME', 'NODEMON'].find((k) => process.env[k]);
    if (supervisor) return { canRestart: true, via: 'supervisor', signal: supervisor };
    return {
      canRestart: false,
      reason: 'AEON cannot restart itself in this launch mode — nothing would bring it back up.',
      remedy: 'Stop AEON and start it again with your launcher (LAUNCH.bat, launch.command, launch.sh, or npm start).',
      detail: 'A restart needs scripts/restart.bat on Windows, or a supervisor that relaunches AEON when it exits (AEON_SUPERVISED, pm2, nodemon).',
    };
  }

  router.post('/system/restart', requireShellAuth, (req, res) => {
    const cap = restartCapability();
    if (!cap.canRestart) {
      return res.status(501).json({ ok: false, success: false, restarting: false, error: cap.reason, remedy: cap.remedy, detail: cap.detail });
    }
    console.log(`[AEON SYSTEM] Restart requested by the operator — relaunch via ${cap.via}.`);
    res.json({ ok: true, success: true, restarting: true, via: cap.via, message: `Restarting AEON (relaunched by ${cap.via}).` });
    setTimeout(() => {
      try {
        if (cap.via === 'restart.bat') {
          const { spawn } = require('child_process');
          // aeon-shell-allow: launching a .bat requires cmd.exe; RESTART_SCRIPT
          // is a server-side path.join constant, never request-derived.
          const child = spawn('cmd.exe', ['/c', RESTART_SCRIPT], { detached: true, stdio: 'ignore', windowsHide: false });
          child.on('error', (e) => console.error('[AEON SYSTEM] restart.bat spawn failed:', e.message));
          child.unref();
        }
      } finally { process.exit(0); }
    }, 500);
  });

  // ── GET /api/system/health — this machine and this AEON, in one read ──
  //
  // /api/health above is a liveness ping (the header polls it). This is what
  // the Host screen shows: the machine (CPU, memory, load, disk), the AEON
  // process (pid, uptime, memory, Node), and whether Restart can work here —
  // so a Restart control can be offered or explained, never faked.
  // requireOperator: a read of machine facts, same gate as the audit screen.
  router.get('/system/health', requireOperator({ name: 'Host health' }), (req, res) => {
    const os = require('os');
    const gb = (b) => Math.round((b / 1024 ** 3) * 10) / 10;
    const mb = (b) => Math.round(b / 1024 ** 2);
    const mem = process.memoryUsage();
    let disk = null;
    try {
      const where = deps.VAULT_ROOT || (getDataFile ? getDataFile('host_os') : process.cwd());
      let probe = where;
      while (probe && !fs.existsSync(probe)) probe = path.dirname(probe);
      if (typeof fs.statfsSync === 'function' && probe) {
        const st = fs.statfsSync(probe);
        disk = { path: probe, freeGb: gb(st.bavail * st.bsize), totalGb: gb(st.blocks * st.bsize) };
      }
    } catch (e) { disk = { error: e.message }; }
    const cpus = os.cpus() || [];
    res.json({
      ok: true,
      checkedAt: new Date().toISOString(),
      machine: {
        hostname: os.hostname(),
        platform: process.platform,
        arch: os.arch(),
        osRelease: os.release(),
        cpuModel: cpus[0] ? cpus[0].model : null,
        cpuThreads: cpus.length,
        // Windows has no load average; os.loadavg() returns zeros there.
        loadAvg: process.platform === 'win32' ? null : os.loadavg().map((n) => Math.round(n * 100) / 100),
        uptimeSec: Math.round(os.uptime()),
        totalMemGb: gb(os.totalmem()),
        freeMemGb: gb(os.freemem()),
        ...(process.platform === 'darwin' ? { freeMemNote: 'macOS keeps unused memory as cache and counts it as used, so "free" reads far lower than what applications can actually get. Low free memory here is normal.' } : {}),
      },
      disk,
      aeon: {
        pid: process.pid,
        uptimeSec: Math.round(process.uptime()),
        node: process.version,
        rssMb: mb(mem.rss),
        heapUsedMb: mb(mem.heapUsed),
      },
      restart: restartCapability(),
    });
  });

  // System scan & sync
  //
  // BO-D2b — requireOperator, not requireShellAuth. This is the route the
  // finding was written about: the operator typed /scan and was told
  // "OS endpoints disabled: sign in". It pulls Supabase notes and terminal
  // history down to disk and pushes blocks back up. There is no shell here,
  // and never was — it inherited the execution gate from the block it lives
  // in rather than from anything it does.
  router.post('/system/scan', requireOperator({ name: 'System scan' }), async (req, res) => {
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
      // Auto-push all blocks to Supabase after scan.
      //
      // Settings → System → "Auto-sync to cloud" governs this. The toggle was
      // read by nothing, so an operator who switched it off — the operator
      // most likely to care, since the objection to cloud sync is usually
      // privacy — still had every block pushed to Supabase on the next scan.
      // A manual /push is unaffected: that is an explicit instruction, not
      // automatic sync.
      if (supabase && !isVercel) {
        if (!capabilities.enabled('auto_sync')) {
          logs.push('ℹ Cloud sync skipped — "Auto-sync to cloud" is off in Settings → System.');
        } else try {
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
