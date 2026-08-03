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
const sessions = require('../../../kernel/server-utils/sessionValidator.cjs');

module.exports = (app, deps) => {
  const isVercel = require('../../../kernel/runtime.cjs').isCloud();
  const APP_ROOT = path.join(__dirname, '..', '..', '..', '..');
  const PORT = Number(process.env.PORT) || 3001;
  const {
    loadPolicy,
    savePolicy,
    loadUser,
    saveUser,
    hasAccount,
    guardActive,
    validateSession,
    revokeAllSessions,
    pruneIdleSessions,
  } = sessions;

  // Mirror the guard state into Settings so the nervous system (and the
  // kernel's own AuthGate) agree with the Guardian. Never bypass Settings.
  async function mirrorToSettings(policy, req) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (req?.headers?.authorization) headers.Authorization = req.headers.authorization;
      if (req?.headers?.cookie) headers.Cookie = req.headers.cookie;
      await fetch(`http://127.0.0.1:${PORT}/api/settings`, {
        method: 'POST', headers,
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

  // ── Walk-away watchdog — locks even when no requests arrive ─────────
  // Lifecycle-owned so a Security rescan tears the interval down (BO4 #6). Falls
  // back to a raw unref'd interval only on an older kernel that predates the
  // block lifecycle — there it is best-effort, exactly as before.
  if (!isVercel) {
    let _idleFlushed = false;
    const tick = () => {
      try {
        const p = loadPolicy();
        if (!guardActive(p)) return;
        const now = Date.now();
        const idleMs = Math.max(1, p.idleMinutes) * 60 * 1000;

        const revoked = pruneIdleSessions(p);
        // One flush per idle period, even if the browser is closed.
        if (now - sessions.getLastGlobalActivity() > idleMs) {
          if (!_idleFlushed) { _idleFlushed = true; if (revoked) console.log(`[GUARDIAN] Idle watchdog: ${revoked} session(s) locked.`); queueFlush('idle-watchdog'); }
        } else {
          _idleFlushed = false;
        }
      } catch {}
    };
    const watchdog = deps.lifecycle
      ? deps.lifecycle.setInterval(tick, 60 * 1000)
      : setInterval(tick, 60 * 1000);
    if (typeof watchdog.unref === 'function') watchdog.unref();
  }

  // ── The earlyware: shield headers + global guard ─────────────────────
  function guardian(req, res, next) {
    const p = loadPolicy();

    // 1. Deployment shield — data responses are never cacheable.
    if (p.shield && sessions.isGuardedPath(req.path)) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }

    // 2. Global guard — every data route needs a live session.
    if (!guardActive(p)) return next();
    if (!sessions.isGuardedPath(req.path)) return next();
    if (sessions.isPreAuthRequest(req)) return next();

    const v = validateSession(req, p);
    if (v.ok) return next();
    if (v.reason === 'idle') queueFlush('idle-lock');
    return sessions.unauthorized(res, v.reason);
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
    if (!v.ok) return sessions.unauthorized(res, v.reason);
    req.aeonSession = v;
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
      accountConfigured: hasAccount(),
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
    await mirrorToSettings(p, req);
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
    sessions.clearActivity();
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

  console.log('[GUARDIAN] Security 2.0 active — lock-on-launch, idle auto-lock, flush engine, deployment shield.');
};
