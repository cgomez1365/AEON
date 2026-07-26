const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sessions = require('../../../kernel/server-utils/sessionValidator.cjs');

const OTP_TTL_MS = 120_000;
const RESEND_COOLDOWN_MS = 60_000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MIGRATION_TTL_MS = 5 * 60 * 1000;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

module.exports = (app, deps) => {
  const sessionStore = deps && Object.prototype.hasOwnProperty.call(deps, 'sessionValidator')
    ? deps.sessionValidator
    : sessions;
  const securityDir = deps.getVaultFile(path.join('blocks', 'security'));
  const oauthConfigFile = path.join(securityDir, 'oauth_config.json');
  const stateFile = path.join(securityDir, 'state.json');
  const now = deps && Object.prototype.hasOwnProperty.call(deps, 'now')
    ? deps.now
    : () => Date.now();

  function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return fallback; }
  }

  function atomicWrite(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  function loadOAuthConfig() {
    return readJson(oauthConfigFile, null);
  }

  function loadState() {
    const blob = readJson(stateFile, null);
    if (!blob) return {};
    try { return deps.vaultUnseal(blob); }
    catch { return {}; }
  }

  function saveState(value) {
    atomicWrite(stateFile, deps.vaultSeal(value));
  }

  // Constant-time verify of a local account's scrypt password — mirrors the
  // hash in security.js (scrypt(password, salt, 64)). Used only by the
  // authenticated migration flow to re-verify the current operator.
  function verifyLocalPassword(user, password) {
    if (!user || !user.salt || !user.passHash) return false;
    const actual = crypto.scryptSync(String(password || ''), user.salt, 64);
    const expected = Buffer.from(user.passHash, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }

  const bootStartedAt = Date.now() - Math.floor(process.uptime() * 1000);
  const bootState = loadState();
  if (bootState.restartRequired && bootStartedAt > Number(bootState.verifiedAt || 0)) {
    bootState.restartRequired = false;
    bootState.restartedAt = Date.now();
    saveState(bootState);
  }
  global.__AEON_SECURITY_RESTART_REQUIRED = !!bootState.restartRequired;

  function providerMetadata() {
    return typeof deps.getCloudProviderMetadata === 'function'
      ? deps.getCloudProviderMetadata()
      : { active: [], supabase: { configured: false }, firebase: { configured: false } };
  }

  function lockedProvider() {
    const config = loadOAuthConfig();
    return config?.is_locked ? config.provider : null;
  }

  function productionAdapter(provider) {
    const credentials = typeof deps.getCloudCredentials === 'function'
      ? deps.getCloudCredentials(provider)
      : null;
    if (provider === 'supabase') {
      if (!credentials?.url || !credentials?.anonKey) {
        throw Object.assign(new Error('Supabase credentials are not available in Settings'), { statusCode: 409 });
      }
      return {
        async send(email) {
          const response = await fetch(`${credentials.url}/auth/v1/otp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', apikey: credentials.anonKey },
            body: JSON.stringify({ email, create_user: true, options: { emailRedirectTo: null } }),
            signal: AbortSignal.timeout(10_000),
          });
          if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw Object.assign(
              new Error(body.msg || body.error_description || `Supabase HTTP ${response.status}`),
              { statusCode: 502 },
            );
          }
        },
        async verify(email, code) {
          const response = await fetch(`${credentials.url}/auth/v1/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', apikey: credentials.anonKey },
            body: JSON.stringify({ type: 'email', email, token: code }),
            signal: AbortSignal.timeout(10_000),
          });
          const body = await response.json().catch(() => ({}));
          return response.ok && !!body.access_token;
        },
      };
    }
    throw Object.assign(
      new Error('Firebase Web Config cannot send a numeric email OTP by itself. Configure a server-side Firebase numeric-email sender before locking this provider.'),
      { statusCode: 501, code: 'FIREBASE_NUMERIC_OTP_UNAVAILABLE' },
    );
  }

  function adapter(provider) {
    if (deps && Object.prototype.hasOwnProperty.call(deps, 'cloudOtpAdapter')) {
      return deps.cloudOtpAdapter(provider);
    }
    return productionAdapter(provider);
  }

  app.get('/api/security/cloud/status', (req, res) => {
    const metadata = providerMetadata();
    const config = loadOAuthConfig();
    const state = loadState();
    res.json({
      available: metadata.active || [],
      providers: metadata,
      selectedProvider: config?.provider || null,
      isLocked: config?.is_locked === true,
      lockedAt: config?.lockedAt || null,
      emailVerified: !!state.emailVerified,
      verifiedEmail: state.emailVerified ? state.verifiedEmail : null,
      restartRequired: !!state.restartRequired,
      pendingOtp: state.pendingOtp
        ? {
            expiresAt: state.pendingOtp.expiresAt,
            resendAt: state.pendingOtp.resendAt,
            email: state.pendingOtp.email,
          }
        : null,
    });
  });

  app.post('/api/security/cloud/lock', (req, res) => {
    const provider = String(req.body?.provider || '').toLowerCase();
    const metadata = providerMetadata();
    if (!['supabase', 'firebase'].includes(provider) || !metadata.active?.includes(provider)) {
      return res.status(400).json({ error: 'Select a configured cloud provider from Settings' });
    }
    const current = loadOAuthConfig();
    if (current?.is_locked && current.provider !== provider) {
      return res.status(423).json({
        error: `OAuth provider is locked to ${current.provider}`,
        code: 'OAUTH_PROVIDER_LOCKED',
      });
    }
    if (current?.is_locked) return res.json({ ok: true, ...current, unchanged: true });
    const config = {
      provider,
      is_locked: true,
      lockedAt: new Date(now()).toISOString(),
      version: 1,
    };
    atomicWrite(oauthConfigFile, config);
    res.json({ ok: true, ...config });
  });

  app.post('/api/security/cloud/otp/send', async (req, res) => {
    const provider = lockedProvider();
    if (!provider) return res.status(409).json({ error: 'Lock a cloud provider before requesting an email code' });
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid administrative email address' });

    const state = loadState();
    const timestamp = now();
    if (state.pendingOtp?.resendAt && timestamp < state.pendingOtp.resendAt) {
      return res.status(429).json({
        error: 'Please wait before requesting another code',
        retryAfter: Math.ceil((state.pendingOtp.resendAt - timestamp) / 1000),
      });
    }

    try {
      await adapter(provider).send(email);
      state.pendingOtp = {
        challengeId: crypto.randomUUID(),
        provider,
        email,
        issuedAt: timestamp,
        expiresAt: timestamp + OTP_TTL_MS,
        resendAt: timestamp + RESEND_COOLDOWN_MS,
        attempts: 0,
      };
      saveState(state);
      res.json({
        ok: true,
        delivered: true,
        expiresIn: OTP_TTL_MS / 1000,
        expiresAt: state.pendingOtp.expiresAt,
        resendIn: RESEND_COOLDOWN_MS / 1000,
        resendAt: state.pendingOtp.resendAt,
      });
    } catch (error) {
      res.status(error.statusCode || 502).json({ error: error.message, code: error.code });
    }
  });

  app.post('/api/security/cloud/otp/verify', async (req, res) => {
    const provider = lockedProvider();
    const code = String(req.body?.code || '').trim();
    const state = loadState();
    const pending = state.pendingOtp;
    if (!provider || !pending) return res.status(409).json({ error: 'No email code is pending' });
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the 6-digit code' });
    const timestamp = now();
    if (timestamp >= pending.expiresAt) {
      delete state.pendingOtp;
      saveState(state);
      return res.status(410).json({ error: 'Code expired after 120 seconds', code: 'OTP_EXPIRED' });
    }
    if (pending.provider !== provider) return res.status(409).json({ error: 'Provider changed during verification' });
    pending.attempts = (pending.attempts || 0) + 1;
    if (pending.attempts > 5) {
      delete state.pendingOtp;
      saveState(state);
      return res.status(429).json({ error: 'Too many verification attempts' });
    }

    try {
      const verified = await adapter(provider).verify(pending.email, code);
      if (!verified) {
        saveState(state);
        return res.status(401).json({ error: 'Invalid code' });
      }
      state.verifiedEmail = pending.email;
      state.emailVerified = true;
      state.oauth = {
        provider,
        state: 'verified',
        is_locked: true,
        verifiedAt: timestamp,
      };
      state.verifiedAt = timestamp;
      state.restartRequired = true;
      delete state.pendingOtp;
      saveState(state);
      if (!sessionStore.loadUser()) {
        sessionStore.saveUser({
          username: pending.email,
          displayName: pending.email,
          email: pending.email,
          role: 'operator',
          authMode: 'cloud',
          cloudProvider: provider,
          createdAt: new Date(timestamp).toISOString(),
          updatedAt: new Date(timestamp).toISOString(),
          sessions: {},
        });
      }
      sessionStore.savePolicy({
        ...sessionStore.loadPolicy(),
        guardEnabled: true,
        bootSequence: true,
      });
      global.__AEON_SECURITY_RESTART_REQUIRED = true;
      res.json({ ok: true, verified: true, restartRequired: true });
    } catch (error) {
      res.status(error.statusCode || 502).json({ error: error.message, code: error.code });
    }
  });

  app.get('/api/security/oauth/client-config', (req, res) => {
    const provider = lockedProvider();
    const state = loadState();
    if (!provider) return res.status(204).end();
    if (!state.emailVerified) {
      return res.status(409).json({ error: 'Cloud identity setup is not verified' });
    }
    const credentials = typeof deps.getCloudCredentials === 'function'
      ? deps.getCloudCredentials(provider)
      : null;
    if (!credentials) return res.status(409).json({ error: 'Cloud provider credentials are unavailable' });
    if (provider === 'supabase') {
      return res.json({
        provider,
        config: { url: credentials.url, anonKey: credentials.anonKey },
      });
    }
    res.json({
      provider,
      config: {
        apiKey: credentials.apiKey,
        authDomain: credentials.authDomain,
        projectId: credentials.projectId,
        storageBucket: credentials.storageBucket,
        messagingSenderId: credentials.messagingSenderId,
        appId: credentials.appId,
        measurementId: credentials.measurementId,
      },
    });
  });

  async function verifyOAuthToken(provider, token) {
    if (deps && Object.prototype.hasOwnProperty.call(deps, 'cloudOAuthVerifier')) {
      return deps.cloudOAuthVerifier(provider, token);
    }
    const credentials = deps.getCloudCredentials(provider);
    if (provider === 'supabase') {
      const response = await fetch(`${credentials.url}/auth/v1/user`, {
        headers: { apikey: credentials.anonKey, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      const user = await response.json().catch(() => ({}));
      if (!response.ok || !user.email) return null;
      return { subject: user.id, email: user.email, displayName: user.user_metadata?.full_name || user.email };
    }
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(credentials.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: token }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const body = await response.json().catch(() => ({}));
    const user = body.users?.[0];
    if (!response.ok || !user?.email) return null;
    return { subject: user.localId, email: user.email, displayName: user.displayName || user.email };
  }

  // Authenticated local→cloud migration — the ONLY sanctioned way to convert an
  // existing account. Requires a live operator session, re-verification of the
  // current local password, and explicit confirmation of the OTP-verified email
  // and locked provider. Records a short-lived, single-use approval that
  // /api/security/oauth/exchange consumes. This route self-validates the session
  // (it is not a bootstrap route) so it stays closed even where the kernel guard
  // is not mounted ahead of it.
  app.post('/api/security/cloud/migrate', async (req, res) => {
    const current = sessionStore.loadUser();
    if (!current) return res.status(409).json({ error: 'No account to migrate', code: 'NO_ACCOUNT' });

    const session = sessionStore.validateSession(req, sessionStore.loadPolicy());
    if (!session.ok || session.kind === 'machine') {
      return sessionStore.unauthorized(res, session.reason || 'no-session');
    }
    if (current.authMode === 'cloud') {
      return res.status(409).json({ error: 'Account is already cloud-managed', code: 'ALREADY_CLOUD' });
    }
    if (!verifyLocalPassword(current, req.body?.password)) {
      return res.status(403).json({ error: 'Current password is incorrect', code: 'REVERIFY_FAILED' });
    }

    const provider = lockedProvider();
    const state = loadState();
    if (!provider || !state.emailVerified) {
      return res.status(409).json({ error: 'Verify the cloud administrative email first', code: 'EMAIL_UNVERIFIED' });
    }
    const targetEmail = String(req.body?.email || '').trim().toLowerCase();
    const targetProvider = String(req.body?.provider || '').toLowerCase();
    if (targetProvider !== provider || targetEmail !== String(state.verifiedEmail || '').toLowerCase()) {
      return res.status(409).json({ error: 'Confirm the verified cloud email and locked provider', code: 'TARGET_MISMATCH' });
    }

    const timestamp = now();
    state.migration = {
      email: state.verifiedEmail,
      provider,
      approvedBy: current.username,
      approvedAt: timestamp,
      expiresAt: timestamp + MIGRATION_TTL_MS,
    };
    saveState(state);
    res.json({ ok: true, migrationApproved: true, expiresAt: state.migration.expiresAt });
  });

  app.post('/api/security/oauth/exchange', async (req, res) => {
    const provider = lockedProvider();
    const token = String(req.body?.token || '');
    const state = loadState();
    if (!provider || !state.emailVerified) return res.status(409).json({ error: 'Cloud identity setup is not verified' });
    if (!token) return res.status(400).json({ error: 'Provider token required' });

    try {
      const identity = await verifyOAuthToken(provider, token);
      if (!identity) return res.status(401).json({ error: 'Provider token was rejected' });
      const email = String(identity.email || '').toLowerCase();
      if (email !== String(state.verifiedEmail || '').toLowerCase()) {
        return res.status(403).json({ error: 'Google account must match the verified administrative email' });
      }

      const timestamp = now();
      const current = sessionStore.loadUser();

      // A pre-auth OAuth token must never silently take over an existing
      // account. Classify the exchange:
      //   • no account          → first-run cloud bootstrap (create it)
      //   • same cloud identity → ordinary cloud login (issue a session)
      //   • anything else       → refuse, unless an authenticated migration
      //     (POST /api/security/cloud/migrate) approved this exact identity.
      const sameCloudIdentity = !!current
        && current.authMode === 'cloud'
        && current.cloudProvider === provider
        && String(current.email || '').toLowerCase() === email;

      if (current && !sameCloudIdentity) {
        const approval = state.migration;
        const approved = !!approval
          && approval.provider === provider
          && String(approval.email || '').toLowerCase() === email
          && Number(approval.expiresAt || 0) > timestamp;
        if (!approved) {
          return res.status(403).json({
            error: 'An account already exists. Convert it with an authenticated admin migration.',
            code: 'MIGRATION_REQUIRED',
          });
        }
        delete state.migration; // single-use — consumed on the authorized exchange
      }

      const user = current || {
        username: email,
        displayName: identity.displayName || email,
        email,
        role: 'operator',
        authMode: 'cloud',
        cloudProvider: provider,
        createdAt: new Date(timestamp).toISOString(),
        sessions: {},
      };
      user.authMode = 'cloud';
      user.cloudProvider = provider;
      user.email = email;
      user.displayName = identity.displayName || user.displayName || email;
      user.lastLogin = new Date(timestamp).toISOString();
      user.updatedAt = user.lastLogin;
      // A cloud account must not retain a usable local password credential.
      delete user.salt;
      delete user.passHash;
      user.sessions = user.sessions || {};
      const sessionToken = crypto.randomBytes(32).toString('hex');
      user.sessions[sessionToken] = {
        created: timestamp,
        lastSeen: timestamp,
        expires: timestamp + SESSION_TTL_MS,
        ua: String(req.headers['user-agent'] || 'unknown').slice(0, 160),
        ip: req.ip || req.connection?.remoteAddress || 'local',
      };
      sessionStore.saveUser(user);
      sessionStore.savePolicy({
        ...sessionStore.loadPolicy(),
        guardEnabled: true,
        bootSequence: true,
      });
      state.lastOAuthSignInAt = timestamp;
      state.oauth = {
        ...(state.oauth || {}),
        provider,
        state: 'active',
        subjectHash: crypto.createHash('sha256').update(String(identity.subject)).digest('hex'),
      };
      saveState(state);

      res.setHeader(
        'Set-Cookie',
        `aeon_session=${sessionToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
      );
      res.json({
        ok: true,
        token: sessionToken,
        user: { username: user.username, displayName: user.displayName, email: user.email, role: user.role },
      });
    } catch (error) {
      res.status(error.statusCode || 502).json({ error: error.message || 'OAuth exchange failed' });
    }
  });

  app.post('/api/security/restart', (req, res) => {
    const state = loadState();
    if (!state.restartRequired && !global.__AEON_SECURITY_RESTART_REQUIRED) {
      return res.json({ ok: true, restartRequired: false });
    }
    if (state.restartRequired) {
      state.restartRequestedAt = now();
      saveState(state);
    }
    res.json({ ok: true, restarting: typeof deps.requestRestart === 'function' });
    if (typeof deps.requestRestart === 'function') {
      setTimeout(() => deps.requestRestart(), 250);
    }
  });

  return {
    OTP_TTL_MS,
    RESEND_COOLDOWN_MS,
    files: { oauthConfigFile, stateFile },
  };
};
