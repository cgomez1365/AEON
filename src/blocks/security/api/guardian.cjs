/**
 * AEON Security 2.0 — The Guardian.
 *
 * The auth core (security.js) knows WHO you are. The Guardian decides WHEN
 * you must prove it again, and what happens to your data when you walk away.
 *
 *   • Lock on every launch  — stolen-laptop defense: sessions from a previous
 *     boot are dead; double-clicking AEON always asks for the password.
 *   • Idle auto-lock        — walk-away defense (doctor / library / HR desk):
 *     no activity for N minutes → session revoked, next click hits the gate.
 *   • Session-end flush     — sensitive local stores encrypted and pushed to
 *     the user's own Supabase on lock/idle/logout; cloud runtimes also purge
 *     temp caches. Local-only installs skip the push, never the lock.
 *   • Deployment shield     — every /api and /block response carries
 *     Cache-Control: no-store, so Vercel/Cloudflare/any CDN in front of a
 *     personal deployment can never cache valuable data.
 *
 * Enforcement uses the kernel's registerEarlyMiddleware hook (manifest
 * permission `middleware: "early"`), so the guard sees every request no
 * matter when this cartridge was mounted. Policy mirrors into Settings
 * (prefs.require_login) — the nervous system stays the single truth.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BOOT_TIME = Date.now();

module.exports = (app, deps) => {
  const isVercel = !!process.env.VERCEL;
  const APP_ROOT = path.join(__dirname, '..', '..', '..', '..');
  const USER_FILE = path.join(APP_ROOT, 'secrets', 'aeon-user.json');
  const getDataFile = deps.getDataFile || ((rel) => path.join(APP_ROOT, 'data', rel));
  const POLICY_DIR = getDataFile('security');
  const POLICY_FILE = path.join(POLICY_DIR, 'policy.json');
  try { fs.mkdirSync(POLICY_DIR, { recursive: true }); } catch {}

  const PORT = Number(process.env.PORT) || 3001;

  const DEFAULT_POLICY = {
    guardEnabled: null,        // null = auto: on once an account exists
    lockEveryLaunch: true,     // password every time AEON opens
    idleMinutes: 5,            // walk-away lock
    flushOnLock: true,         // sync-then-forget on lock/idle/logout
    shield: true,              // no-store cache headers on data routes
    lockedAt: 0,               // lock-now stamp: tokens created before this are dead
    lastFlush: null,
    updatedAt: null,
  };

  // ── Policy store ────────────────────────────────────────────────────
  function loadPolicy() {
    try { return { ...DEFAULT_POLICY, ...JSON.parse(fs.readFileSync(POLICY_FILE, 'utf8')) }; }
    catch { return { ...DEFAULT_POLICY }; }
  }
  function savePolicy(p) {
    p.updatedAt = new Date().toISOString();
    fs.writeFileSync(POLICY_FILE, JSON.stringify(p, null, 2));
    return p;
  }

  function loadUser() {
    try { return JSON.parse(fs.readFileSync(USER_FILE, 'utf8')); } catch { return null; }
  }
  function saveUser(u) {
    fs.writeFileSync(USER_FILE, JSON.stringify(u, null, 2), { mode: 0o600 });
  }

  function hasAccount() {
    // Either identity system counts: the kernel's env-based operator
    // (AEON_OPERATOR_PASSWORD) or this block's local user file.
    return !!process.env.AEON_OPERATOR_PASSWORD || !!loadUser();
  }
  function guardActive(policy) {
    const p = policy || loadPolicy();
    return p.guardEnabled === null ? hasAccount() : (!!p.guardEnabled && hasAccount());
  }

  // Mirror the guard state into Settings so the nervous system (and the
  // kernel's own AuthGate) agree with the Guardian. Never bypass Settings.
  async function mirrorToSettings(policy) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/api/settings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patch: { prefs: {
          require_login: guardActive(policy),
          security_idle_minutes: policy.idleMinutes,
          security_lock_every_launch: policy.lockEveryLaunch,
        } } }),
      });
    } catch { /* settings block not mounted yet at boot — retried on next save */ }
  }

  // ── Boot revoke — stolen-laptop defense ─────────────────────────────
  // Any session created before this process started is invalid when
  // lockEveryLaunch is on. Enforced statelessly by timestamp comparison,
  // and eagerly here so the file on disk holds no live tokens either.
  (function bootRevoke() {
    const p = loadPolicy();
    if (!p.lockEveryLaunch) return;
    const u = loadUser();
    if (u && u.sessions && Object.keys(u.sessions).length) {
      u.sessions = {};
      saveUser(u);
      console.log('[GUARDIAN] Boot revoke: all previous sessions cleared (lock-every-launch).');
    }
  })();

  // ── Session validation (shares aeon-user.json with the auth core) ───
  function getToken(req) {
    const h = req.headers.authorization || '';
    if (h.startsWith('Bearer ')) return h.slice(7).trim();
    if (req.query && req.query.token) return String(req.query.token); // SSE can't set headers
    const m = (req.headers.cookie || '').match(/(?:^|;\s*)aeon_session=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  // Two token families pass through here:
  //   • Block sessions (aeon-user.json) — stateful, revocable on disk.
  //   • Kernel HMAC tokens ("exp.mac", TTL 7d) — stateless; the Guardian
  //     applies POLICY only (boot-freshness, idle, lock stamp) and leaves
  //     signature verification to the kernel gate later in the chain, so a
  //     forged exp dies there. Creation time = exp − TTL.
  const KERNEL_TOKEN_TTL_MS = 7 * 24 * 3600 * 1000; // mirrors kernel authGate
  const tokenActivity = new Map();                   // kernel token → { lastSeen }
  let _lastGlobalActivity = Date.now();
  let _lastTouchWrite = 0;

  function validateSession(req, policy) {
    const token = getToken(req);
    if (!token) return { ok: false, reason: 'no-session' };
    const now = Date.now();
    const idleMs = Math.max(1, policy.idleMinutes) * 60 * 1000;

    // Path A: stateful block session
    const u = loadUser();
    const meta = u && u.sessions && u.sessions[token];
    if (meta) {
      if (!meta.expires || meta.expires < now) return { ok: false, reason: 'expired' };
      if (policy.lockEveryLaunch && (meta.created || 0) < BOOT_TIME) return { ok: false, reason: 'stale-boot' };
      if ((meta.created || 0) < (policy.lockedAt || 0)) return { ok: false, reason: 'locked' };
      const lastSeen = meta.lastSeen || meta.created || 0;
      if (now - lastSeen > idleMs) {
        delete u.sessions[token]; saveUser(u); queueFlush('idle-lock');
        return { ok: false, reason: 'idle' };
      }
      meta.lastSeen = now; _lastGlobalActivity = now;
      if (now - _lastTouchWrite > 30_000) { _lastTouchWrite = now; saveUser(u); }
      return { ok: true, kind: 'session' };
    }

    // Path B: stateless kernel token — policy checks only
    const dot = token.indexOf('.');
    if (dot > 0) {
      const exp = Number(token.slice(0, dot));
      if (Number.isFinite(exp) && exp > now) {
        const created = exp - KERNEL_TOKEN_TTL_MS;
        if (policy.lockEveryLaunch && created < BOOT_TIME) return { ok: false, reason: 'stale-boot' };
        if (created < (policy.lockedAt || 0)) return { ok: false, reason: 'locked' };
        const act = tokenActivity.get(token) || { lastSeen: now };
        if (now - act.lastSeen > idleMs) {
          tokenActivity.delete(token); queueFlush('idle-lock');
          return { ok: false, reason: 'idle' };
        }
        act.lastSeen = now; tokenActivity.set(token, act); _lastGlobalActivity = now;
        return { ok: true, kind: 'kernel' };
      }
      if (Number.isFinite(exp)) return { ok: false, reason: 'expired' };
    }
    return { ok: false, reason: 'no-session' };
  }

  // ── Flush engine — sync-then-forget ─────────────────────────────────
  // Encrypts the sensitive local stores with the vault master key and
  // upserts one blob to the user's OWN Supabase (aeon_secure_flush).
  // No Supabase configured → the lock still happens, the push is skipped.
  const SENSITIVE_STORES = [
    'db/chat_log.json',
    'db/aeon_notes.json',
    'db/aeon_terminal_history.json',
    'db/aeon_ats.json',
    'db/clients.json',
  ];

  function encryptBlob(obj) {
    const raw = process.env.AEON_VAULT_MASTER_KEY;
    if (!raw) return { plain: true, data: obj };
    const key = crypto.createHash('sha256').update(String(raw)).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
    return { v: 1, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('hex') };
  }

  let _flushing = false;
  async function flushNow(reason) {
    if (_flushing) return { ok: false, skipped: 'already-flushing' };
    _flushing = true;
    try {
      const p = loadPolicy();
      const payload = {};
      for (const rel of SENSITIVE_STORES) {
        try {
          const fp = path.join(APP_ROOT, rel);
          if (fs.existsSync(fp) && fs.statSync(fp).size < 5 * 1024 * 1024) {
            payload[rel] = JSON.parse(fs.readFileSync(fp, 'utf8'));
          }
        } catch {}
      }
      let pushed = false;
      if (deps.supabase) {
        try {
          const blob = encryptBlob(payload);
          const { error } = await deps.supabase.from('aeon_secure_flush')
            .upsert({ id: 1, blob, reason, flushed_at: new Date().toISOString() });
          pushed = !error;
          if (error) console.warn('[GUARDIAN] Flush push failed:', error.message);
        } catch (e) { console.warn('[GUARDIAN] Flush push failed:', e.message); }
      }
      // Cloud runtime: purge temp caches so the host keeps nothing readable.
      if (isVercel) {
        try {
          for (const f of fs.readdirSync('/tmp')) {
            try { fs.rmSync(path.join('/tmp', f), { recursive: true, force: true }); } catch {}
          }
        } catch {}
      }
      p.lastFlush = { at: new Date().toISOString(), reason, stores: Object.keys(payload).length, pushed };
      savePolicy(p);
      if (deps.writeOSAudit) { try { deps.writeOSAudit('GUARDIAN_FLUSH', `${reason} (${Object.keys(payload).length} stores, pushed=${pushed})`, 200, 0); } catch {} }
      return { ok: true, ...p.lastFlush };
    } finally { _flushing = false; }
  }
  let _flushQueued = false;
  function queueFlush(reason) {
    const p = loadPolicy();
    if (!p.flushOnLock || _flushQueued) return;
    _flushQueued = true;
    setTimeout(() => { flushNow(reason).finally(() => { _flushQueued = false; }); }, 100);
  }

  function revokeAllSessions() {
    const u = loadUser();
    if (u) { u.sessions = {}; saveUser(u); }
  }

  // ── Walk-away watchdog — locks even when no requests arrive ─────────
  if (!isVercel) {
    let _idleFlushed = false;
    const watchdog = setInterval(() => {
      try {
        const p = loadPolicy();
        if (!guardActive(p)) return;
        const now = Date.now();
        const idleMs = Math.max(1, p.idleMinutes) * 60 * 1000;

        // Stateful block sessions: revoke on disk.
        const u = loadUser();
        let revoked = 0;
        if (u && u.sessions) {
          for (const [tok, meta] of Object.entries(u.sessions)) {
            const lastSeen = meta.lastSeen || meta.created || 0;
            if (now - lastSeen > idleMs) { delete u.sessions[tok]; revoked++; }
          }
          if (revoked) saveUser(u);
        }
        // Stateless kernel tokens: forget their activity records.
        for (const [tok, act] of tokenActivity) {
          if (now - act.lastSeen > idleMs) { tokenActivity.delete(tok); revoked++; }
        }
        // One flush per idle period, even if the browser is closed.
        if (now - _lastGlobalActivity > idleMs) {
          if (!_idleFlushed) { _idleFlushed = true; if (revoked) console.log(`[GUARDIAN] Idle watchdog: ${revoked} session(s) locked.`); queueFlush('idle-watchdog'); }
        } else {
          _idleFlushed = false;
        }
      } catch {}
    }, 60 * 1000);
    watchdog.unref();
  }

  // ── The earlyware: shield headers + global guard ─────────────────────
  // Paths that must stay reachable while locked (the gate itself).
  const OPEN_PATHS = [
    /^\/api\/auth\//,            // login, status, setup, 2FA
    /^\/api\/security\/otp\//,   // email OTP rescue
    /^\/api\/security\/policy$/, // the gate itself needs to read idleMinutes/
                                  // lockEveryLaunch/bootSequence while locked
                                  // to render correctly. Writes (POST) stay
                                  // protected by that route's own requireSession.
    /^\/$/,                      // health check
  ];
  const GUARDED_PREFIX = /^\/(api|block|core|events)\b/;

  function guardian(req, res, next) {
    const p = loadPolicy();

    // 1. Deployment shield — data responses are never cacheable.
    if (p.shield && GUARDED_PREFIX.test(req.path)) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }

    // 2. Global guard — every data route needs a live session.
    if (!guardActive(p)) return next();
    if (!GUARDED_PREFIX.test(req.path)) return next();          // static UI loads; AuthGate does the asking
    if (OPEN_PATHS.some(rx => rx.test(req.path))) return next();
    if (process.env.AEON_MOBILE_SECRET &&
        req.headers.authorization === `Bearer ${process.env.AEON_MOBILE_SECRET}`) return next();

    const v = validateSession(req, p);
    if (v.ok) return next();
    return res.status(401).json({
      error: 'AEON is locked. Sign in to continue.',
      locked: true, reason: v.reason,
    });
  }

  if (typeof deps.registerEarlyMiddleware === 'function') {
    deps.registerEarlyMiddleware(guardian, 'security-guardian');
  } else {
    // Older kernel without the hook: still guards everything mounted after us.
    app.use(guardian);
    console.warn('[GUARDIAN] Kernel earlyware hook missing — guard coverage is partial. Update AEON.');
  }

  // ── Policy + control endpoints ──────────────────────────────────────
  function requireSession(req, res, next) {
    const p = loadPolicy();
    if (!hasAccount()) return res.status(409).json({ error: 'Create your account first (Security → Set up).' });
    const v = validateSession(req, p);
    if (!v.ok) return res.status(401).json({ error: 'Sign in required.', locked: true, reason: v.reason });
    next();
  }

  app.get('/api/security/policy', (req, res) => {
    const p = loadPolicy();
    res.json({
      ok: true,
      policy: {
        guardEnabled: guardActive(p),
        lockEveryLaunch: p.lockEveryLaunch,
        idleMinutes: p.idleMinutes,
        flushOnLock: p.flushOnLock,
        shield: p.shield,
        bootSequence: !!p.bootSequence,
      },
      accountConfigured: !!loadUser(),
      lastFlush: p.lastFlush,
      runtime: isVercel ? 'cloud' : 'local',
      syncConfigured: !!deps.supabase,
      earlywareActive: typeof deps.registerEarlyMiddleware === 'function',
    });
  });

  app.post('/api/security/policy', requireSession, async (req, res) => {
    const p = loadPolicy();
    const b = req.body || {};
    if (b.guardEnabled !== undefined) p.guardEnabled = !!b.guardEnabled;
    if (b.lockEveryLaunch !== undefined) p.lockEveryLaunch = !!b.lockEveryLaunch;
    if (b.idleMinutes !== undefined) p.idleMinutes = Math.min(240, Math.max(1, Number(b.idleMinutes) || 5));
    if (b.flushOnLock !== undefined) p.flushOnLock = !!b.flushOnLock;
    if (b.shield !== undefined) p.shield = !!b.shield;
    if (b.bootSequence !== undefined) p.bootSequence = !!b.bootSequence;
    savePolicy(p);
    await mirrorToSettings(p);
    if (deps.writeOSAudit) { try { deps.writeOSAudit('GUARDIAN_POLICY', JSON.stringify(b).slice(0, 200), 200, 0); } catch {} }
    res.json({ ok: true, policy: p });
  });

  // Lock now — revoke everything; flush if the policy says so.
  // The lockedAt stamp also kills stateless kernel tokens: anything minted
  // before this moment is refused until the user signs in again.
  app.post('/api/security/lock', requireSession, async (req, res) => {
    const p = loadPolicy();
    p.lockedAt = Date.now();
    savePolicy(p);
    revokeAllSessions();
    tokenActivity.clear();
    let flush = null;
    if (p.flushOnLock) flush = await flushNow('manual-lock');
    res.setHeader('Set-Cookie', 'aeon_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    res.json({ ok: true, text: 'AEON locked. All sessions revoked.' + (flush?.pushed ? ' Data synced to your cloud.' : ''), flush });
  });

  app.post('/api/security/flush', requireSession, async (req, res) => {
    const r = await flushNow('manual');
    res.json({ ...r, text: r.ok ? `Flushed ${r.stores} store(s)${r.pushed ? ' → synced to your Supabase' : ' (no cloud configured — local lock only)'}.` : 'Flush already running.' });
  });

  app.post('/api/security/heartbeat', (req, res) => {
    const p = loadPolicy();
    const v = validateSession(req, p); // touches lastSeen when valid
    res.json({ ok: v.ok, locked: !v.ok });
  });

  app.get('/api/security/shield', (req, res) => {
    const p = loadPolicy();
    res.json({
      ok: true,
      shield: p.shield,
      runtime: isVercel ? 'cloud' : 'local',
      coverage: typeof deps.registerEarlyMiddleware === 'function' ? 'all routes' : 'partial (kernel hook missing)',
      headers: p.shield ? 'Cache-Control: no-store on /api, /block, /core, /events' : 'disabled',
      note: 'On personal deployments (Vercel, Cloudflare, tunnels) the shield stops any CDN or edge cache from storing your data.',
    });
  });

  // ── Email OTP rescue via the user's own Supabase (free tier) ────────
  // Optional second factor / recovery path. Uses Supabase GoTrue magic-code.
  const SB_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const SB_ANON = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

  app.post('/api/security/otp/send', async (req, res) => {
    if (!SB_URL || !SB_ANON) return res.status(501).json({ error: 'Email codes need Supabase — add SUPABASE_URL + anon key in Settings → Connections (free at supabase.com).' });
    const u = loadUser();
    const email = (req.body && req.body.email) || (u && u.email);
    if (!email) return res.status(400).json({ error: 'No email on file. Add one in Security → Profile.' });
    try {
      const r = await fetch(`${SB_URL}/auth/v1/otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SB_ANON },
        body: JSON.stringify({ email, create_user: true }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.msg || d.error_description || `Supabase ${r.status}`); }
      res.json({ ok: true, text: `Code sent to ${email}. It expires in a few minutes.` });
    } catch (e) { res.status(502).json({ error: 'Could not send code: ' + e.message }); }
  });

  app.post('/api/security/otp/verify', async (req, res) => {
    if (!SB_URL || !SB_ANON) return res.status(501).json({ error: 'Email codes need Supabase configured in Settings.' });
    const u = loadUser();
    const { code, email } = req.body || {};
    const addr = email || (u && u.email);
    if (!addr || !code) return res.status(400).json({ error: 'email and code required' });
    try {
      const r = await fetch(`${SB_URL}/auth/v1/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SB_ANON },
        body: JSON.stringify({ type: 'email', email: addr, token: String(code).trim() }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.access_token) return res.status(401).json({ error: 'Invalid or expired code.' });
      res.json({ ok: true, verified: true });
    } catch (e) { res.status(502).json({ error: 'Verification failed: ' + e.message }); }
  });

  console.log('[GUARDIAN] Security 2.0 active — lock-on-launch, idle auto-lock, flush engine, deployment shield.');
};
