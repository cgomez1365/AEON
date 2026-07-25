/**
 * AEON kernel auth gate.
 *
 * Authentication endpoints belong to the Security block. This module only
 * guards kernel and block traffic with the shared Vault-backed session policy.
 */
const sessions = require('./server-utils/sessionValidator.cjs');

function mountAuth() {
  // Compatibility hook retained for server/server.js. The Security block is
  // the sole route owner for /api/auth/*.
}

function guard(req, res, next) {
  if (global.__AEON_SECURITY_RESTART_REQUIRED) {
    const allowed = req.path === '/api/health'
      || req.path === '/api/auth/status'
      || req.path === '/api/security/cloud/status'
      || req.path === '/api/security/restart';
    if (!allowed && sessions.isGuardedPath(req.path)) {
      return res.status(423).json({
        success: false,
        error: 'SYSTEM_RESTART_REQUIRED',
        restart_required: true,
      });
    }
  }
  const policy = sessions.loadPolicy();
  if (!sessions.guardActive(policy)) return next();
  if (!sessions.isGuardedPath(req.path)) return next();
  if (sessions.isPreAuthRequest(req)) return next();

  const session = sessions.validateSession(req, policy);
  if (session.ok) {
    req.aeonSession = session;
    return next();
  }
  return sessions.unauthorized(res, session.reason);
}

module.exports = { mountAuth, guard };
