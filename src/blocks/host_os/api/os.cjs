const express = require('express');
const { execFile } = require('child_process');
const path = require('path');
const { vaultSync } = require('../../../kernel/vaultSync.cjs');
const { isInside } = require('../../../kernel/pathContainment.cjs');

// ─────────────────────────────────────────────────────────────────────────────
// This block used to expose six routes that ran a client-supplied string through
// a shell: /os/agent-shell (self-described "no allowlist"), /os/shell (arbitrary
// PowerShell), /os/execute (bypassed the allowlist that guarded /exec),
// /os-bridge (interpolated unescaped regex captures into a command), plus /exec
// and /os/open. Four are deleted. What remains never builds a command string:
// every operation names a fixed executable and passes an argument ARRAY, which
// removes the injection class structurally instead of filtering for it.
//
// Raw shell is not a product feature. The operator has a terminal.
// ─────────────────────────────────────────────────────────────────────────────

module.exports = function createOsRouter(deps) {
  const router = express.Router();
  const {
    isVercel, WORKSPACE, ALLOWED_ROOTS, writeOSAudit, requireShellAuth,
  } = deps;

  /** Every OS action is a named operation with a fixed executable. */
  const ACTIONS = {
    // id: { file, args(params) -> string[], timeout, describe(params) }
    getStatus: {
      file: process.platform === 'win32' ? 'cmd.exe' : 'uname',
      args: () => (process.platform === 'win32' ? ['/c', 'ver'] : ['-a']),
      timeout: 10000,
      describe: () => 'read host OS version',
    },
    runTest: {
      file: process.platform === 'win32' ? 'npm.cmd' : 'npm',
      args: () => ['test', '--silent'],
      timeout: 300000,
      describe: () => 'run the test suite',
      cwd: () => WORKSPACE,
    },
  };

  // POST /api/os/action — the only execution entry point.
  router.post('/os/action', requireShellAuth, (req, res) => {
    if (isVercel) return res.status(403).json({ error: 'Desktop Only feature' });
    const { action, params = {} } = req.body || {};
    const spec = ACTIONS[action];
    if (!spec) {
      writeOSAudit('OS_ACTION_REJECTED', String(action), 400, 0, req.correlationId || 'AEON-SYS');
      return res.status(400).json({
        error: `Unknown action "${action}".`,
        validActions: Object.keys(ACTIONS),
      });
    }

    let args;
    try {
      args = spec.args(params);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    const cwd = spec.cwd ? spec.cwd(params) : WORKSPACE;
    writeOSAudit('OS_ACTION', `${action}: ${spec.describe(params)}`, 0, 0, req.correlationId || 'AEON-SYS');

    execFile(spec.file, args, { cwd, timeout: spec.timeout, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const out = (stdout || '').trim();
        const err = (stderr || '').trim();
        writeOSAudit('OS_ACTION_DONE', action, error ? (error.code ?? 1) : 0, out.length + err.length, req.correlationId || 'AEON-SYS');
        if (!error) {
          try {
            vaultSync('host_os', {
              last_action: { value: new Date().toISOString(), unit: 'timestamp', context: 'last OS action time' },
              _summary: `OS action: ${action}`,
            });
          } catch { /* non-critical */ }
        }
        res.json({ success: !error, action, stdout: out, stderr: err, exitCode: error ? (error.code ?? 1) : 0 });
      });
  });

  // GET /api/os/actions — what this install can actually do. Feeds capability badges.
  router.get('/os/actions', requireShellAuth, (req, res) => {
    res.json({
      ok: true,
      actions: Object.entries(ACTIONS).map(([id, s]) => ({ id, description: s.describe({}) })),
    });
  });

  // POST /api/os/open — native file/app launcher.
  //
  // Two fixes from the 2026-08-01 sweep. Containment used
  // resolvedPath.startsWith(root), so C:\Users\Alexandra passed a check against
  // C:\Users\Alex. And caller-supplied `args` were joined into the command
  // string, which made every launcher a command-injection point. Containment is
  // now path.relative-based, the launcher is a fixed executable with an argument
  // array, and extra args are gone — nothing needed them and they could not be
  // passed safely through a shell-less launcher anyway.
  const LAUNCHERS = {
    vscode:   { file: 'code' },
    notepad:  { file: 'notepad' },
    explorer: { file: 'explorer' },
    chrome:   { file: 'chrome' },
    // Windows has no shell-less "open with default app", so use the one
    // documented helper that takes the path as a bare argument.
    default: process.platform === 'win32'
      ? { file: 'rundll32', pre: ['url.dll,FileProtocolHandler'] }
      : (process.platform === 'darwin' ? { file: 'open' } : { file: 'xdg-open' }),
  };

  router.post('/os/open', requireShellAuth, (req, res) => {
    if (isVercel) return res.status(403).json({ error: 'Desktop Only feature' });
    const { filePath, appHint = 'default' } = req.body || {};

    let resolvedPath = '';
    try {
      resolvedPath = path.resolve(filePath || '');
    } catch {
      return res.status(400).json({ correlation_id: req.correlationId || 'AEON-SYS', error: 'Invalid file path.' });
    }
    if (!filePath) {
      return res.status(400).json({ correlation_id: req.correlationId || 'AEON-SYS', error: 'filePath required.' });
    }

    const matchedRoot = (ALLOWED_ROOTS || []).find(root => isInside(root, resolvedPath, { allowRoot: true }));
    if (!matchedRoot) {
      writeOSAudit('OPEN_BLOCKED', resolvedPath, 403, 0, req.correlationId || 'AEON-SYS');
      return res.status(403).json({ correlation_id: req.correlationId || 'AEON-SYS', error: 'Path outside allowed workspace roots.' });
    }

    const launcher = LAUNCHERS[appHint] || LAUNCHERS.default;
    const argv = [...(launcher.pre || []), resolvedPath];

    execFile(launcher.file, argv, { cwd: WORKSPACE, timeout: 10000, windowsHide: false },
      (error, stdout, stderr) => {
        writeOSAudit('OPEN', `${launcher.file} ${resolvedPath}`, error ? (error.code ?? 1) : 0,
          (stdout || '').length + (stderr || '').length, req.correlationId || 'AEON-SYS');
        if (error) {
          return res.status(500).json({ correlation_id: req.correlationId || 'AEON-SYS', success: false, error: stderr || error.message });
        }
        res.json({ success: true, launched: launcher.file, path: resolvedPath });
      });
  });

  return router;
};
