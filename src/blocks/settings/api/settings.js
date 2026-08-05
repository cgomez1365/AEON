const fs = require('fs');
const path = require('path');

/**
 * Is this request from the machine AEON runs on?
 *
 * Reads the socket, not the Host header. Two routes below used
 * `req.get('host').includes('localhost')` to decide "local-only" — but Host: is
 * a string the client sends. Anyone able to reach the port could set
 * `Host: localhost` and write .env or trigger a restart. req.ip reflects the
 * real peer and cannot be spoofed by a header.
 */
function isLocalRequest(req) {
  const ip = req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

module.exports = (app, deps) => {
  const APP_ROOT = path.join(__dirname, '..', '..', '..', '..');
  // Kernel endpoint registry — the single source of truth for local hosts (BO7).
  const kernelEndpoints = require(path.join(__dirname, '..', '..', '..', 'kernel', 'endpoints.cjs'));
  const settingsService = require(path.join(APP_ROOT, 'services', 'settings.js'));
  const SETTINGS_FILE = settingsService.SETTINGS_FILE;
  const ENV_FILE = path.join(APP_ROOT, '.env');
  const cloudCredentials = deps && Object.prototype.hasOwnProperty.call(deps, 'cloudCredentials')
    ? deps.cloudCredentials
    : settingsService.createCloudCredentialStore();
  const providerCredentials = deps && Object.prototype.hasOwnProperty.call(deps, 'providerCredentials')
    ? deps.providerCredentials
    : settingsService.createProviderCredentialStore();
  // First ready local model, from the native runtime registry — null if none.
  //
  // This read the legacy flat store (data/local-runtime.json) until BO-C. That
  // store was written by Cookbook from an HF-cache scan and carried
  // `models: []` on this install, so local was never auto-picked even with a
  // verified GGUF ready. The registry under services/local-runtime is the only
  // authority now.
  const firstLocalModel = () => {
    try {
      const lr = require(path.join(APP_ROOT, 'services', 'local-runtime', 'index.cjs'));
      const models = lr.listReadyModels('chat');
      return models.length ? models[0].id : null;
    } catch { return null; }
  };
  // Coinbase CDP key lives inside the install (secrets/), not on the user's
  // Desktop — that was a hardcoded personal convention. Desktop kept as a
  // legacy fallback so existing setups don't break.
  const cdpKeyExists = () =>
    fs.existsSync(path.join(APP_ROOT, 'secrets', 'cdp_api_key.json')) ||
    fs.existsSync(path.join(process.env.USERPROFILE || process.env.HOME || '', 'Desktop', 'cdp_api_key.json')); // aeon-path-authority-allow

  // ── Settings file I/O ──────────────────────────────────────────────
  function loadSettings() {
    const loaded = settingsService.loadSettings();
    return loaded && typeof loaded === 'object' ? loaded : _defaults();
  }

  // Role defaults resolve to whichever provider is actually alive right now —
  // hardcoded groq/gemini defaults resurrected dead providers every time the
  // settings file went missing. Local-first: env key order mirrors the
  // nervous-system fallback chain, local runtime is the always-there floor.
  function _liveDefault() {
    if (process.env.OPENROUTER_API_KEY) return { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free' };
    if (process.env.GROQ_API_KEY) return { provider: 'groq', model: 'llama-3.3-70b-versatile' };
    if (process.env.GEMINI_FREE_KEY_1 || process.env.GEMINI_PAID_KEY) return { provider: 'gemini', model: 'gemini-2.0-flash' };
    const local = firstLocalModel();
    if (local) return { provider: 'local', model: local };
    return { provider: 'none', model: '' };
  }

  function _defaults() {
    const live = _liveDefault();
    return {
      models: {
        chat: { ...live },
        grading: { ...live },
        research: { ...live },
        creative: { ...live },
      },
      roulette: false,
      providers: {},
      prefs: {}
    };
  }

  function saveSettings(data) {
    settingsService.saveSettings(data);
  }

  function deepMerge(target, patch) {
    for (const k of Object.keys(patch)) {
      const v = patch[k];
      if (v && typeof v === 'object' && !Array.isArray(v)
        && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
        deepMerge(target[k], v);
      } else {
        target[k] = v;
      }
    }
    return target;
  }

  // ── GET /api/settings — full settings + env key status ─────────────
  app.get('/api/settings', async (req, res) => {
    const settings = settingsService.sanitizeSettings(loadSettings());
    const cloudProviders = cloudCredentials.metadata();
    const envKeys = {};
    if (fs.existsSync(ENV_FILE)) {
      const lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n');
      for (const line of lines) {
        // Strip inline "# comment" trailing a value (dotenv convention: only
        // a #  preceded by whitespace ends the value) — un-stripped, a blank
        // "KEY=          # docs..." line captured the comment text as the
        // value and reported "configured" on a genuinely empty key.
        const withoutComment = line.replace(/\s+#.*$/, '');
        const match = withoutComment.match(/^([A-Z0-9_]+)=(.*)$/);
        if (match) {
          const key = match[1];
          const val = match[2].trim();
          if (key.includes('KEY') || key.includes('SECRET') || key.includes('TOKEN')) {
            envKeys[key] = val ? 'configured' : 'missing';
          } else if (key === 'AEON_WORKSPACE' || key === 'AEON_LLM_BACKEND') {
            envKeys[key] = val || 'not set';
          }
        }
      }
    }
    // Vault-stored keys upgrade "missing" → "vault" for their provider's env var.
    // e.g. if groq has a vault connection, GROQ_API_KEY shows "vault" not "missing".
    const VAULT_KEY_MAP = {
      groq: ['GROQ_API_KEY'],
      gemini: ['GEMINI_PAID_KEY', 'GEMINI_FREE_KEY_1'],
      openai: ['OPENAI_API_KEY'],
      claude: ['ANTHROPIC_API_KEY'],
      grok: ['GROK_API_KEY'],
      openrouter: ['OPENROUTER_API_KEY'],
      coingecko: ['COINGECKO_API_KEY'],
      coinbase: ['COINBASE_API_KEY', 'COINBASE_API_SECRET'],
      canva: ['CANVA_CLIENT_SECRET'],
      youtube: ['YOUTUBE_API_KEY', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_REFRESH_TOKEN'],
    };
    try {
      const endpointsMod = require(path.join(__dirname, '..', '..', '..', 'kernel', 'endpoints.cjs'));
      const supabase = deps && deps.supabase ? deps.supabase : null;
      const reg = await endpointsMod.load(supabase);
      for (const ep of (reg.endpoints || [])) {
        const keys = VAULT_KEY_MAP[ep.provider];
        if (keys) {
          for (const k of keys) {
            if (!envKeys[k] || envKeys[k] === 'missing') envKeys[k] = 'vault';
          }
        }
      }
    } catch {}
    if (cloudProviders.supabase.configured) {
      envKeys.SUPABASE_URL = 'vault';
      envKeys.SUPABASE_ANON_KEY = 'vault';
      if (cloudProviders.supabase.hasServiceRoleKey) envKeys.SUPABASE_SERVICE_ROLE_KEY = 'vault';
    }
    if (cloudProviders.firebase.configured) {
      envKeys.VITE_FIREBASE_API_KEY = 'vault';
      envKeys.VITE_FIREBASE_PROJECT_ID = 'vault';
      envKeys.VITE_FIREBASE_APP_ID = 'vault';
    }
    Object.assign(envKeys, providerCredentials.metadata());
    res.json({ settings, envKeys, cloudProviders });
  });

  // ── POST /api/settings — merge a patch (preferred) or replace whole file ──
  // { patch: {...} }    → deep-merged into the file on disk (read-modify-write,
  //                       concurrent writers can't clobber each other)
  // { settings: {...} } → full replace, kept ONLY for explicit import/restore
  app.post('/api/settings', (req, res) => {
    const { settings, patch, cloudProvider } = req.body;
    if (cloudProvider) {
      try {
        const metadata = cloudCredentials.save(cloudProvider.provider, cloudProvider.config);
        return res.json({ ok: true, stored: 'encrypted-vault', cloudProviders: metadata });
      } catch (error) {
        return res.status(error.statusCode || 500).json({ error: error.message });
      }
    }
    if (patch && typeof patch === 'object') {
      const current = loadSettings();
      saveSettings(deepMerge(current, patch));
      return res.json({ ok: true, merged: true });
    }
    if (!settings) return res.status(400).json({ error: 'patch or settings object required' });
    saveSettings(settings);
    res.json({ ok: true });
  });

  app.delete('/api/settings/cloud-provider/:provider', (req, res) => {
    try {
      const metadata = cloudCredentials.remove(req.params.provider);
      res.json({ ok: true, cloudProviders: metadata });
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  app.post('/api/settings/secrets', (req, res) => {
    try {
      const written = providerCredentials.save(req.body?.vars);
      providerCredentials.hydrate(process.env);
      res.json({ ok: true, written, stored: 'encrypted-vault', restartRequired: false });
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  // ── POST /api/settings/nl — natural-language settings from the terminal ──
  // "set grading to local qwen3.5:4b" / "set chat to tencent/hy3:free".
  // Writes the SAME store the UI writes (settings.models + endpoint-registry
  // role) — this is what makes the terminal and the panel one source of truth.
  // Deterministic parse, zero LLM tokens.
  app.post('/api/settings/nl', async (req, res) => {
    const phrase = String(req.body?.phrase || '').trim();
    const settings = loadSettings();
    const roles = Object.keys(settings.models || {});
    // "set <role> [to] [provider] <model>"
    const m = phrase.match(/set\s+([a-z_]+)\s+(?:to\s+|=\s*)?(.+)$/i);
    if (!m) return res.status(400).json({ error: 'Try: set <role> to <provider> <model>', roles });
    const role = m[1].toLowerCase();
    if (!roles.includes(role)) return res.status(400).json({ error: `Unknown role "${role}".`, roles });
    let rest = m[2].trim().split(/\s+/);
    const PROVIDERS = ['local', 'openrouter', 'groq', 'gemini', 'openai', 'claude'];
    let provider = PROVIDERS.includes(rest[0].toLowerCase()) ? rest.shift().toLowerCase() : null;
    let model = rest.join(' ').trim();
    if (!model) return res.status(400).json({ error: 'No model given.', roles });
    if (!provider) {
      if (model.includes('/')) provider = 'openrouter';
      else provider = settings.models[role]?.provider || 'local';
    }
    // 1) settings.models (the fallback source)
    settings.models[role] = { provider, model };
    saveSettings(settings);
    // 2) endpoint-registry role (the primary source) — keep them in lockstep
    let registry = 'skipped';
    try {
      const endpointsMod = require(path.join(__dirname, '..', '..', '..', 'kernel', 'endpoints.cjs'));
      const supa = deps && deps.supabase ? deps.supabase : null;
      const reg = await endpointsMod.load(supa);
      const ep = (reg.endpoints || []).find(e => e.provider === provider);
      if (ep && endpointsMod.assignRole) { await endpointsMod.assignRole(role, ep.id, model, null, supa); registry = 'updated'; }
    } catch (e) { registry = 'error:' + e.message; }
    res.json({ ok: true, role, provider, model, registry, message: `${role} → ${provider} / ${model}` });
  });

  // ── GET /api/settings/export-bundle — the client-ready config (NO secrets) ──
  // Strips every key, bakes the chosen role models, and lists what the
  // recipient must supply. This is the portable artifact behind the B2B unit:
  // hand it to a client, they add their own keys, they're running AEON.
  app.get('/api/settings/export-bundle', (req, res) => {
    const settings = loadSettings();
    const srcBlocks = path.join(__dirname, '..', '..');
    const blocks = [];
    const providersNeeded = new Set();
    const servicesNeeded = new Set();
    try {
      for (const folder of fs.readdirSync(srcBlocks)) {
        const mp = path.join(srcBlocks, folder, 'block.manifest.json');
        if (!fs.existsSync(mp)) continue;
        const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
        const role = m.contract?.ai?.role || null;
        blocks.push({ id: m.id, label: m.label, role });
        for (const api of (m.requires?.apis || [])) {
          if (['supabase', 'firebase'].includes(api)) servicesNeeded.add(api);
          else providersNeeded.add(api);
        }
      }
    } catch {}
    // Providers actually referenced by the baked role models
    for (const cfg of Object.values(settings.models || {})) if (cfg?.provider) providersNeeded.add(cfg.provider);
    const bundle = {
      _artifact: 'AEON client-ready config',
      _note: 'No secrets included. The operator must supply their own keys for the providers listed under keys_required.',
      exported_at: new Date().toISOString(),
      models: settings.models || {},           // baked role → provider + model
      services_required: [...servicesNeeded],
      keys_required: [...providersNeeded].filter(p => p !== 'local').map(p => `${p.toUpperCase()}_API_KEY`),
      local_models_ok: [...providersNeeded].includes('local'),
      blocks,
    };
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="aeon-client-config.json"');
    res.send(JSON.stringify(bundle, null, 2));
  });

  // ── GET /api/settings/export-credentials — full credential backup (WITH secrets) ──
  // Bundles .env + secrets/aeon-keyslots.json + provider_credentials.json into
  // one JSON file the user saves offline. Restoring into a fresh clone requires
  // all three — a partial restore causes a vault mismatch and locks the user out.
  app.get('/api/settings/export-credentials', (req, res) => {
    const SECRETS_DIR = path.join(APP_ROOT, 'secrets');
    const VAULT_DIR = require(path.join(APP_ROOT, 'services', 'storage.js')).getVaultFile(path.join('blocks', 'security'));
    const files = {
      '.env': path.join(APP_ROOT, '.env'),
      'secrets/aeon-keyslots.json': path.join(SECRETS_DIR, 'aeon-keyslots.json'),
      'vault/provider_credentials.json': path.join(VAULT_DIR, 'provider_credentials.json'),
    };
    const bundle = {
      _artifact: 'AEON credential backup',
      _warning: 'Contains plaintext secrets. Store offline, never commit to git.',
      _restore: 'On a fresh clone: copy .env to root, secrets/aeon-keyslots.json to secrets/, vault/provider_credentials.json to its vault path. Boot — vault auto-unlocks.',
      exported_at: new Date().toISOString(),
      files: {},
    };
    for (const [key, filePath] of Object.entries(files)) {
      try { bundle.files[key] = fs.readFileSync(filePath, 'utf8'); }
      catch { bundle.files[key] = null; }
    }
    const hasAnyContent = Object.values(bundle.files).some(v => v !== null);
    if (!hasAnyContent) return res.status(404).json({ error: 'No credential files found — nothing to export.' });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="aeon-credentials-${new Date().toISOString().slice(0,10)}.json"`);
    res.send(JSON.stringify(bundle, null, 2));
  });

  // ── GET /api/settings/block/:id — a block's own settings, resolved ──
  // Manifest-declared defaults merged with saved overrides. This is THE
  // way a block reads its settings: one call, always complete, and the
  // shape follows the block wherever it's installed (modularity).
  app.get('/api/settings/block/:id', (req, res) => {
    const id = req.params.id;
    const settings = loadSettings();
    const saved = (settings.blockSettings || {})[id] || {};
    let defaults = {};
    try {
      const manifestPath = path.join(__dirname, '..', '..', id, 'block.manifest.json');
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      for (const def of (m.contract?.settings || [])) defaults[def.key] = def.default;
    } catch { /* block gone or no manifest — saved values still returned */ }
    res.json({ id, values: { ...defaults, ...saved } });
  });

  // ── GET /api/prefs/:key — read a single preference ────────────────
  app.get('/api/prefs/:key', (req, res) => {
    const settings = loadSettings();
    const prefs = settings.prefs || {};
    const key = req.params.key;
    res.json({ key, value: prefs[key] !== undefined ? prefs[key] : null });
  });

  // ── PUT /api/prefs/:key — write a single preference ────────────────
  app.put('/api/prefs/:key', (req, res) => {
    const settings = loadSettings();
    if (!settings.prefs) settings.prefs = {};
    settings.prefs[req.params.key] = req.body.value;
    saveSettings(settings);
    res.json({ ok: true, key: req.params.key, value: req.body.value });
  });

  // ── GET /api/settings/blocks — installed blocks + dependency readiness ─
  app.get('/api/settings/blocks', (req, res) => {
    let std = null;
    try { std = require(path.join(__dirname, '..', '..', '..', 'kernel', 'blockStandard.cjs')); } catch {}
    const srcBlocks = path.join(__dirname, '..', '..');
    const blocks = [];
    if (fs.existsSync(srcBlocks)) {
      for (const folder of fs.readdirSync(srcBlocks)) {
        const manifestPath = path.join(srcBlocks, folder, 'block.manifest.json');
        if (fs.existsSync(manifestPath)) {
          try {
            const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            m.readiness = std ? std.checkReadiness(m, process.env) : null;
            blocks.push(m);
          } catch {}
        }
      }
    }
    // Group order then nav order for a stable, organized list.
    blocks.sort((a, b) =>
      ((a.nav && a.nav.group) || '').localeCompare((b.nav && b.nav.group) || '') ||
      (((a.nav && a.nav.order) ?? 99) - ((b.nav && b.nav.order) ?? 99)));
    res.json(blocks);
  });

  // ── GET /api/settings/providers — provider connection status ───────
  // Checks BOTH .env AND the endpoint registry (vault connections added via UI).
  // A provider is "configured" if a key exists in either place.
  // ── Nervous-system builder — THE single source of provider truth ──
  // Every route that reports provider status derives from this function.
  // Add a provider once (ENV_PROVIDER_MAP or the endpoint registry) and it
  // appears everywhere: /providers (legacy boolean shape), /nervous-system,
  // and any future consumer. The old hand-maintained checks map is gone —
  // it drifted (tavily/serper were missing) and can never drift again.
  async function buildNervousSystem() {
    const env = process.env;
    const cloudProviderMetadata = cloudCredentials.metadata();

    // ── 1. Scan manifests for all declared providers ──
    const srcBlocks = path.join(__dirname, '..', '..');
    const manifestProviders = new Set();
    const providerBlockMap = {};
    const allBlocks = [];

    if (fs.existsSync(srcBlocks)) {
      for (const folder of fs.readdirSync(srcBlocks)) {
        const mp = path.join(srcBlocks, folder, 'block.manifest.json');
        if (!fs.existsSync(mp)) continue;
        try {
          const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
          const apis = (m.requires && m.requires.apis) || [];
          allBlocks.push({
            id: m.id, label: m.label || m.id, icon: m.icon || '📦',
            category: (m.nav && m.nav.group) || m.category || 'other',
            requires: apis,
          });
          for (const api of apis) {
            manifestProviders.add(api);
            if (!providerBlockMap[api]) providerBlockMap[api] = [];
            providerBlockMap[api].push({ id: m.id, label: m.label || m.id });
          }
        } catch {}
      }
    }

    // ── 2. Scan env for providers (may have keys not declared in any manifest) ──
    const ENV_PROVIDER_MAP = {
      groq:       { keys: ['GROQ_API_KEY'], kind: 'cloud', icon: '⚡', base: 'https://api.groq.com/openai/v1' },
      gemini:     { keys: ['GEMINI_FREE_KEY_1', 'GEMINI_PAID_KEY', 'GEMINI_FREE_KEY_2', 'GEMINI_FREE_KEY_3'], kind: 'cloud', icon: '💎', base: 'https://generativelanguage.googleapis.com/v1beta' },
      openai:     { keys: ['OPENAI_API_KEY'], kind: 'cloud', icon: '🧠', base: 'https://api.openai.com/v1' },
      claude:     { keys: ['ANTHROPIC_API_KEY'], kind: 'cloud', icon: '🎭', base: 'https://api.anthropic.com/v1' },
      local:      { keys: [], kind: 'local', icon: '🖥️', base: null, detect: (() => { try { return require(path.join(APP_ROOT, 'services', 'storage.js')).getLocalRuntimeRegistry().activeRuntime() !== null; } catch { return false; } })() },
      grok:       { keys: ['GROK_API_KEY'], kind: 'cloud', icon: '🤖', base: 'https://api.x.ai/v1' },
      lmstudio:   { keys: [], kind: 'local', icon: '🖥️', base: `${kernelEndpoints.lmStudioHost()}/v1` },
      supabase:   { keys: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'], kind: 'infra', icon: '🟢', allRequired: true },
      firebase:   { keys: ['VITE_FIREBASE_PROJECT_ID'], kind: 'infra', icon: '🔥' },
      youtube:    { keys: ['YOUTUBE_REFRESH_TOKEN'], kind: 'service', icon: '📺' },
      gas:        { keys: ['VITE_GAS_URL'], kind: 'service', icon: '📋' },
      coingecko:  { keys: ['COINGECKO_API_KEY'], kind: 'service', icon: '🦎' },
      coinbase:   { keys: [], kind: 'service', icon: '🪙', detect: cdpKeyExists() },
      canva:      { keys: ['CANVA_CLIENT_SECRET'], kind: 'service', icon: '🎨' },
      cloudflare: { keys: ['CLOUDFLARE_ACCOUNT_ID'], kind: 'infra', icon: '☁️' },
      openrouter: { keys: ['OPENROUTER_API_KEY'], kind: 'cloud', icon: '🔀', base: 'https://openrouter.ai/api/v1' },
      tavily:     { keys: ['TAVILY_API_KEY'], kind: 'search', icon: '🔍' },
      serper:     { keys: ['SERPER_API_KEY'], kind: 'search', icon: '🔍' },
      brave:      { keys: ['BRAVE_API_KEY'], kind: 'search', icon: '🔍' },
    };

    // Check endpoint registry for vault-stored connections
    let registryProviders = {};
    try {
      const endpointsMod = require(path.join(__dirname, '..', '..', '..', 'kernel', 'endpoints.cjs'));
      const supabase = deps && deps.supabase ? deps.supabase : null;
      const reg = await endpointsMod.load(supabase);
      for (const ep of (reg.endpoints || [])) {
        registryProviders[ep.provider] = { models: ep.models || [], label: ep.label };
      }
    } catch {}

    // ── 3. Build unified provider list ──
    const allProviderIds = new Set([...Object.keys(ENV_PROVIDER_MAP), ...manifestProviders, ...Object.keys(registryProviders)]);
    const providers = {};

    for (const id of allProviderIds) {
      const meta = ENV_PROVIDER_MAP[id] || { keys: [], kind: 'unknown', icon: '🔌' };
      const keysPresent = meta.allRequired
        ? meta.keys.every(k => !!env[k])
        : meta.keys.some(k => !!env[k]);
      const configured = keysPresent || meta.detect || !!registryProviders[id]
        || !!cloudProviderMetadata[id]?.configured;
      const blocks = providerBlockMap[id] || [];

      // Auto-read details (display-safe, no secrets)
      const details = {};
      if (id === 'supabase' && (cloudProviderMetadata.supabase.projectUrl || env.SUPABASE_URL)) {
        details.projectUrl = cloudProviderMetadata.supabase.projectUrl || env.SUPABASE_URL;
        details.projectId = cloudProviderMetadata.supabase.projectId
          || env.SUPABASE_URL.replace('https://', '').replace('.supabase.co', '');
      }
      if (id === 'firebase') {
        details.projectId = cloudProviderMetadata.firebase.projectId || env.VITE_FIREBASE_PROJECT_ID || null;
        details.authDomain = cloudProviderMetadata.firebase.authDomain || env.VITE_FIREBASE_AUTH_DOMAIN || null;
      }
      if (id === 'local') {
        if (env.AEON_LLM_BACKEND) details.backend = env.AEON_LLM_BACKEND;
      }
      if (id === 'youtube') {
        if (env.YOUTUBE_CHANNEL_HANDLE) details.channelHandle = env.YOUTUBE_CHANNEL_HANDLE;
        if (env.YOUTUBE_CHANNEL_ACCOUNT) details.email = env.YOUTUBE_CHANNEL_ACCOUNT;
      }
      if (id === 'gas' && env.VITE_GAS_URL) {
        details.scriptUrl = env.VITE_GAS_URL.substring(0, 60) + '...';
      }
      if (id === 'gemini') {
        details.keyCount = [env.GEMINI_PAID_KEY, env.GEMINI_FREE_KEY_1, env.GEMINI_FREE_KEY_2, env.GEMINI_FREE_KEY_3].filter(Boolean).length;
        details.plan = env.GEMINI_PAID_KEY ? 'Paid' : 'Free tier';
      }
      // Generic multi-key pool detection (mirrors the Gemini pattern) —
      // KEY, KEY_2, KEY_3 for any provider that supports round-robin.
      if (['groq', 'openrouter', 'claude'].includes(id)) {
        const base = meta.keys[0];
        if (base) {
          const n = [env[base], env[`${base}_2`], env[`${base}_3`]].filter(Boolean).length;
          if (n > 0) details.keyCount = n;
        }
      }
      // Key hint (last 4 chars) for LLM providers
      for (const k of meta.keys) {
        if (env[k] && env[k].length > 8) {
          details.keyHint = `...${env[k].slice(-4)}`;
          break;
        }
      }

      providers[id] = {
        id,
        label: registryProviders[id]?.label || id.charAt(0).toUpperCase() + id.slice(1),
        icon: meta.icon,
        kind: meta.kind,
        base: meta.base || null,
        configured,
        blocks,
        details,
        registryModels: registryProviders[id]?.models || [],
        needsKey: meta.keys.length > 0 && !meta.detect,
      };
    }

    // ── 4. Block config state ──
    const settings = loadSettings();
    const blockConfig = settings.blockConfig || {};

    return {
      providers,
      blocks: allBlocks,
      blockConfig,
      roles: settings.models || {},
    };
  }

  // ── GET /api/settings/providers — legacy boolean shape, same truth ──
  app.get('/api/settings/providers', async (req, res) => {
    try {
      const ns = await buildNervousSystem();
      const checks = {};
      for (const [id, p] of Object.entries(ns.providers)) checks[id] = !!p.configured;
      res.json(checks);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/settings/nervous-system — full provider detail ────────
  app.get('/api/settings/nervous-system', async (req, res) => {
    try {
      res.json(await buildNervousSystem());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/settings/provider-details — auto-read account info from env ──
  // Surfaces what the system already knows so users don't re-enter it.
  // Never returns secrets — only display-safe metadata.
  app.get('/api/settings/provider-details', (req, res) => {
    const env = process.env;
    const cloud = cloudCredentials.metadata();
    const details = {
      groq: {
        configured: !!env.GROQ_API_KEY,
        keyHint: env.GROQ_API_KEY ? `gsk_...${env.GROQ_API_KEY.slice(-4)}` : null,
      },
      gemini: {
        configured: !!(env.GEMINI_FREE_KEY_1 || env.GEMINI_PAID_KEY),
        keyCount: [env.GEMINI_PAID_KEY, env.GEMINI_FREE_KEY_1, env.GEMINI_FREE_KEY_2, env.GEMINI_FREE_KEY_3].filter(Boolean).length,
        plan: env.GEMINI_PAID_KEY ? 'Paid' : 'Free tier',
      },
      openai: {
        configured: !!env.OPENAI_API_KEY,
        keyHint: env.OPENAI_API_KEY ? `sk-...${env.OPENAI_API_KEY.slice(-4)}` : null,
      },
      claude: {
        configured: !!env.ANTHROPIC_API_KEY,
        keyHint: env.ANTHROPIC_API_KEY ? `sk-ant-...${env.ANTHROPIC_API_KEY.slice(-4)}` : null,
      },
      supabase: {
        configured: cloud.supabase.configured,
        projectUrl: cloud.supabase.projectUrl,
        projectId: cloud.supabase.projectId,
      },
      firebase: {
        configured: cloud.firebase.configured,
        projectId: cloud.firebase.projectId,
        authDomain: cloud.firebase.authDomain,
      },
      local: {
        configured: (() => { try { return require(path.join(APP_ROOT, 'services', 'storage.js')).getLocalRuntimeRegistry().activeRuntime() !== null; } catch { return false; } })(),
        model: firstLocalModel(),
      },
      youtube: {
        configured: !!env.YOUTUBE_REFRESH_TOKEN,
        channelHandle: env.YOUTUBE_CHANNEL_HANDLE || null,
        channelId: env.YOUTUBE_CHANNEL_ID || null,
        email: env.YOUTUBE_CHANNEL_ACCOUNT || null,
      },
      coingecko: {
        configured: !!env.COINGECKO_API_KEY,
        keyHint: env.COINGECKO_API_KEY ? `CG-...${env.COINGECKO_API_KEY.slice(-4)}` : null,
      },
      coinbase: {
        configured: cdpKeyExists(),
      },
      gas: {
        configured: !!env.VITE_GAS_URL,
        scriptUrl: env.VITE_GAS_URL ? env.VITE_GAS_URL.substring(0, 60) + '...' : null,
      },
      grok: {
        configured: !!env.GROK_API_KEY,
        keyHint: env.GROK_API_KEY ? `xai-...${env.GROK_API_KEY.slice(-4)}` : null,
      },
      openrouter: {
        configured: !!env.OPENROUTER_API_KEY,
        keyHint: env.OPENROUTER_API_KEY ? `sk-or-...${env.OPENROUTER_API_KEY.slice(-4)}` : null,
      },
      lmstudio: {
        configured: false,
        host: kernelEndpoints.lmStudioHost(),
      },
      cloudflare: {
        configured: false,
      },
      canva: {
        configured: !!env.CANVA_CLIENT_SECRET,
      },
    };
    res.json(details);
  });

  // ── GET /api/settings/provider-blocks — which blocks need which provider ──
  // Reads every block manifest's requires.apis to build a live map.
  app.get('/api/settings/provider-blocks', (req, res) => {
    const srcBlocks = path.join(__dirname, '..', '..');
    const providerMap = {};
    if (fs.existsSync(srcBlocks)) {
      for (const folder of fs.readdirSync(srcBlocks)) {
        const mp = path.join(srcBlocks, folder, 'block.manifest.json');
        if (!fs.existsSync(mp)) continue;
        try {
          const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
          const apis = (m.requires && m.requires.apis) || [];
          for (const api of apis) {
            if (!providerMap[api]) providerMap[api] = [];
            providerMap[api].push({ id: m.id, label: m.label || m.id });
          }
        } catch {}
      }
    }
    res.json(providerMap);
  });

  // ── POST /api/settings/test-provider/:id — live connection test ────
  app.post('/api/settings/test-provider/:id', async (req, res) => {
    const id = req.params.id;
    const env = process.env;
    const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));

    // Resolve a provider's key from .env OR the vault (added via "Add connection").
    // This keeps the Test button consistent with the configured/connected state.
    const resolveKey = async (provider, envKeys) => {
      for (const k of envKeys) { if (env[k]) return env[k]; }
      try {
        const endpointsMod = require(path.join(__dirname, '..', '..', '..', 'kernel', 'endpoints.cjs'));
        const supabase = deps && deps.supabase ? deps.supabase : null;
        const reg = await endpointsMod.load(supabase);
        const ep = (reg.endpoints || []).find(e => e.provider === provider && e.auth_ref);
        if (ep) {
          const vault = require(path.join(__dirname, '..', '..', '..', 'kernel', 'vault.cjs'));
          return await vault.getSecret(ep.auth_ref, supabase);
        }
      } catch {}
      return null;
    };

    try {
      if (id === 'groq') {
        const key = await resolveKey('groq', ['GROQ_API_KEY']);
        if (!key) return res.json({ ok: false, error: 'No Groq key (set GROQ_API_KEY or add a connection)' });
        const r = await Promise.race([
          fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${key}` } }),
          timeout(8000)
        ]);
        const data = await r.json();
        return res.json({ ok: r.ok, models: (data.data || []).map(m => m.id).slice(0, 20), latency_ms: 0 });
      }

      if (id === 'gemini') {
        const key = await resolveKey('gemini', ['GEMINI_PAID_KEY', 'GEMINI_FREE_KEY_1']);
        if (!key) return res.json({ ok: false, error: 'No Gemini key configured' });
        const r = await Promise.race([
          fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`),
          timeout(8000)
        ]);
        const data = await r.json();
        return res.json({ ok: r.ok, models: (data.models || []).map(m => m.name.replace('models/', '')).slice(0, 20) });
      }

      if (id === 'local') {
        try {
          const lr = require(path.join(__dirname, '..', '..', '..', '..', 'services', 'local-runtime', 'index.cjs'));
          // listReadyModels(), never status().models — the latter does not
          // exist, so this route answered {ok:true, models:[]} with a ready
          // model installed, and the picker rendered a blank <select>.
          const models = lr.listReadyModels('chat').map(m => m.id);
          return res.json({ ok: lr.isAvailable(), models });
        } catch (e) {
          return res.json({ ok: false, models: [], error: e.message });
        }
      }

      if (id === 'supabase') {
        const saved = cloudCredentials.credentials('supabase');
        if (!saved?.url || !saved?.anonKey) return res.json({ ok: false, error: 'Missing Supabase config' });
        const r = await Promise.race([
          fetch(`${saved.url}/rest/v1/`, {
            headers: { apikey: saved.anonKey, Authorization: `Bearer ${saved.anonKey}` }
          }),
          timeout(5000)
        ]);
        return res.json({ ok: r.ok });
      }

      if (id === 'firebase') {
        return res.json({ ok: cloudCredentials.metadata().firebase.configured, note: 'Web Config presence verified' });
      }

      if (id === 'youtube') {
        return res.json({ ok: !!env.YOUTUBE_REFRESH_TOKEN, note: 'OAuth token presence verified' });
      }

      if (id === 'coinbase') {
        return res.json({ ok: cdpKeyExists(), note: cdpKeyExists() ? 'CDP key file found' : 'cdp_api_key.json not found in <AEON>/secrets' });
      }

      if (id === 'gas') {
        return res.json({ ok: !!env.VITE_GAS_URL, note: 'GAS URL presence verified' });
      }

      if (id === 'openai') {
        const key = await resolveKey('openai', ['OPENAI_API_KEY']);
        if (!key) return res.json({ ok: false, error: 'No OpenAI key (set OPENAI_API_KEY or add a connection)' });
        const r = await Promise.race([
          fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` } }),
          timeout(8000)
        ]);
        const data = await r.json();
        return res.json({ ok: r.ok, models: (data.data || []).map(m => m.id).slice(0, 30) });
      }

      if (id === 'claude') {
        const key = await resolveKey('claude', ['ANTHROPIC_API_KEY']);
        if (!key) return res.json({ ok: false, error: 'No Anthropic key (set ANTHROPIC_API_KEY or add a connection)' });
        const r = await Promise.race([
          fetch('https://api.anthropic.com/v1/models', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }),
          timeout(8000)
        ]);
        const data = await r.json();
        return res.json({ ok: r.ok, models: (data.data || []).map(m => m.id).slice(0, 20) });
      }

      if (id === 'grok') {
        const key = await resolveKey('grok', ['GROK_API_KEY']);
        if (!key) return res.json({ ok: false, error: 'No Grok key (set GROK_API_KEY or add a connection)' });
        const r = await Promise.race([
          fetch('https://api.x.ai/v1/models', { headers: { Authorization: `Bearer ${key}` } }),
          timeout(8000)
        ]);
        const data = await r.json();
        return res.json({ ok: r.ok, models: (data.data || []).map(m => m.id).slice(0, 20) });
      }

      if (id === 'lmstudio') {
        const host = kernelEndpoints.lmStudioHost();
        try {
          const r = await Promise.race([fetch(`${host}/v1/models`), timeout(5000)]);
          const data = await r.json();
          return res.json({ ok: true, models: (data.data || []).map(m => m.id) });
        } catch { return res.json({ ok: false, error: `LM Studio not reachable at ${host}` }); }
      }

      if (id === 'openrouter') {
        const key = await resolveKey('openrouter', ['OPENROUTER_API_KEY']);
        if (!key) return res.json({ ok: false, error: 'No OpenRouter key (set OPENROUTER_API_KEY or add a connection)' });
        const r = await Promise.race([
          fetch('https://openrouter.ai/api/v1/models', { headers: { Authorization: `Bearer ${key}` } }),
          timeout(8000)
        ]);
        const data = await r.json();
        return res.json({ ok: r.ok, models: (data.data || []).map(m => m.id).slice(0, 40) });
      }

      res.json({ ok: false, error: `Unknown provider: ${id}` });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });

  // ── GET /api/settings/block-config — per-block provider/model assignments ──
  // Returns every block's AI config: what it declared, what's assigned, status.
  app.get('/api/settings/block-config', (req, res) => {
    const settings = loadSettings();
    const blockOverrides = settings.blockConfig || {};
    const srcBlocks = path.join(__dirname, '..', '..');
    const result = [];

    if (fs.existsSync(srcBlocks)) {
      for (const folder of fs.readdirSync(srcBlocks)) {
        const mp = path.join(srcBlocks, folder, 'block.manifest.json');
        if (!fs.existsSync(mp)) continue;
        try {
          const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
          const apis = (m.requires && m.requires.apis) || [];
          const aiCapable = apis.some(a => ['groq', 'gemini', 'openai', 'claude', 'local', 'openrouter', 'grok', 'lmstudio'].includes(a));
          const hasAnyDep = apis.length > 0;
          const override = blockOverrides[m.id] || null;

          result.push({
            id: m.id,
            label: m.label || m.id,
            icon: m.icon || '📦',
            category: (m.nav && m.nav.group) || m.category || 'other',
            requires: apis,
            aiCapable,
            hasAnyDep: hasAnyDep,
            config: override || null,
          });
        } catch {}
      }
    }
    result.sort((a, b) => (a.hasAnyDep === b.hasAnyDep ? 0 : a.hasAnyDep ? -1 : 1));
    res.json(result);
  });

  // ── POST /api/settings/block-layout — Dashboard's block grid layout ──
  // Full replace of settings.blockLayout (NOT the generic /api/settings
  // patch, which deep-merges and can never delete a key — the Dashboard's
  // drag/drop and "delete section" actions need real removal, e.g. an
  // override going away when a block is dragged back to its default group).
  app.post('/api/settings/block-layout', (req, res) => {
    const { overrides, customGroups, groupOverrides } = req.body || {};
    const settings = loadSettings();
    settings.blockLayout = { overrides: overrides || {}, customGroups: customGroups || {}, groupOverrides: groupOverrides || {} };
    saveSettings(settings);
    res.json({ ok: true, blockLayout: settings.blockLayout });
  });

  // ── POST /api/settings/block-config — save per-block provider/model ──
  app.post('/api/settings/block-config', (req, res) => {
    const { blockId, provider, model } = req.body || {};
    if (!blockId) return res.status(400).json({ error: 'blockId required' });
    const settings = loadSettings();
    if (!settings.blockConfig) settings.blockConfig = {};
    if (provider && model) {
      settings.blockConfig[blockId] = { provider, model };
    } else {
      delete settings.blockConfig[blockId];
    }
    saveSettings(settings);
    res.json({ ok: true, blockConfig: settings.blockConfig });
  });

  // ── POST /api/settings/block-config/auto — auto-assign all blocks ──
  // Assigns the best available provider to each AI-capable block based on
  // what's configured. Reads manifests, checks provider status, assigns.
  app.post('/api/settings/block-config/auto', async (req, res) => {
    const { force } = req.body || {};
    const env = process.env;
    const available = [];
    if (env.GROQ_API_KEY) available.push('groq');
    if (env.GEMINI_FREE_KEY_1 || env.GEMINI_PAID_KEY) available.push('gemini');
    if (env.OPENAI_API_KEY) available.push('openai');
    if (env.ANTHROPIC_API_KEY) available.push('claude');
    if (env.GROK_API_KEY) available.push('grok');
    if (env.OPENROUTER_API_KEY) available.push('openrouter');
    // Local runtime availability — check native LR registry
    {
      try {
        const lr = require(path.join(__dirname, '..', '..', '..', '..', 'services', 'local-runtime', 'index.cjs'));
        if (lr.isAvailable()) available.push('local');
      } catch {}
    }

    // Also check endpoint registry (vault-stored keys)
    try {
      const endpoints = require(path.join(__dirname, '..', '..', '..', 'kernel', 'endpoints.cjs'));
      const supabase = deps && deps.supabase ? deps.supabase : null;
      const reg = await endpoints.load(supabase);
      for (const ep of (reg.endpoints || [])) {
        if (!available.includes(ep.provider)) available.push(ep.provider);
      }
    } catch {}

    // Prefer cloud providers over local — assign best available
    const priority = ['gemini', 'groq', 'openai', 'claude', 'grok', 'openrouter', 'local', 'lmstudio'];
    const defaultModels = {
      groq: 'llama-3.3-70b-versatile',
      gemini: 'gemini-2.5-flash',
      openai: 'gpt-4o',
      claude: 'claude-sonnet-4-6',
      grok: 'grok-3',
      openrouter: 'openai/gpt-4o-mini',
      local: firstLocalModel() || '',
    };

    const settings = loadSettings();
    if (!settings.blockConfig) settings.blockConfig = {};
    const srcBlocks = path.join(__dirname, '..', '..');
    let assigned = 0;

    if (fs.existsSync(srcBlocks)) {
      for (const folder of fs.readdirSync(srcBlocks)) {
        const mp = path.join(srcBlocks, folder, 'block.manifest.json');
        if (!fs.existsSync(mp)) continue;
        try {
          const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
          const apis = (m.requires && m.requires.apis) || [];
          const llmProviders = apis.filter(a => ['groq', 'gemini', 'openai', 'claude', 'local', 'grok', 'openrouter', 'lmstudio'].includes(a));
          if (llmProviders.length === 0) continue;
          if (!force && settings.blockConfig[m.id]) continue;

          // Pick best available provider by priority
          const match = priority.find(p => available.includes(p) && llmProviders.includes(p))
                     || llmProviders.find(p => available.includes(p))
                     || available.find(p => priority.includes(p))
                     || available[0];
          if (match === 'local' && !defaultModels.local) continue; // runtime present but zero models installed
          if (match) {
            settings.blockConfig[m.id] = { provider: match, model: defaultModels[match] || match };
            assigned++;
          }
        } catch {}
      }
    }
    saveSettings(settings);
    res.json({ ok: true, assigned, blockConfig: settings.blockConfig });
  });

  // ── Endpoint Resolver — Odysseus-style fallback chain ──────────────
  // task → utility → default, used by kernelLLM and blocks
  app.get('/api/settings/resolve-endpoint', (req, res) => {
    const role = req.query.role || 'chat';
    const settings = loadSettings();
    const models = settings.models || {};

    // Fallback chain: requested role → chat → first available
    const chain = [role, 'chat', Object.keys(models)[0]].filter(Boolean);
    let resolved = null;
    for (const r of chain) {
      if (models[r] && models[r].provider && models[r].model) {
        resolved = { role: r, provider: models[r].provider, model: models[r].model };
        break;
      }
    }

    if (!resolved) return res.status(400).json({ error: 'No model configured — set one in Settings' });
    res.json(resolved);
  });

  // ════════════════════════════════════════════════════════════════════
  //  ONBOARDING / CONFIG-FROM-UI — provider credentials go to encrypted
  //  Vault storage; this legacy env route only accepts non-secret settings.
  // ════════════════════════════════════════════════════════════════════

  // The setup groups, in the operator's flow order. Secret groups are saved
  // through /api/settings/secrets or the cloud-provider branch above.
  const ENV_GROUPS = {
    apiKeys: {
      label: 'API keys',
      vars: ['GROQ_API_KEY', 'GEMINI_FREE_KEY_1', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GROK_API_KEY', 'OPENROUTER_API_KEY'],
      anyOf: ['GROQ_API_KEY', 'GEMINI_FREE_KEY_1', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY'], // at least one
    },
    firebase: {
      label: 'Firebase',
      vars: ['VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_AUTH_DOMAIN', 'VITE_FIREBASE_PROJECT_ID',
             'VITE_FIREBASE_STORAGE_BUCKET', 'VITE_FIREBASE_MESSAGING_SENDER_ID', 'VITE_FIREBASE_APP_ID'],
      allOf: ['VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_PROJECT_ID', 'VITE_FIREBASE_APP_ID'],
    },
    supabase: {
      label: 'Supabase',
      vars: ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'],
      allOf: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
    },
  };
  // Keys whose value should also be written with a VITE_ prefix for the frontend.
  // Only publishable keys (Supabase anon, URL) — never secret API keys.
  const VITE_MIRROR = {
    SUPABASE_URL: 'VITE_SUPABASE_URL',
    SUPABASE_ANON_KEY: 'VITE_SUPABASE_ANON_KEY',
  };

  function parseEnvFile() {
    const map = {};
    if (fs.existsSync(ENV_FILE)) {
      for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=(.*)$/);
        if (m) map[m[1]] = m[2];
      }
    }
    return map;
  }

  /** Update/insert keys in .env without disturbing comments or unrelated lines.
   *  Atomic write (tmp → rename). Returns the keys touched. */
  function writeEnvVars(updates) {
    let lines = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8').split('\n') : [];
    const seen = new Set();
    lines = lines.map(line => {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
      if (m && updates[m[1]] !== undefined) {
        seen.add(m[1]);
        return `${m[1]}=${updates[m[1]]}`;
      }
      return line;
    });
    for (const [k, v] of Object.entries(updates)) {
      if (!seen.has(k)) lines.push(`${k}=${v}`);
    }
    const tmp = ENV_FILE + '.tmp';
    fs.writeFileSync(tmp, lines.join('\n'), { mode: 0o600 });
    fs.renameSync(tmp, ENV_FILE);
    return Object.keys(updates);
  }

  // ── GET /api/settings/setup-status — wizard progress (no secrets) ──
  app.get('/api/settings/setup-status', (req, res) => {
    const env = { ...process.env, ...parseEnvFile() }; // live + file (covers not-yet-restarted)
    const cloudProviders = cloudCredentials.metadata();
    const groupStatus = {};
    for (const [key, g] of Object.entries(ENV_GROUPS)) {
      const need = g.allOf || g.anyOf || g.vars;
      const ok = g.allOf ? g.allOf.every(v => !!env[v])
               : g.anyOf ? g.anyOf.some(v => !!env[v])
               : g.vars.some(v => !!env[v]);
      groupStatus[key] = { label: g.label, configured: ok, vars: g.vars };
    }
    groupStatus.firebase.configured = cloudProviders.firebase.configured;
    groupStatus.supabase.configured = cloudProviders.supabase.configured;
    // account status comes from the security block; models from settings file.
    let hasAccount = false;
    try { hasAccount = fs.existsSync(path.join(__dirname, '..', '..', '..', '..', 'secrets', 'aeon-user.json')); } catch {}
    const s = loadSettings();
    const hasModels = !!(s.models && Object.values(s.models).some(m => m && m.provider && m.model));
    // "Complete" = the machine can actually run AI. Account protection lives in
    // the Security block, and Supabase is optional for local-first installs —
    // neither gates the Settings wizard anymore.
    const complete = groupStatus.apiKeys.configured && hasModels;
    res.json({
      steps: { account: hasAccount, apiKeys: groupStatus.apiKeys.configured,
               firebase: groupStatus.firebase.configured, supabase: groupStatus.supabase.configured,
               settings: hasModels },
      groups: groupStatus,
      complete,
      restartPending: !!global.__AEON_RESTART_PENDING,
    });
  });

  // ── POST /api/settings/env — non-secret runtime config only ─────────
  app.post('/api/settings/env', (req, res) => {
    if (!isLocalRequest(req) && !process.env.AEON_ALLOW_REMOTE_ENV)
      return res.status(403).json({ error: 'Env writes are local-only (the desktop is the source of truth).' });
    const { vars } = req.body || {};
    if (!vars || typeof vars !== 'object') return res.status(400).json({ error: 'vars object required' });
    if (Object.keys(vars).some((key) => /(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/.test(key))) {
      return res.status(400).json({ error: 'Credentials are Vault-only; save provider keys through POST /api/settings/secrets.' });
    }

    const updates = {};
    for (const [k, v] of Object.entries(vars)) {
      if (!/^[A-Z0-9_]+$/.test(k)) continue;            // ignore malformed keys
      if (v === undefined || v === null || v === '') continue; // skip blanks (don't wipe)
      updates[k] = String(v);
      if (VITE_MIRROR[k]) updates[VITE_MIRROR[k]] = String(v); // mirror for frontend
      process.env[k] = String(v);                        // live-update so status reflects immediately
    }
    if (!Object.keys(updates).length) return res.json({ ok: true, written: [], note: 'nothing to write' });
    try {
      const written = writeEnvVars(updates);
      global.__AEON_RESTART_PENDING = true;              // VITE_ vars need a rebuild/restart
      res.json({ ok: true, written, restartRequired: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /api/settings/restart — apply config by restarting AEON ──
  app.post('/api/settings/restart', (req, res) => {
    if (!isLocalRequest(req))
      return res.status(403).json({ error: 'Restart is local-only.' });
    res.json({ ok: true, restarting: true });
    // Detach the restart script so it survives this process dying.
    setTimeout(() => {
      try {
        const { spawn } = require('child_process');
        const bat = path.join(__dirname, '..', '..', '..', '..', 'restart.bat');
        if (fs.existsSync(bat)) {
          // aeon-shell-allow: launching restart.bat requires cmd.exe; `bat` is a
          // server-side path.join constant, never request-derived.
          spawn('cmd.exe', ['/c', bat], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
        } else {
          process.exit(0); // fallback: a supervisor/launcher relaunches
        }
      } catch { process.exit(0); }
    }, 400);
  });
};
