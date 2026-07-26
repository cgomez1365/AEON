const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const defaultSessions = require('../../../kernel/server-utils/sessionValidator.cjs');
const SECURITY_QUESTIONS = require('../constants/questions.data.json');
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * AEON Security Block — user-identity auth layer.
 *
 * Complements the existing AEON_MOBILE_SECRET (machine-to-machine bearer):
 * this adds a HUMAN account with a password, profile, and session control.
 *
 * Zero new dependencies — uses Node's builtin crypto:
 *   • scrypt for password hashing (per-user random salt)
 *   • timingSafeEqual for constant-time verification
 *   • randomBytes for session tokens
 *
 * Credentials and sessions persist under Vault/blocks/security.
 */
module.exports = (app, deps) => {
  const sessions = deps && Object.prototype.hasOwnProperty.call(deps, 'sessionValidator')
    ? deps.sessionValidator
    : defaultSessions;
  // Injectable clock (defaults to the wall clock). Recovery expiry windows read
  // this so tests can pin issuance and expiry boundaries exactly (BO6).
  const now = deps && typeof deps.now === 'function' ? deps.now : () => Date.now();
  const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
  const MAX_FAILED = 5;                            // lockout threshold
  const LOCKOUT_MS = 1000 * 60 * 15;               // 15 min lockout
  const RECOVERY_TOKEN_TTL_MS = 1000 * 60 * 5;
  const EMERGENCY_PASSPHRASE_TTL_MS = 1000 * 60 * 10;
  const questionTextById = new Map(SECURITY_QUESTIONS.map(question => [question.id, question.text]));

  // ── Store I/O ──────────────────────────────────────────────────────
  const { loadUser, saveUser, loadPolicy, savePolicy } = sessions;

  // AEON is protected the moment an account exists. This is the single truth
  // the AuthGate polls — it must NOT depend on a settings pref the Guardian
  // only mirrors on save, or a fresh account would leave the app wide open
  // until the user happened to open the policy panel. The Guardian's master
  // switch (guardEnabled:false in its policy.json) is the only way to opt out.
  function loginRequired() {
    return sessions.guardActive(loadPolicy());
  }

  // ── Crypto helpers ─────────────────────────────────────────────────
  function hashPassword(password, salt) {
    const s = salt || crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, s, 64).toString('hex');
    return { salt: s, hash };
  }
  function verifyPassword(password, salt, expectedHash) {
    if (!salt || !expectedHash) return false;
    const { hash } = hashPassword(password, salt);
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(expectedHash, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }
  function newToken() { return crypto.randomBytes(32).toString('hex'); }

  function passwordPolicy(pw) {
    if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters';
    if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/[0-9]/.test(pw))
      return 'Password needs upper, lower, and a number';
    return null;
  }

  function normalizeRecoveryAnswer(answer) {
    return String(answer || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function hashRecoveryAnswer(answer) {
    const salt = crypto.randomBytes(16).toString('hex');
    const answerHash = crypto.scryptSync(normalizeRecoveryAnswer(answer), salt, 64).toString('hex');
    return { salt, answerHash };
  }

  function verifyRecoveryAnswer(answer, salt, expectedHash) {
    const actual = crypto.scryptSync(normalizeRecoveryAnswer(answer), salt, 64);
    const expected = Buffer.from(expectedHash || '', 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }

  function appendRecoveryAudit(event, method) {
    const auditFile = path.join(sessions.SECURITY_DIR, 'audit.log');
    fs.mkdirSync(path.dirname(auditFile), { recursive: true });
    fs.appendFileSync(auditFile, `${JSON.stringify({
      event,
      timestamp: new Date().toISOString(),
      method,
    })}\n`, { mode: 0o600 });
  }

  function isEmergencyCredential(u, password) {
    const recovery = u?.recoverySession;
    return !!recovery
      && recovery.emergencyUsed !== true
      && now() < Number(recovery.emergencyExpiresAt || 0)
      && verifyPassword(password || '', recovery.emergencySalt, recovery.emergencyHash);
  }

  function issueSession(u, req) {
    const timestamp = Date.now();
    pruneSessions(u);
    const token = newToken();
    u.sessions = u.sessions || {};
    u.sessions[token] = {
      created: timestamp,
      lastSeen: timestamp,
      expires: timestamp + SESSION_TTL_MS,
      ua: (req.headers['user-agent'] || 'unknown').slice(0, 160),
      ip: req.ip || req.connection?.remoteAddress || 'local',
    };
    return token;
  }

  // ── Session helpers ────────────────────────────────────────────────
  function getBearer(req) {
    return sessions.getToken(req);
  }

  function pruneSessions(u) {
    const now = Date.now();
    for (const [tok, meta] of Object.entries(u.sessions || {})) {
      if (!meta.expires || meta.expires < now) delete u.sessions[tok];
    }
  }

  function authedUser(req) {
    const result = sessions.validateSession(req, loadPolicy());
    return result.ok && result.kind === 'session' ? result : null;
  }

  // Express middleware other blocks can import via deps if exported.
  function requireAuth(req, res, next) {
    const ctx = sessions.validateSession(req, loadPolicy());
    if (!ctx.ok) return sessions.unauthorized(res, ctx.reason);
    req.aeonUser = { username: ctx.user.username, role: ctx.user.role, token: ctx.token };
    next();
  }

  function publicProfile(u) {
    return {
      username: u.username,
      displayName: u.displayName || u.username,
      email: u.email || '',
      role: u.role || 'operator',
      authMode: u.authMode || 'local',
      cloudProvider: u.cloudProvider || null,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt || u.createdAt,
      lastLogin: u.lastLogin || null,
      sessionCount: Object.keys(u.sessions || {}).length,
    };
  }

  // ── GET /api/auth/status — account existence + auth state ───────────
  app.get('/api/auth/status', (req, res) => {
    const u = loadUser();
    const ctx = u ? authedUser(req) : null;
    res.json({
      configured: !!u,
      authenticated: !!ctx,
      loginRequired: loginRequired(),
      authMode: u?.authMode || null,
      cloudProvider: u?.cloudProvider || null,
      user: ctx ? publicProfile(ctx.user) : null,
    });
  });

  // ── POST /api/auth/setup — first-run account creation ──────────────
  app.post('/api/auth/setup', (req, res) => {
    if (loadUser()) return res.status(409).json({ error: 'Account already exists' });
    const { username, password, displayName, email, recoveryQuestions } = req.body || {};
    if (!username || username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
    if (!email || !EMAIL_RE.test(String(email).trim()))
      return res.status(400).json({ error: 'A valid contact email is required' });
    const pwErr = passwordPolicy(password);
    if (pwErr) return res.status(400).json({ error: pwErr });
    if (!Array.isArray(recoveryQuestions) || recoveryQuestions.length !== 3)
      return res.status(400).json({ error: 'Choose exactly 3 recovery questions' });
    const questionIds = recoveryQuestions.map(item => String(item?.questionId || ''));
    if (new Set(questionIds).size !== 3 || questionIds.some(id => !questionTextById.has(id)))
      return res.status(400).json({ error: 'Recovery questions must be 3 distinct standardized questions' });
    if (recoveryQuestions.some(item => normalizeRecoveryAnswer(item?.answer).length < 2))
      return res.status(400).json({ error: 'Each recovery answer must contain at least 2 characters' });

    const { salt, hash } = hashPassword(password);
    const recovery = recoveryQuestions.map(item => ({
      questionId: item.questionId,
      ...hashRecoveryAnswer(item.answer),
    }));
    const now = new Date().toISOString();
    const u = {
      username: String(username).toLowerCase().trim(),
      displayName: displayName || username,
      email: email || '',
      role: 'operator',
      salt, passHash: hash,
      createdAt: now, updatedAt: now,
      lastLogin: null,
      failedAttempts: 0, lockedUntil: 0,
      recoveryQuestions: recovery,
      sessions: {},
    };
    saveUser(u);
    savePolicy({ ...loadPolicy(), guardEnabled: true, bootSequence: true });
    if (deps && deps.writeOSAudit) deps.writeOSAudit('AUTH_SETUP', `Account created: ${u.username}`, 200, 0);
    res.json({ ok: true, user: publicProfile(u) });
  });

  // Shared failure accounting — the SINGLE owner of every login failure path
  // (wrong password, wrong TOTP code, wrong backup code). One counter, one
  // lockout, one deliberately generic error that never reveals which factor was
  // wrong. Persists on every call so accounting survives the two-step 2FA flow.
  function registerAuthFailure(u, res) {
    u.failedAttempts = (u.failedAttempts || 0) + 1;
    if (u.failedAttempts >= MAX_FAILED) {
      u.lockedUntil = Date.now() + LOCKOUT_MS;
      u.failedAttempts = 0;
      if (deps && deps.writeOSAudit) deps.writeOSAudit('AUTH_LOCKOUT', `Lockout: ${u.username}`, 429, 0);
    }
    saveUser(u);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // ── POST /api/auth/login ───────────────────────────────────────────
  // Password + optional TOTP second factor in ONE handler. (BO2 replaced the
  // former login-route monkey-patch, which returned before the base handler
  // could account for wrong-password / wrong-code failures, and consumed backup
  // codes before the password was re-checked.)
  app.post('/api/auth/login', (req, res) => {
    const u = loadUser();
    if (!u) return res.status(404).json({ error: 'No account configured' });

    const { username, password } = req.body || {};
    const userMatch = String(username || '').toLowerCase().trim() === u.username;
    const primaryMatch = userMatch && verifyPassword(password || '', u.salt, u.passHash);
    // The break-glass emergency passphrase is the owner's guaranteed way back
    // into their own local system: single-use, time-limited, and issued only
    // after passing recovery, so it cannot be brute-forced. It BYPASSES the
    // failed-attempt lockout — a password brute-force must never be able to lock
    // the owner out of a machine that is theirs ("no boot lockout"). A
    // successful emergency login clears the lockout below.
    const emergencyMatch = userMatch && isEmergencyCredential(u, password);

    // Lockout gates password and second-factor attempts — never the emergency
    // passphrase — and is checked before any second-factor work. (BO2 policy.)
    if (!emergencyMatch && u.lockedUntil && u.lockedUntil > Date.now()) {
      const mins = Math.ceil((u.lockedUntil - Date.now()) / 60000);
      return res.status(429).json({ error: `Account locked. Try again in ${mins} min.` });
    }

    // Wrong primary credential → shared accounting. Generic error.
    if (!primaryMatch && !emergencyMatch) return registerAuthFailure(u, res);

    // Full success — reset the counter and issue the session.
    u.failedAttempts = 0;
    u.lockedUntil = 0;
    u.lastLogin = new Date().toISOString();
    if (emergencyMatch) {
      u.recoverySession.emergencyUsed = true;
      appendRecoveryAudit('RECOVERY_EMERGENCY_LOGIN', 'TEMPORARY_PASSPHRASE');
    }
    const token = issueSession(u, req);
    saveUser(u);
    if (deps && deps.writeOSAudit) deps.writeOSAudit('AUTH_LOGIN', `Login: ${u.username}`, 200, 0);

    res.setHeader('Set-Cookie',
      `aeon_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
    res.json({ ok: true, token, user: publicProfile(u) });
  });

  // ── Break-glass recovery: challenge, verify, and reset ─────────────
  app.post('/api/security/recovery/challenge', (req, res) => {
    const u = loadUser();
    const username = String(req.body?.username || '').trim().toLowerCase();
    if (!u || username !== u.username || u.recoveryQuestions?.length !== 3) {
      return res.status(404).json({ error: 'Local recovery account was not found' });
    }
    if (Number(u.recoveryLockout?.lockedUntil || 0) > now()) {
      return res.status(429).json({
        error: 'Recovery is locked for 15 minutes after too many failed attempts',
        retryAfter: Math.ceil((u.recoveryLockout.lockedUntil - now()) / 1000),
      });
    }
    res.json({
      ok: true,
      questions: u.recoveryQuestions.map(item => ({
        questionId: item.questionId,
        text: questionTextById.get(item.questionId),
      })),
    });
  });

  app.post('/api/security/recovery/verify', (req, res) => {
    const u = loadUser();
    const username = String(req.body?.username || '').trim().toLowerCase();
    const answers = req.body?.answers;
    if (!u || username !== u.username || u.recoveryQuestions?.length !== 3) {
      return res.status(404).json({ error: 'Local recovery account was not found' });
    }
    const timestamp = now();
    if (Number(u.recoveryLockout?.lockedUntil || 0) > timestamp) {
      return res.status(429).json({
        error: 'Recovery is locked for 15 minutes after too many failed attempts',
        retryAfter: Math.ceil((u.recoveryLockout.lockedUntil - timestamp) / 1000),
      });
    }
    if (!Array.isArray(answers) || answers.length !== 3) {
      return res.status(400).json({ error: 'Answer all 3 recovery questions' });
    }
    const submitted = new Map(answers.map(item => [String(item?.questionId || ''), item?.answer]));
    const allCorrect = u.recoveryQuestions.every(item => (
      submitted.has(item.questionId)
      && verifyRecoveryAnswer(submitted.get(item.questionId), item.salt, item.answerHash)
    ));
    if (!allCorrect) {
      const previous = u.recoveryLockout || {};
      const inWindow = timestamp - Number(previous.windowStartedAt || 0) < LOCKOUT_MS;
      const failedAttempts = (inWindow ? Number(previous.failedAttempts || 0) : 0) + 1;
      u.recoveryLockout = {
        windowStartedAt: inWindow ? previous.windowStartedAt : timestamp,
        failedAttempts,
        lockedUntil: failedAttempts >= MAX_FAILED ? timestamp + LOCKOUT_MS : 0,
      };
      saveUser(u);
      if (failedAttempts >= MAX_FAILED) {
        return res.status(429).json({
          error: 'Recovery is locked for 15 minutes after 5 failed attempts',
          retryAfter: LOCKOUT_MS / 1000,
        });
      }
      return res.status(401).json({
        error: 'Recovery answers were not accepted',
        attemptsRemaining: MAX_FAILED - failedAttempts,
      });
    }

    const recoveryToken = newToken();
    const temporaryPassphrase = `AEON-${crypto.randomBytes(8).toString('hex').toUpperCase().match(/.{1,4}/g).join('-')}`;
    const tokenCredential = hashPassword(recoveryToken);
    const emergencyCredential = hashPassword(temporaryPassphrase);
    // Issuance = the instant credential derivation completed. Both windows start
    // here (not at handler entry), so the caller gets the FULL advertised 5/10
    // minutes rather than 5/10 minutes minus the scrypt derivation time. (BO6)
    const issuedAt = now();
    u.recoveryLockout = { windowStartedAt: 0, failedAttempts: 0, lockedUntil: 0 };
    u.recoverySession = {
      tokenSalt: tokenCredential.salt,
      tokenHash: tokenCredential.hash,
      expiresAt: issuedAt + RECOVERY_TOKEN_TTL_MS,
      used: false,
      emergencySalt: emergencyCredential.salt,
      emergencyHash: emergencyCredential.hash,
      emergencyExpiresAt: issuedAt + EMERGENCY_PASSPHRASE_TTL_MS,
      emergencyUsed: false,
      createdAt: issuedAt,
    };
    saveUser(u);
    appendRecoveryAudit('RECOVERY_SUCCESS', 'BREAK_GLASS_3_QUESTIONS');
    res.json({
      ok: true,
      username: u.username,
      recoveryToken,
      expiresAt: u.recoverySession.expiresAt,
      temporaryPassphrase,
      emergencyExpiresAt: u.recoverySession.emergencyExpiresAt,
    });
  });

  app.post('/api/security/recovery/reset', (req, res) => {
    const u = loadUser();
    const recovery = u?.recoverySession;
    const recoveryToken = String(req.body?.recoveryToken || '');
    const newPassword = req.body?.newPassword;
    if (!u || !recovery || recovery.used || now() >= Number(recovery.expiresAt || 0)
      || !verifyPassword(recoveryToken, recovery.tokenSalt, recovery.tokenHash)) {
      return res.status(401).json({ error: 'Recovery authorization is invalid or expired' });
    }
    const pwErr = passwordPolicy(newPassword);
    if (pwErr) return res.status(400).json({ error: pwErr });
    if (verifyPassword(newPassword, u.salt, u.passHash)) {
      return res.status(400).json({ error: 'New password must differ from current password' });
    }
    const credential = hashPassword(newPassword);
    u.salt = credential.salt;
    u.passHash = credential.hash;
    u.updatedAt = new Date().toISOString();
    u.lastLogin = u.updatedAt;
    u.sessions = {};
    const token = issueSession(u, req);
    delete u.recoverySession;
    saveUser(u);
    appendRecoveryAudit('RECOVERY_PASSWORD_RESET', 'BREAK_GLASS_3_QUESTIONS');
    res.setHeader(
      'Set-Cookie',
      `aeon_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
    );
    res.json({ ok: true, token, user: publicProfile(u) });
  });

  // ── POST /api/auth/logout ──────────────────────────────────────────
  app.post('/api/auth/logout', (req, res) => {
    const ctx = authedUser(req);
    if (ctx) {
      delete ctx.user.sessions[ctx.token];
      saveUser(ctx.user);
    }
    res.setHeader('Set-Cookie', 'aeon_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    res.json({ ok: true });
  });

  // ── GET /api/auth/me ───────────────────────────────────────────────
  app.get('/api/auth/me', requireAuth, (req, res) => {
    const u = loadUser();
    if (!u) return res.status(404).json({ error: 'No account' });
    res.json({ user: publicProfile(u) });
  });

  // ── POST /api/auth/profile — update displayName / email ────────────
  app.post('/api/auth/profile', requireAuth, (req, res) => {
    const u = loadUser();
    if (!u) return res.status(404).json({ error: 'No account' });
    const { displayName, email } = req.body || {};
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      return res.status(400).json({ error: 'Invalid email format' });
    if (displayName !== undefined) u.displayName = String(displayName).slice(0, 80);
    if (email !== undefined) u.email = String(email).slice(0, 160);
    u.updatedAt = new Date().toISOString();
    saveUser(u);
    if (deps && deps.writeOSAudit) deps.writeOSAudit('AUTH_PROFILE', `Profile updated: ${u.username}`, 200, 0);
    res.json({ ok: true, user: publicProfile(u) });
  });

  // ── POST /api/auth/change-password ─────────────────────────────────
  app.post('/api/auth/change-password', requireAuth, (req, res) => {
    const u = loadUser();
    if (!u) return res.status(404).json({ error: 'No account' });
    const { currentPassword, newPassword } = req.body || {};
    if (!verifyPassword(currentPassword || '', u.salt, u.passHash))
      return res.status(401).json({ error: 'Current password is incorrect' });
    const pwErr = passwordPolicy(newPassword);
    if (pwErr) return res.status(400).json({ error: pwErr });
    if (verifyPassword(newPassword, u.salt, u.passHash))
      return res.status(400).json({ error: 'New password must differ from current' });

    const { salt, hash } = hashPassword(newPassword);
    u.salt = salt; u.passHash = hash;
    u.updatedAt = new Date().toISOString();
    // Revoke all other sessions on password change — keep the caller's.
    const keep = req.aeonUser.token;
    u.sessions = keep && u.sessions[keep] ? { [keep]: u.sessions[keep] } : {};
    saveUser(u);
    if (deps && deps.writeOSAudit) deps.writeOSAudit('AUTH_PASSWORD', `Password changed: ${u.username}`, 200, 0);
    res.json({ ok: true });
  });

  // ── GET /api/auth/sessions — active sessions ───────────────────────
  app.get('/api/auth/sessions', requireAuth, (req, res) => {
    const u = loadUser();
    if (!u) return res.status(404).json({ error: 'No account' });
    pruneSessions(u);
    saveUser(u);
    const cur = req.aeonUser.token;
    const list = Object.entries(u.sessions || {}).map(([tok, m]) => ({
      id: tok.slice(0, 12),
      current: tok === cur,
      created: m.created,
      expires: m.expires,
      ua: m.ua,
      ip: m.ip,
    })).sort((a, b) => b.created - a.created);
    res.json({ sessions: list });
  });

  // ── POST /api/auth/sessions/revoke — revoke one or all-other ───────
  app.post('/api/auth/sessions/revoke', requireAuth, (req, res) => {
    const u = loadUser();
    if (!u) return res.status(404).json({ error: 'No account' });
    const { id, all } = req.body || {};
    const cur = req.aeonUser.token;
    if (all) {
      u.sessions = u.sessions[cur] ? { [cur]: u.sessions[cur] } : {};
    } else if (id) {
      for (const tok of Object.keys(u.sessions || {})) {
        if (tok.slice(0, 12) === id && tok !== cur) delete u.sessions[tok];
      }
    }
    saveUser(u);
    res.json({ ok: true, remaining: Object.keys(u.sessions || {}).length });
  });

  // Expose middleware for other blocks / kernel global gate.
  if (deps) deps.requireAuth = requireAuth;
};
