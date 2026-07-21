/**
 * AEON operator auth — kernel gate, serverless-safe (stateless HMAC tokens).
 *
 * Activation model (non-breaking, local-first):
 *   - No AEON_OPERATOR_PASSWORD env → gate is DORMANT. localhost dev unchanged.
 *   - Password set (the Vercel deployment always sets it) → every /api, /block,
 *     /core, /events request requires a bearer token except the allowlist.
 *
 * Token: "<expiresMs>.<hmac-sha256(expiresMs, secret)>" — no session store, so
 * it survives serverless cold starts. Secret = AEON_AUTH_SECRET or derived
 * from the password (so a rotated password invalidates all tokens).
 *
 * The single operator identity lives in AEON_OPERATOR_USER/PASSWORD (env) —
 * that's the real security boundary and stays serverless-safe (Vercel sets
 * it at deploy time, never through this API). secrets/aeon-user.json is a
 * richer LOCAL-ONLY mirror (display name, email, scrypt hash) for setup/
 * profile/change-password to read and write against — it never exists on
 * Vercel (read-only FS), which is fine: those three routes only ever run
 * during first-run desktop setup, gated by "no password configured yet".
 *
 * Contract (matches src/kernel/auth.js + AuthGate.jsx, do not change shapes):
 *   GET  /api/auth/status          → { configured, loginRequired, authenticated, user? }
 *   POST /api/auth/login           → { token } | 401
 *   POST /api/auth/logout          → { ok } (client drops the token; stateless server)
 *   POST /api/auth/setup           → { token, user } | 400 (first-run only, no auth required)
 *   POST /api/auth/profile         → { ok, user } | 401 (bearer required)
 *   POST /api/auth/change-password → { ok } | 401 (bearer + currentPassword required)
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const APP_ROOT = path.join(__dirname, '..', '..');
const ENV_FILE = path.join(APP_ROOT, '.env');
const USER_FILE = path.join(APP_ROOT, 'secrets', 'aeon-user.json');

const PASSWORD = () => process.env.AEON_OPERATOR_PASSWORD || '';
const USERNAME = () => process.env.AEON_OPERATOR_USER || 'operator';
const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000;
const PASSWORD_RULE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/; // matches the wizard's own hint

// ── Local profile file (username/displayName/email/passwordHash) ─────────
function readUserFile() {
  try { return JSON.parse(fs.readFileSync(USER_FILE, 'utf8')); } catch { return null; }
}
function writeUserFile(data) {
  fs.mkdirSync(path.dirname(USER_FILE), { recursive: true });
  const tmp = USER_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, USER_FILE);
}
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return { salt, hash };
}
function publicUser(u) {
  if (!u) return null;
  return { username: u.username, displayName: u.displayName || '', email: u.email || '' };
}

// ── .env writer (mirrors settings.js's writeEnvVars — kernel can't import a
// block, so this is intentionally a small standalone copy) ───────────────
function writeEnvVars(updates) {
  let lines = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8').split('\n') : [];
  const seen = new Set();
  lines = lines.map(line => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m && updates[m[1]] !== undefined) { seen.add(m[1]); return `${m[1]}=${updates[m[1]]}`; }
    return line;
  });
  for (const [k, v] of Object.entries(updates)) if (!seen.has(k)) lines.push(`${k}=${v}`);
  const tmp = ENV_FILE + '.tmp';
  fs.writeFileSync(tmp, lines.join('\n'), { mode: 0o600 });
  fs.renameSync(tmp, ENV_FILE);
  for (const [k, v] of Object.entries(updates)) process.env[k] = v; // live, no restart needed
}

const secret = () => process.env.AEON_AUTH_SECRET
  || crypto.createHash('sha256').update('aeon-auth:' + PASSWORD()).digest('hex');

const sign = (msg) => crypto.createHmac('sha256', secret()).update(String(msg)).digest('hex');

const mintToken = () => {
  const exp = Date.now() + TOKEN_TTL_MS;
  return `${exp}.${sign(exp)}`;
};

const verifyToken = (token) => {
  if (!token || typeof token !== 'string') return false;
  const [exp, mac] = token.split('.');
  if (!exp || !mac || Number(exp) < Date.now()) return false;
  const expect = sign(exp);
  try {
    return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect));
  } catch { return false; }
};

const timingSafeEq = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

const tokenFrom = (req) => {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  if (req.query && req.query.token) return String(req.query.token); // SSE can't set headers
  return null;
};

// Paths that must work unauthenticated (login flow + liveness).
const ALLOW = [/^\/api\/auth\//, /^\/api\/health$/];

// Brute-force damper: per-process fail counter (resets on cold start — fine,
// it only needs to make online guessing expensive, the password is random).
let fails = 0;
let lockUntil = 0;

function mountAuth(app) {
  app.get('/api/auth/status', (req, res) => {
    const configured = !!PASSWORD();
    const authed = configured ? verifyToken(tokenFrom(req)) : true;
    res.json({
      configured,
      loginRequired: configured,
      authenticated: authed,
      user: authed ? (publicUser(readUserFile()) || { username: USERNAME(), displayName: '', email: '' }) : undefined,
    });
  });

  app.post('/api/auth/login', (req, res) => {
    if (!PASSWORD()) return res.status(400).json({ error: 'No operator account configured.' });
    if (Date.now() < lockUntil) return res.status(429).json({ error: 'Too many attempts. Wait a minute.' });
    const { username, password } = req.body || {};
    const ok = timingSafeEq(username || '', USERNAME()) && timingSafeEq(password || '', PASSWORD());
    if (!ok) {
      fails++;
      if (fails >= 8) { lockUntil = Date.now() + 60_000; fails = 0; }
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
    fails = 0;
    res.json({ token: mintToken(), user: USERNAME() });
  });

  app.post('/api/auth/logout', (_req, res) => res.json({ ok: true }));

  // First-run only — locked the moment a password exists, so this can never
  // become a remote account-takeover vector on an already-configured instance.
  app.post('/api/auth/setup', (req, res) => {
    if (PASSWORD()) return res.status(400).json({ error: 'Account already configured.' });
    const { username, displayName, email, password } = req.body || {};
    if (!username || !String(username).trim()) return res.status(400).json({ error: 'Username is required.' });
    if (!PASSWORD_RULE.test(password || '')) return res.status(400).json({ error: 'Password needs 8+ characters with upper, lower, and a number.' });
    if (process.env.VERCEL) return res.status(400).json({ error: 'Set AEON_OPERATOR_PASSWORD in your deployment env instead — this instance has no writable filesystem.' });

    const user = { username: String(username).trim(), displayName: displayName || '', email: email || '', passwordHash: hashPassword(password) };
    try {
      writeUserFile(user);
      writeEnvVars({ AEON_OPERATOR_USER: user.username, AEON_OPERATOR_PASSWORD: password });
    } catch (e) {
      return res.status(500).json({ error: 'Could not save account: ' + e.message });
    }
    res.json({ token: mintToken(), user: publicUser(user) });
  });

  app.post('/api/auth/profile', (req, res) => {
    if (!verifyToken(tokenFrom(req))) return res.status(401).json({ error: 'Authentication required.' });
    const { displayName, email } = req.body || {};
    const existing = readUserFile() || { username: USERNAME(), passwordHash: null };
    const updated = { ...existing, displayName: displayName ?? existing.displayName ?? '', email: email ?? existing.email ?? '' };
    try { writeUserFile(updated); } catch (e) { return res.status(500).json({ error: 'Could not save profile: ' + e.message }); }
    res.json({ ok: true, user: publicUser(updated) });
  });

  app.post('/api/auth/change-password', (req, res) => {
    if (!verifyToken(tokenFrom(req))) return res.status(401).json({ error: 'Authentication required.' });
    const { currentPassword, newPassword } = req.body || {};
    if (!timingSafeEq(currentPassword || '', PASSWORD())) return res.status(401).json({ error: 'Current password is incorrect.' });
    if (!PASSWORD_RULE.test(newPassword || '')) return res.status(400).json({ error: 'New password needs 8+ characters with upper, lower, and a number.' });
    if (process.env.VERCEL) return res.status(400).json({ error: 'Rotate AEON_OPERATOR_PASSWORD in your deployment env instead — this instance has no writable filesystem.' });

    const existing = readUserFile() || { username: USERNAME() };
    try {
      writeUserFile({ ...existing, passwordHash: hashPassword(newPassword) });
      writeEnvVars({ AEON_OPERATOR_PASSWORD: newPassword });
    } catch (e) {
      return res.status(500).json({ error: 'Could not change password: ' + e.message });
    }
    // Rotating the password changes secret()'s derivation, so every existing
    // token (including the one on this request) is now invalid — expected.
    res.json({ ok: true });
  });
}

// The gate itself — mount BEFORE any block/kernel routes.
function guard(req, res, next) {
  if (!PASSWORD()) return next();                     // dormant
  if (req.method === 'OPTIONS') return next();        // CORS preflight
  const p = req.path;
  const gated = p.startsWith('/api/') || p.startsWith('/block/')
    || p.startsWith('/core') || p.startsWith('/events');
  if (!gated) return next();                          // static frontend passes
  if (ALLOW.some(rx => rx.test(p))) return next();
  if (verifyToken(tokenFrom(req))) return next();
  res.status(401).json({ error: 'Authentication required.', hint: 'POST /api/auth/login' });
}

module.exports = { mountAuth, guard, verifyToken, mintToken };
