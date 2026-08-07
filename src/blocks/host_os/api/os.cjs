const express = require('express');
const { execFile } = require('child_process');
const path = require('path');
const { vaultSync } = require('../../../kernel/vaultSync.cjs');
const { isInside } = require('../../../kernel/pathContainment.cjs');
const { requireOperator } = require('../../../kernel/server-utils/requireOperator.cjs');

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
    AUDIT_FILE,
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
    // Safe mode is enforced HERE, at the single execution entry point, not in
    // the UI. A toggle that only greys out a button is decoration.
    if (safeMode) {
      writeOSAudit('OS_ACTION_REFUSED', `safe mode: ${req.body && req.body.action}`, 1, 0, req.correlationId || 'AEON-SYS');
      return res.status(423).json({
        error: 'Safe mode is on — OS actions are refused. Turn it off in Settings → Blocks → Operator Console.',
        safeMode: true,
      });
    }
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
  //
  // BO-D2b — requireOperator, not requireShellAuth. This route LISTS the
  // action ids and their descriptions; it runs none of them. Naming a
  // capability is not exercising it, and the execution gate below is what
  // actually stands between a caller and `execFile`.
  router.get('/os/actions', requireOperator({ name: 'Operator Console capabilities' }), (req, res) => {
    res.json({
      ok: true,
      actions: Object.entries(ACTIONS).map(([id, s]) => ({ id, description: s.describe({}) })),
    });
  });

  // ── Operator Console obligations (BO-A5a) ─────────────────────────────────
  // God Mode became the Operator Console and the execution surface was deleted.
  // The obligations that came with the rename — capability badges, preflight
  // preview, an audit screen, and safe mode — have been outstanding since
  // 2026-08-02. They are built here as a WIDGET under BO-A2's contract rather
  // than as bespoke settings pages, so two build orders close with one piece of
  // work: an audit screen and a safe-mode toggle are precisely "a block
  // declaring a control surface in settings."

  // Safe mode — refuses every OS action without touching auth or the vault.
  // Deliberately in-memory: it is a "not right now" switch the operator can
  // flip during a demo or an untrusted session, not a persisted security
  // policy. Persisting it would create a second, quieter place for the install
  // to be disabled, and a restart is the obvious way to clear it.
  let safeMode = false;

  // GET /api/host_os/widget — the settings control surface.
  //
  // The path is /api/host_os/ rather than /api/os/ only because it is the
  // block's widget rather than an OS operation; the widget gate checks the
  // block's declared routes, so either would pass. Kept distinct so the
  // console surface and the execution surface are never confused.
  //
  // BO-C2 — requireOperator, NOT requireShellAuth. This route reads an audit
  // tail. It was mounted behind the raw-EXECUTION gate, which demands a session
  // unconditionally while the global auth gate is opt-in and off by default. On
  // a stock install (no account, guardEnabled false) the operator is using AEON
  // legitimately with no session, so their own control surface answered 401 on
  // every Settings load and again every 30s.
  //
  // §07 principle 04: a read surface earns its own gate rather than inheriting
  // the one written for arbitrary execution. requireOperator allows a valid
  // session from any origin, allows the pre-account window from the machine
  // itself (the owner must never be locked out of a fresh install), and refuses
  // everything else. The execution routes below keep requireShellAuth exactly
  // as it was — §13's position is untouched.
  router.get('/host_os/widget', requireOperator({ name: 'Operator Console widget' }), (req, res) => {
    let recent = [];
    try {
      const audit = require('fs').existsSync(AUDIT_FILE)
        ? JSON.parse(require('fs').readFileSync(AUDIT_FILE, 'utf8'))
        : [];
      recent = audit.slice(-5).reverse().map(e => ({
        label: `${e.action} · ${String(e.details || '').slice(0, 60)}`,
        at: e.timestamp,
        status: e.status_code,
      }));
    } catch { /* an unreadable audit file must not take the widget down */ }

    res.json({
      label: 'Operator Console',
      kind: 'list',
      value: Object.keys(ACTIONS).length,
      sub: safeMode ? 'SAFE MODE — actions refused' : `${Object.keys(ACTIONS).length} actions available`,
      safeMode,
      // Capability badges: what this install can actually do, named.
      capabilities: Object.entries(ACTIONS).map(([id, s]) => ({
        id,
        description: s.describe({}),
        // Preflight preview — the exact executable and argv that would run.
        // The operator sees the command BEFORE approving it, which is the
        // whole point of retiring a shell in favour of named actions.
        preflight: (() => {
          try { return [s.file, ...(s.args ? s.args({}) : [])]; }
          catch { return [s.file]; }
        })(),
      })),
      items: recent.length ? recent : [{ label: 'no OS actions recorded yet' }],
    });
  });

  // POST /api/host_os/safe-mode — the toggle.
  //
  // Deliberately carries NO isVercel guard. host_os declares
  // contract.targets.vercel:false so it never mounts in cloud, and /os/action
  // already refuses there regardless — a third check would be a cloud branch
  // that can never execute. The BO-A3a ratchet caught the redundant guard when
  // it was first written, which is the entire point of having one.
  router.post('/host_os/safe-mode', requireShellAuth, (req, res) => {
    safeMode = !!(req.body && req.body.enabled);
    writeOSAudit('SAFE_MODE', safeMode ? 'enabled' : 'disabled', 0, 0, req.correlationId || 'AEON-SYS');
    res.json({ ok: true, safeMode });
  });

  // GET /api/host_os/audit — the audit screen's data.
  //
  // BO-D2b — requireOperator, for the same reason BO-C2 moved the widget: a
  // read of the audit log is a read. Worse, it is the one route an operator
  // most needs when something has gone wrong, and it was gated on a session
  // the global guard does not create by default — so the record of what the
  // machine did was unreachable exactly when it mattered.
  router.get('/host_os/audit', requireOperator({ name: 'Operator Console audit' }), (req, res) => {
    try {
      const fsMod = require('fs');
      const audit = fsMod.existsSync(AUDIT_FILE)
        ? JSON.parse(fsMod.readFileSync(AUDIT_FILE, 'utf8'))
        : [];
      res.json({ ok: true, entries: audit.slice(-50).reverse() });
    } catch (e) {
      // R-05: an unreadable audit trail is reported, never rendered as "clean".
      res.status(500).json({ ok: false, error: `audit unreadable: ${e.message}` });
    }
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
