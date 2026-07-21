const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
 * Credentials persist in aeon_user.json next to server.cjs, mirroring the
 * existing local-JSON-store pattern (token_ledger.json).
 */
module.exports = (app, deps) => {
  // app root = src/blocks/security/api → up 4
  const APP_ROOT = path.join(__dirname, '..', '..', '..', '..');
  const SECRETS_DIR = path.join(APP_ROOT, 'secrets');
  try { fs.mkdirSync(SECRETS_DIR, { recursive: true }); } catch {}
  const USER_FILE = path.join(SECRETS_DIR, 'aeon-user.json');
  const SETTINGS_FILE = path.join(APP_ROOT, 'src', 'aeon-settings.json');

  const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
  const MAX_FAILED = 5;                            // lockout threshold
  const LOCKOUT_MS = 1000 * 60 * 15;               // 15 min lockout

  // ── Store I/O ──────────────────────────────────────────────────────
  function loadUser() {
    if (fs.existsSync(USER_FILE)) {
      try { return JSON.parse(fs.readFileSync(USER_FILE, 'utf8')); } catch {}
    }
    return null;
  }
  function saveUser(u) {
    fs.writeFileSync(USER_FILE, JSON.stringify(u, null, 2), { mode: 0o600 });
  }

  // AEON is protected the moment an account exists. This is the single truth
  // the AuthGate polls — it must NOT depend on a settings pref the Guardian
  // only mirrors on save, or a fresh account would leave the app wide open
  // until the user happened to open the policy panel. The Guardian's master
  // switch (guardEnabled:false in its policy.json) is the only way to opt out.
  function loginRequired() {
    if (!loadUser()) return false;                    // no account → nothing to protect
    try {
      const policyFile = deps && deps.getDataFile
        ? path.join(deps.getDataFile('security'), 'policy.json') : null;
      if (policyFile && fs.existsSync(policyFile)) {
        const p = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
        if (p.guardEnabled === false) return false;   // operator explicitly turned it off
      }
    } catch {}
    return true;                                       // account exists, guard not disabled
  }

  // ── Crypto helpers ─────────────────────────────────────────────────
  function hashPassword(password, salt) {
    const s = salt || crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, s, 64).toString('hex');
    return { salt: s, hash };
  }
  function verifyPassword(password, salt, expectedHash) {
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

  // ── Session helpers ────────────────────────────────────────────────
  function getBearer(req) {
    const h = req.headers.authorization || '';
    if (h.startsWith('Bearer ')) return h.slice(7).trim();
    // fallback: aeon_session cookie
    const cookie = req.headers.cookie || '';
    const m = cookie.match(/(?:^|;\s*)aeon_session=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function pruneSessions(u) {
    const now = Date.now();
    for (const [tok, meta] of Object.entries(u.sessions || {})) {
      if (!meta.expires || meta.expires < now) delete u.sessions[tok];
    }
  }

  function authedUser(req) {
    const u = loadUser();
    if (!u) return null;
    const token = getBearer(req);
    if (!token || !u.sessions || !u.sessions[token]) return null;
    const meta = u.sessions[token];
    if (!meta.expires || meta.expires < Date.now()) return null;
    return { user: u, token, meta };
  }

  // Express middleware other blocks can import via deps if exported.
  function requireAuth(req, res, next) {
    // The shared AEON_MOBILE_SECRET bearer still satisfies machine clients.
    if (process.env.AEON_MOBILE_SECRET &&
        req.headers.authorization === `Bearer ${process.env.AEON_MOBILE_SECRET}`) {
      req.aeonUser = { role: 'machine', username: 'system' };
      return next();
    }
    const ctx = authedUser(req);
    if (!ctx) return res.status(401).json({ error: 'Authentication required' });
    req.aeonUser = { username: ctx.user.username, role: ctx.user.role, token: ctx.token };
    next();
  }

  function publicProfile(u) {
    return {
      username: u.username,
      displayName: u.displayName || u.username,
      email: u.email || '',
      role: u.role || 'operator',
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
      user: ctx ? publicProfile(ctx.user) : null,
    });
  });

  // ── POST /api/auth/setup — first-run account creation ──────────────
  app.post('/api/auth/setup', (req, res) => {
    if (loadUser()) return res.status(409).json({ error: 'Account already exists' });
    const { username, password, displayName, email } = req.body || {};
    if (!username || username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
    const pwErr = passwordPolicy(password);
    if (pwErr) return res.status(400).json({ error: pwErr });

    const { salt, hash } = hashPassword(password);
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
      sessions: {},
    };
    saveUser(u);
    if (deps && deps.writeOSAudit) deps.writeOSAudit('AUTH_SETUP', `Account created: ${u.username}`, 200, 0);
    res.json({ ok: true, user: publicProfile(u) });
  });

  // ── POST /api/auth/login ───────────────────────────────────────────
  app.post('/api/auth/login', (req, res) => {
    const u = loadUser();
    if (!u) return res.status(404).json({ error: 'No account configured' });

    if (u.lockedUntil && u.lockedUntil > Date.now()) {
      const mins = Math.ceil((u.lockedUntil - Date.now()) / 60000);
      return res.status(429).json({ error: `Account locked. Try again in ${mins} min.` });
    }

    const { username, password } = req.body || {};
    const userMatch = String(username || '').toLowerCase().trim() === u.username;
    const passMatch = userMatch && verifyPassword(password || '', u.salt, u.passHash);

    if (!passMatch) {
      u.failedAttempts = (u.failedAttempts || 0) + 1;
      if (u.failedAttempts >= MAX_FAILED) {
        u.lockedUntil = Date.now() + LOCKOUT_MS;
        u.failedAttempts = 0;
        if (deps && deps.writeOSAudit) deps.writeOSAudit('AUTH_LOCKOUT', `Lockout: ${u.username}`, 429, 0);
      }
      saveUser(u);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Success — issue session
    u.failedAttempts = 0;
    u.lockedUntil = 0;
    u.lastLogin = new Date().toISOString();
    pruneSessions(u);
    const token = newToken();
    if (!u.sessions) u.sessions = {};
    u.sessions[token] = {
      created: Date.now(),
      expires: Date.now() + SESSION_TTL_MS,
      ua: (req.headers['user-agent'] || 'unknown').slice(0, 160),
      ip: req.ip || req.connection?.remoteAddress || 'local',
    };
    saveUser(u);
    if (deps && deps.writeOSAudit) deps.writeOSAudit('AUTH_LOGIN', `Login: ${u.username}`, 200, 0);

    res.setHeader('Set-Cookie',
      `aeon_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
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

  // ══════════════════════════════════════════════════════════════════
  //  TWO-FACTOR AUTHENTICATION (TOTP) — zero dependencies
  //  RFC 6238 TOTP built on Node's builtin crypto.createHmac.
  //  Compatible with Google Authenticator, Aegis, Authy, etc.
  // ══════════════════════════════════════════════════════════════════

  function generateTOTPSecret() {
    const raw = crypto.randomBytes(20); // 160 bits per RFC 4226 §4
    const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const b of raw) bits += b.toString(2).padStart(8, '0');
    let secret = '';
    for (let i = 0; i + 5 <= bits.length; i += 5) {
      secret += base32Chars[parseInt(bits.slice(i, i + 5), 2)];
    }
    return secret; // 32 base32 chars
  }

  function base32Decode(str) {
    const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const c of str.toUpperCase()) {
      const val = base32Chars.indexOf(c);
      if (val === -1) continue;
      bits += val.toString(2).padStart(5, '0');
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
    return Buffer.from(bytes);
  }

  function generateTOTP(secret, timeStep = 30, digits = 6, offset = 0) {
    const time = Math.floor(Date.now() / 1000 / timeStep) + offset;
    const timeBuffer = Buffer.alloc(8);
    timeBuffer.writeUInt32BE(0, 0);
    timeBuffer.writeUInt32BE(time, 4);
    const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(timeBuffer).digest();
    const off = hmac[hmac.length - 1] & 0xf;
    const code = ((hmac[off] & 0x7f) << 24 | hmac[off + 1] << 16 | hmac[off + 2] << 8 | hmac[off + 3]) % (10 ** digits);
    return code.toString().padStart(digits, '0');
  }

  function verifyTOTP(secret, token, window = 1) {
    for (let i = -window; i <= window; i++) {
      if (generateTOTP(secret, 30, 6, i) === token) return true;
    }
    return false;
  }

  function totpURI(secret, username) {
    return `otpauth://totp/AEON:${encodeURIComponent(username)}?secret=${secret}&issuer=AEON&algorithm=SHA1&digits=6&period=30`;
  }

  // ── POST /api/auth/2fa/setup — generate secret + provisioning URI ──
  app.post('/api/auth/2fa/setup', requireAuth, async (req, res) => {
    const u = loadUser();
    if (!u) return res.status(404).json({ error: 'No account' });
    if (u.totp && u.totp.enabled) return res.status(400).json({ error: '2FA is already enabled' });
    const secret = generateTOTPSecret();
    u.totpPending = secret;
    saveUser(u);
    const uri = totpURI(secret, u.username);
    let qrDataUrl = null;
    try {
      const QRCode = require('qrcode');
      qrDataUrl = await QRCode.toDataURL(uri, { width: 200, margin: 2 });
    } catch {}
    res.json({ ok: true, secret, uri, qrDataUrl, issuer: 'AEON', username: u.username });
  });

  // ── POST /api/auth/2fa/verify — confirm setup with a code from the app ─
  app.post('/api/auth/2fa/verify', requireAuth, (req, res) => {
    const u = loadUser();
    if (!u) return res.status(404).json({ error: 'No account' });
    if (!u.totpPending) return res.status(400).json({ error: 'No pending 2FA setup — call /2fa/setup first' });
    const { code } = req.body || {};
    if (!code || !verifyTOTP(u.totpPending, String(code).trim())) {
      return res.status(401).json({ error: 'Invalid code — check your authenticator app and try again' });
    }
    // Generate backup codes
    const backupCodes = Array.from({ length: 8 }, () => crypto.randomBytes(4).toString('hex'));
    u.totp = { enabled: true, secret: u.totpPending, enabledAt: new Date().toISOString() };
    u.totpBackupCodes = backupCodes.map(c => ({ code: c, used: false }));
    delete u.totpPending;
    saveUser(u);
    if (deps && deps.writeOSAudit) deps.writeOSAudit('AUTH_2FA_ENABLED', `2FA enabled for ${u.username}`, 200, 0);
    res.json({ ok: true, backupCodes });
  });

  // ── POST /api/auth/2fa/disable — turn off 2FA ─────────────────────
  app.post('/api/auth/2fa/disable', requireAuth, (req, res) => {
    const u = loadUser();
    if (!u) return res.status(404).json({ error: 'No account' });
    const { password } = req.body || {};
    if (!verifyPassword(password || '', u.salt, u.passHash))
      return res.status(401).json({ error: 'Password required to disable 2FA' });
    delete u.totp; delete u.totpPending; delete u.totpBackupCodes;
    saveUser(u);
    if (deps && deps.writeOSAudit) deps.writeOSAudit('AUTH_2FA_DISABLED', `2FA disabled for ${u.username}`, 200, 0);
    res.json({ ok: true });
  });

  // ── GET /api/auth/2fa/status — check if 2FA is enabled ────────────
  app.get('/api/auth/2fa/status', (req, res) => {
    const u = loadUser();
    res.json({ enabled: !!(u && u.totp && u.totp.enabled) });
  });

  // Patch the login route to check 2FA
  // Works whether "app" is the real Express app (._router.stack) or the block
  // host's inner Router (.stack directly) — B6 hot-reload mounts us on a Router.
  const _stack = (app._router || app).stack || [];
  const _originalLogin = _stack.find(l => l.route && l.route.path === '/api/auth/login' && l.route.methods.post);
  if (_originalLogin) {
    const origHandler = _originalLogin.route.stack[0].handle;
    _originalLogin.route.stack[0].handle = (req, res) => {
      const u = loadUser();
      if (u && u.totp && u.totp.enabled) {
        const { code } = req.body || {};
        if (!code) {
          // First step: password only → tell client 2FA is needed
          const { username, password } = req.body || {};
          const userMatch = String(username || '').toLowerCase().trim() === u.username;
          const passMatch = userMatch && verifyPassword(password || '', u.salt, u.passHash);
          if (!passMatch) return res.status(401).json({ error: 'Invalid credentials' });
          return res.status(200).json({ requires2FA: true, message: 'Enter your 2FA code' });
        }
        // Second step: verify TOTP code
        const validCode = verifyTOTP(u.totp.secret, String(code).trim());
        const validBackup = !validCode && u.totpBackupCodes?.some(b => !b.used && b.code === String(code).trim());
        if (!validCode && !validBackup) {
          return res.status(401).json({ error: 'Invalid 2FA code' });
        }
        if (validBackup) {
          const bc = u.totpBackupCodes.find(b => b.code === String(code).trim());
          bc.used = true;
          saveUser(u);
        }
      }
      origHandler(req, res);
    };
  }

  // Expose middleware for other blocks / kernel global gate.
  if (deps) deps.requireAuth = requireAuth;
};
