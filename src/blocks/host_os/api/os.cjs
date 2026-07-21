const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { vaultSync } = require('../../../kernel/vaultSync.cjs');

module.exports = function createOsRouter(deps) {
  const router = express.Router();
  const {
    isVercel, WORKSPACE, ALLOWED_ROOTS, SAFE_EXEC_PREFIXES,
    writeOSAudit, requireShellAuth, LOG_FILE, INSTANT_PATTERNS
  } = deps;

  // POST /api/os/agent-shell — trusted agent-tier shell (no allowlist, full audit trail).
  // Used by VP / autonomous.cjs; authenticated via AEON_MOBILE_SECRET same as requireShellAuth.
  // Accepts cwd shortcuts: "aeon" = AEON repo root, "vault" = Vault root, "workshop" = Workshop.
  // Supports PowerShell, npm, git, node — anything the operator would run at the terminal.
  router.post('/os/agent-shell', (req, res) => {
    if (isVercel) return res.status(403).json({ error: 'Desktop Only feature' });
    const secret = process.env.AEON_MOBILE_SECRET;
    if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
      writeOSAudit('AGENT_SHELL_BLOCKED', req.body?.command || '', 401, 0, req.correlationId || 'AEON-SYS');
      return res.status(401).json({ error: 'Unauthorized: AEON_MOBILE_SECRET required.' });
    }
    const { command, cwd: cwdArg, timeout_ms } = req.body || {};
    if (!command) return res.status(400).json({ error: 'command required' });

    // Resolve cwd shortcuts → real paths. The kernel already detected the
    // install root once (storage.js walks up to AEON's package.json) and hands
    // it down as deps.WORKSPACE — reuse that single source of truth instead of
    // re-guessing depth here, so a moved/renamed folder can never desync.
    const aeonRoot = WORKSPACE
      || process.env.AEON_WORKSPACE
      || path.resolve(__dirname, '..', '..', '..', '..');
    const cwdMap = { aeon: aeonRoot, vault: WORKSPACE, workshop: path.join(WORKSPACE, 'Reading_Library', 'Workshop') };
    const workDir = cwdArg ? (cwdMap[String(cwdArg).toLowerCase()] || String(cwdArg)) : aeonRoot;

    const ms = Math.min(Math.max(Number(timeout_ms) || 60000, 5000), 300000);
    writeOSAudit('AGENT_SHELL', command, 0, 0, req.correlationId || 'AEON-SYS');
    console.log(`[AGENT-SHELL] cwd=${workDir} timeout=${ms}ms cmd=${command.slice(0, 120)}`);

    exec(command, { cwd: workDir, timeout: ms, maxBuffer: 4 * 1024 * 1024, windowsHide: false }, (err, stdout, stderr) => {
      const exitCode = err ? (err.code ?? 1) : 0;
      writeOSAudit('AGENT_SHELL_DONE', command, exitCode, (stdout || '').length + (stderr || '').length, req.correlationId || 'AEON-SYS');
      res.json({
        success: !err,
        command,
        cwd: workDir,
        stdout: (stdout || '').slice(0, 8000),
        stderr: (stderr || '').slice(0, 2000),
        exitCode,
      });
    });
  });

  // POST /api/os/shell — Terminal2 '>' shell verb. Localhost: open to operator.
  // Remote/tunnel: requires AEON_MOBILE_SECRET Bearer. Uses PowerShell on Windows
  // so the operator can run ps/dir/Get-ChildItem etc. without cmd.exe limitations.
  router.post('/os/shell', (req, res) => {
    if (isVercel) return res.status(403).json({ error: 'Desktop Only feature' });
    const ip = req.ip || '';
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!isLocal) {
      const secret = process.env.AEON_MOBILE_SECRET;
      if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
        return res.status(401).json({ error: 'Unauthorized: Bearer token required for remote shell.' });
      }
    }
    const { command, cwd: cwdArg } = req.body || {};
    if (!command) return res.status(400).json({ error: 'command required' });
    const workDir = cwdArg || WORKSPACE;
    writeOSAudit('TERMINAL_SHELL', command, 0, 0, req.correlationId || 'AEON-SYS');
    // Use PowerShell on Windows — handles Get-ChildItem, dir, ps, etc.
    // Operator types plain commands; PowerShell passes them through unmodified.
    const isWin = process.platform === 'win32';
    const fullCmd = isWin ? `powershell.exe -NoProfile -NonInteractive -Command "${command.replace(/"/g, '\\"')}"` : command;
    exec(fullCmd, { cwd: workDir, timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: false }, (err, stdout, stderr) => {
      const exitCode = err ? (err.code ?? 1) : 0;
      writeOSAudit('TERMINAL_SHELL_DONE', command, exitCode, (stdout || '').length + (stderr || '').length, req.correlationId || 'AEON-SYS');
      res.json({ success: !err, command, cwd: workDir, stdout: (stdout || '').slice(0, 8000), stderr: (stderr || '').slice(0, 2000), exitCode });
    });
  });

  // POST /api/os/execute — raw shell exec (secured)
  router.post('/os/execute', requireShellAuth, (req, res) => {
    if (isVercel) return res.status(403).json({ error: 'Desktop Only feature' });
    const { command } = req.body;
    if (!command) return res.status(400).json({ correlation_id: req.correlationId || 'AEON-SYS', error: 'Command required.' });

    console.log(`[OS-BRIDGE] Executing: ${command}`);
    if (typeof writeOSAudit === 'function') {
      writeOSAudit('OS_BRIDGE', `Executing command: ${command}`, 0, 0, req.correlationId || 'AEON-SYS');
    }

    exec(command, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
      if (error) {
        console.error("[OS-BRIDGE ERROR]", error);
        return res.status(500).json({ correlation_id: req.correlationId || 'AEON-SYS', error: error.message, stderr, stdout });
      }
      try { vaultSync('host_os', { last_command: { value: new Date().toISOString(), unit: 'timestamp', context: 'last os/execute command time' }, _summary: `OS execute: ${command.slice(0, 80)}` }); } catch(e) { /* non-critical */ }
      res.json({ success: true, stdout, stderr });
    });
  });

  // POST /api/exec — allowlisted shell exec (secured)
  router.post('/exec', requireShellAuth, (req, res) => {
    if (isVercel) return res.status(403).json({ error: 'SYSTEM: Command unavailable in Cloud environment. Please run via Local Command Center.' });
    const { command, cwd } = req.body;
    const workDir = cwd || WORKSPACE;

    const cmdLower = (command || '').toLowerCase().trim();
    const isAllowed = SAFE_EXEC_PREFIXES.some(p => cmdLower.startsWith(p));
    const hasInjection = /[&|;<>]/.test(command);

    if (!isAllowed || hasInjection) {
      writeOSAudit('EXEC_BLOCKED', command, 403, 0, req.correlationId || 'AEON-SYS');
      if (typeof global.broadcastTerminalEvent === 'function') {
        global.broadcastTerminalEvent('CRIT', `SECURITY ALERT: OS Exec Payload Blocked [${command}]`);
      }
      return res.status(403).json({ correlation_id: req.correlationId || 'AEON-SYS', error: 'Command blocked: Failed Zero-Trust Validation.' });
    }

    const timeout = /^(python|npm)/.test(cmdLower) ? 60000 : 10000;

    exec(command, { cwd: workDir, timeout, maxBuffer: 2 * 1024 * 1024, windowsHide: false }, (error, stdout, stderr) => {
      const out = stdout ? stdout.trim() : '';
      const err = stderr ? stderr.trim() : '';
      writeOSAudit('EXEC', command, error ? error.code : 0, out.length + err.length, req.correlationId || 'AEON-SYS');
      if (!error) { try { vaultSync('host_os', { last_command: { value: new Date().toISOString(), unit: 'timestamp', context: 'last allowlisted exec command time' }, _summary: `exec: ${command.slice(0, 80)}` }); } catch(e) { /* non-critical */ } }
      res.json({ success: !error, command, stdout: out, stderr: err, exitCode: error ? error.code : 0 });
    });
  });

  // POST /api/os/open — native file/app launcher (secured)
  router.post('/os/open', requireShellAuth, (req, res) => {
    if (isVercel) return res.status(403).json({ error: 'Desktop Only feature' });
    const { filePath, appHint = 'default', args = [] } = req.body;

    let resolvedPath = '';
    try {
      resolvedPath = path.resolve(filePath || '');
    } catch (e) {
      return res.status(400).json({ correlation_id: req.correlationId || 'AEON-SYS', error: 'Invalid file path.' });
    }
    const isAllowedPath = ALLOWED_ROOTS.some(root => resolvedPath.startsWith(root));
    if (!isAllowedPath) {
      writeOSAudit('OPEN_BLOCKED', resolvedPath, 403, 0, req.correlationId || 'AEON-SYS');
      return res.status(403).json({ correlation_id: req.correlationId || 'AEON-SYS', error: 'Path outside allowed workspace roots.' });
    }

    const launcherMap = {
      'vscode':   `code "${resolvedPath}"`,
      'notepad':  `notepad "${resolvedPath}"`,
      'explorer': `explorer "${resolvedPath}"`,
      'chrome':   `start chrome "${resolvedPath}"`,
      'default':  `start "" "${resolvedPath}"`
    };
    const launchCmd = launcherMap[appHint] || launcherMap['default'];
    const fullCmd = args.length > 0 ? `${launchCmd} ${args.join(' ')}` : launchCmd;

    exec(fullCmd, { cwd: WORKSPACE, timeout: 10000, windowsHide: false }, (error, stdout, stderr) => {
      writeOSAudit('OPEN', fullCmd, error ? error.code : 0, stdout.length + stderr.length, req.correlationId || 'AEON-SYS');
      if (error) {
        return res.status(500).json({ correlation_id: req.correlationId || 'AEON-SYS', success: false, error: stderr || error.message });
      }
      res.json({ success: true, launched: fullCmd, path: resolvedPath });
    });
  });

  // POST /api/os-bridge — smart command router (secured)
  router.post('/os-bridge', requireShellAuth, (req, res) => {
    if (isVercel) return res.status(403).json({ error: 'SYSTEM: Command unavailable in Cloud environment. Please run via Local Command Center.' });
    const { command } = req.body;
    const normalized = command.toLowerCase().trim();

    // NOTE: this used to shell out to tools/research_agent.py (a Python
    // "Atlas" research agent). That script — and the whole backend/ Python
    // tier it lived in — was removed when the monolith was dismantled (see
    // server.cjs "legacy entry shim" header); the path was never updated, so
    // this branch has been unconditionally failing. Deep research is now the
    // deep_research block (POST /api/research/start, SSE). Routed there
    // instead of executing a call that is guaranteed to fail.
    if (normalized.startsWith('research')) {
      return res.json({
        status: 'redirect',
        message: 'Deep research now lives in the Deep Research block — use /research or POST /api/research/start instead of /os-bridge.'
      });
    }

    for (const pattern of INSTANT_PATTERNS) {
      const match = command.match(pattern.match);
      if (match) {
        const { cmd, msg } = pattern.handler(match);

        exec(cmd, { cwd: WORKSPACE }, (error, stdout, stderr) => {
          const chatMsg = {
            id: Date.now(),
            sender: 'qwen',
            name: 'Qwen (OS Exec)',
            content: error
              ? `[Action: OS Bridge] ❌ Failed: \`${cmd}\`\n${stderr || error.message}`
              : `[Action: OS Bridge] ✅ Executed: \`${cmd}\`${stdout ? '\n' + stdout.substring(0, 500) : ''}`,
            time: new Date().toLocaleTimeString(),
            color: error ? '#ff4466' : '#00f2ff'
          };
          const data = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
          data.push(chatMsg);
          fs.writeFileSync(LOG_FILE, JSON.stringify(data, null, 2));
        });

        return res.json({ status: 'success', message: msg });
      }
    }

    return res.json({
      status: 'routed',
      message: `Command queued for AI processing: "${command}". The Autopilot Daemon will route this to Zenith/Qwen.`
    });
  });

  return router;
};
