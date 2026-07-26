/**
 * AEON kernel auth gate.
 *
 * Authentication endpoints belong to the Security block. This module only
 * guards kernel and block traffic with the shared Vault-backed session policy.
 *
 * /api/kernel/security-availability is the one exception: it is answered
 * HERE, not by the block, on purpose. If someone deletes
 * src/blocks/security/ while an account is protected, the block's own
 * /api/auth/status route disappears with it — a naive frontend check would
 * then read "no account configured" and let anyone straight into AEON. This
 * endpoint reads the same Vault-backed session data the guard below already
 * uses, independent of whether the block exists, so a missing block is
 * reported as "locked out," never as "no account."
 */
const fs = require('fs');
const path = require('path');
const sessions = require('./server-utils/sessionValidator.cjs');

let securityBlockDir = path.join(__dirname, '..', 'blocks', 'security');

// Test-only seam — production never calls this.
function _setSecurityBlockDirForTests(dir) {
  securityBlockDir = dir;
}

function mountAuth(app) {
  app.get('/api/kernel/security-availability', (req, res) => {
    const policy = sessions.loadPolicy();
    const guardIsActive = sessions.guardActive(policy);
    const session = guardIsActive ? sessions.validateSession(req, policy) : { ok: false };
    res.json({
      blockPresent: fs.existsSync(securityBlockDir),
      hasAccount: sessions.hasAccount(),
      guardActive: guardIsActive,
      authenticated: !!session.ok,
    });
  });
}

function guard(req, res, next) {
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

module.exports = { mountAuth, guard, _setSecurityBlockDirForTests };
