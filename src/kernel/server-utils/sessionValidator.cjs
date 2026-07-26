const fs = require('fs');
const path = require('path');
const storage = require('../../../services/storage.js');

const DEFAULT_POLICY = Object.freeze({
  guardEnabled: false,
  lockEveryLaunch: true,
  idleMinutes: 5,
  flushOnLock: true,
  shield: true,
  bootSequence: false,
  lockedAt: 0,
  lastFlush: null,
  updatedAt: null,
});

const PRE_AUTH_ROUTES = Object.freeze([
  /^\/public\//,
  /^\/api\/auth\/login$/,
  /^\/api\/auth\/status$/,
  /^\/api\/kernel\/security-availability$/,
  /^\/api\/security\/otp\/send$/,
  /^\/api\/security\/cloud\/.*/,
  /^\/api\/security\/oauth\/.*/,
  /^\/api\/security\/restart$/,
  /^\/api\/security\/recovery\/.*/,
]);

function createSessionValidator(options = {}) {
  const securityDir = options.securityDir || storage.getVaultFile(path.join('blocks', 'security'));
  const policyFile = path.join(securityDir, 'policy.json');
  const authFile = path.join(securityDir, 'local_auth.json');
  const legacyUserFile = options.legacyUserFile === undefined
    ? path.join(storage.ROOT, 'secrets', 'aeon-user.json')
    : options.legacyUserFile;
  const bootTime = options.bootTime || Date.now();
  const activity = new Map();
  let lastGlobalActivity = bootTime;

  function readJson(file) {
    if (!file || !fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      console.warn(`[AUTH] Could not read ${file}: ${error.message}`);
      return null;
    }
  }

  function writeJsonAtomic(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tempFile = `${file}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(tempFile, file);
  }

  function normalizeUser(user) {
    if (!user || typeof user !== 'object') return null;
    const normalized = { ...user, sessions: { ...(user.sessions || {}) } };
    if (!normalized.passHash && normalized.passwordHash?.hash) {
      normalized.salt = normalized.passwordHash.salt;
      normalized.passHash = normalized.passwordHash.hash;
    }
    delete normalized.passwordHash;
    if (normalized.authMode === 'cloud' && normalized.email) return normalized;
    return normalized.salt && normalized.passHash ? normalized : null;
  }

  function writeLegacyProfile(user) {
    if (!legacyUserFile) return;
    writeJsonAtomic(legacyUserFile, {
      username: user.username,
      displayName: user.displayName || '',
      email: user.email || '',
      role: user.role || 'operator',
      createdAt: user.createdAt || null,
      updatedAt: user.updatedAt || user.createdAt || null,
      credentialStore: 'Vault/blocks/security/local_auth.json',
    });
  }

  function loadPolicy() {
    return { ...DEFAULT_POLICY, ...(readJson(policyFile) || {}) };
  }

  function savePolicy(policy) {
    const next = {
      ...DEFAULT_POLICY,
      ...policy,
      updatedAt: new Date().toISOString(),
    };
    writeJsonAtomic(policyFile, next);
    return next;
  }

  function saveUser(user) {
    const normalized = normalizeUser(user);
    if (!normalized) throw new Error('Auth state requires a cloud identity or a salted password hash');
    writeJsonAtomic(authFile, normalized);
    writeLegacyProfile(normalized);
    return normalized;
  }

  function loadUser() {
    const current = normalizeUser(readJson(authFile));
    if (current) return current;

    const legacy = normalizeUser(readJson(legacyUserFile));
    if (!legacy) return null;

    saveUser(legacy);
    if (!fs.existsSync(policyFile)) {
      savePolicy({ ...DEFAULT_POLICY, guardEnabled: true });
    }
    console.log('[AUTH] Migrated legacy credentials into Vault/blocks/security/local_auth.json');
    return legacy;
  }

  function hasAccount() {
    return !!loadUser();
  }

  function guardActive(policy = loadPolicy()) {
    return !!policy.guardEnabled && hasAccount();
  }

  function getToken(req) {
    const authorization = req.headers?.authorization || '';
    if (authorization.startsWith('Bearer ')) return authorization.slice(7).trim();
    if (req.query?.token) return String(req.query.token);
    const match = (req.headers?.cookie || '').match(/(?:^|;\s*)aeon_session=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  function isMachineSession(req) {
    const mobileSecret = options.mobileSecret === undefined
      ? process.env.AEON_MOBILE_SECRET
      : options.mobileSecret;
    return !!mobileSecret && req.headers?.authorization === `Bearer ${mobileSecret}`;
  }

  function validateSession(req, policy = loadPolicy()) {
    if (isMachineSession(req)) {
      lastGlobalActivity = Date.now();
      return { ok: true, kind: 'machine', user: { username: 'system', role: 'machine' } };
    }

    const token = getToken(req);
    if (!token) return { ok: false, reason: 'no-session' };

    const user = loadUser();
    const meta = user?.sessions?.[token];
    if (!meta) return { ok: false, reason: 'no-session' };

    const now = Date.now();
    if (!meta.expires || meta.expires < now) {
      delete user.sessions[token];
      saveUser(user);
      activity.delete(token);
      return { ok: false, reason: 'expired' };
    }
    if (policy.lockEveryLaunch && (meta.created || 0) < bootTime) {
      return { ok: false, reason: 'stale-boot' };
    }
    if ((meta.created || 0) < (policy.lockedAt || 0)) {
      return { ok: false, reason: 'locked' };
    }

    const idleMs = Math.max(1, Number(policy.idleMinutes) || 5) * 60 * 1000;
    const lastSeen = Math.max(meta.lastSeen || meta.created || 0, activity.get(token) || 0);
    if (now - lastSeen > idleMs) {
      delete user.sessions[token];
      saveUser(user);
      activity.delete(token);
      return { ok: false, reason: 'idle' };
    }

    activity.set(token, now);
    lastGlobalActivity = now;
    if (now - (meta.lastSeen || 0) > 30_000) {
      meta.lastSeen = now;
      saveUser(user);
    }
    return { ok: true, kind: 'session', user, token, meta };
  }

  function revokeAllSessions() {
    const user = loadUser();
    if (user) {
      user.sessions = {};
      saveUser(user);
    }
    activity.clear();
  }

  function pruneIdleSessions(policy = loadPolicy()) {
    const user = loadUser();
    if (!user?.sessions) return 0;

    const now = Date.now();
    const idleMs = Math.max(1, Number(policy.idleMinutes) || 5) * 60 * 1000;
    let revoked = 0;
    for (const [token, meta] of Object.entries(user.sessions)) {
      const lastSeen = Math.max(meta.lastSeen || meta.created || 0, activity.get(token) || 0);
      if (!meta.expires || meta.expires < now || now - lastSeen > idleMs) {
        delete user.sessions[token];
        activity.delete(token);
        revoked++;
      }
    }
    if (revoked) saveUser(user);
    return revoked;
  }

  function isPreAuthRequest(req) {
    if (req.method === 'OPTIONS') return true;
    if (req.path === '/' || req.path === '/api/health') return true;
    if (req.method === 'GET' && req.path === '/api/security/policy') return true;
    if (req.path === '/api/auth/setup' && !hasAccount()) return true;
    return PRE_AUTH_ROUTES.some((pattern) => pattern.test(req.path));
  }

  function isGuardedPath(requestPath) {
    return /^\/(api|block|core|events|ws)\b/.test(requestPath);
  }

  function unauthorized(res, reason = 'no-session') {
    return res.status(401).json({
      success: false,
      error: 'UNAUTHORIZED_SESSION',
      requires_auth: true,
      reason,
    });
  }

  return {
    DEFAULT_POLICY,
    PRE_AUTH_ROUTES,
    SECURITY_DIR: securityDir,
    POLICY_FILE: policyFile,
    AUTH_FILE: authFile,
    BOOT_TIME: bootTime,
    loadPolicy,
    savePolicy,
    loadUser,
    saveUser,
    hasAccount,
    guardActive,
    getToken,
    validateSession,
    revokeAllSessions,
    pruneIdleSessions,
    isPreAuthRequest,
    isGuardedPath,
    unauthorized,
    getLastGlobalActivity: () => lastGlobalActivity,
    clearActivity: () => activity.clear(),
  };
}

const validator = createSessionValidator();

module.exports = {
  ...validator,
  createSessionValidator,
  DEFAULT_POLICY,
  PRE_AUTH_ROUTES,
};
