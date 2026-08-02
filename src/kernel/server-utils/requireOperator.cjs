// requireOperator — per-router session gate for privileged surfaces.
//
// Why this exists: the global auth gate returns next() for everything whenever
// `guardActive()` is false, and DEFAULT_POLICY.guardEnabled is false. That is a
// deliberate, supported posture — but it meant privileged routers that carried
// no gate of their own (the console router, cookbook) were completely
// unauthenticated on a default install, including an arbitrary-filename vault
// write. One switch away from open is not defence in depth.
//
// Owner control is preserved, and that constraint is not negotiable here: a
// fresh install has no account yet, so the owner MUST be able to reach setup.
// The rule below allows that only from the machine itself. It never opens a
// privileged route to the network.
//
//   valid session                  -> allow
//   no account yet + loopback      -> allow  (first run, owner at the keyboard)
//   anything else                  -> 401
//
// Loopback is not authentication — it is only ever used here in the pre-account
// window, where there is no session that could exist yet.

const sessions = require('./sessionValidator.cjs');

function isLoopback(req) {
  const ip = req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/**
 * @param {{name?: string}} [opts] name — surface label used in log lines.
 */
function requireOperator(opts = {}) {
  const label = opts.name || 'privileged';

  return function operatorGate(req, res, next) {
    let result = { ok: false, reason: 'unavailable' };
    try { result = sessions.validateSession(req) || result; } catch { /* fail closed */ }
    if (result.ok) return next();

    let accountExists = false;
    try { accountExists = sessions.hasAccount(); } catch { accountExists = false; }

    if (!accountExists && isLoopback(req)) return next();

    console.warn(`[SECURITY] ${label}: refused ${req.method} ${req.originalUrl || req.url} from ${req.ip} (${result.reason || 'no-session'})`);
    return res.status(401).json({
      correlation_id: req.correlationId || 'AEON-SYS',
      error: accountExists
        ? 'Sign in to use this surface.'
        : 'This surface is only available on the machine running AEON until an account is created.',
      requires_auth: true,
      reason: result.reason || 'no-session',
    });
  };
}

module.exports = { requireOperator, isLoopback };
