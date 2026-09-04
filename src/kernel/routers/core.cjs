const express = require('express');

module.exports = function createCoreRouter(deps) {
  const router = express.Router();
  const {
    _blockRegistry, _blockReadiness, _loadSettings, _llmTelemetry,
    getDailyCost, isVercel, fs, path, kernelLLM,
    _skippedRoutes, getLocalFile,
    getProviderHealth, getKeyPoolInfo, VAULT_ROOT,
  } = deps;

  // Coinbase CDP key: inside the install (secrets/) first, Desktop only as legacy.
  const cdpKeyExists = () => [
    path.join(__dirname, '..', '..', '..', 'secrets', 'cdp_api_key.json'),
    path.join(process.env.USERPROFILE || process.env.HOME || '', 'Desktop', 'cdp_api_key.json'), // aeon-path-authority-allow
  ].some(p => { try { return fs.existsSync(p); } catch { return false; } });

  // GET /api/system/provider-health — cooldown state per LLM provider, for
  // Settings and the terminal to show WHY a request degraded.
  router.get('/provider-health', (_req, res) => {
    res.json({
      providers: getProviderHealth ? getProviderHealth() : {},
      keyPools: getKeyPoolInfo ? getKeyPoolInfo() : {},
    });
  });

  // POST /api/system/allow-local — the gate this approved was removed in
  // BO-2. Kept because stress tools and the terminal still call it, but it is
  // now honest about being a no-op instead of returning a fabricated approval
  // window. `until: null` is what the old Infinity already serialised to.
  router.post('/allow-local', (_req, res) => {
    res.json({ ok: true, until: null, noop: true, reason: 'local models need no confirmation' });
  });

  // System context — full environment snapshot for terminal AI
  router.get('/state', async (req, res) => {
    const settings = _loadSettings();
    const blocks = _blockRegistry.map(b => ({
      id: b.id, label: b.label || b.id, route: b.route,
      ready: _blockReadiness[b.id]?.ready ?? true,
      missing: _blockReadiness[b.id]?.missingApis || [],
      contract: b.contract || null,
    }));

    const providers = {};
    const env = process.env;
    providers.groq = !!env.GROQ_API_KEY;
    providers.gemini = !!(env.GEMINI_FREE_KEY_1 || env.GEMINI_PAID_KEY);
    providers.openai = !!env.OPENAI_API_KEY;
    providers.claude = !!env.ANTHROPIC_API_KEY;
    providers.grok = !!env.GROK_API_KEY;
    providers.openrouter = !!env.OPENROUTER_API_KEY;
    try { const storage = require('../../../services/storage.js'); providers.local = storage.getLocalRuntimeRegistry().activeRuntime() !== null; } catch { providers.local = false; }
    providers.supabase = !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
    providers.firebase = !!env.VITE_FIREBASE_PROJECT_ID;
    providers.youtube = !!env.YOUTUBE_REFRESH_TOKEN;
    providers.coingecko = !!env.COINGECKO_API_KEY;
    providers.coinbase = cdpKeyExists();
    providers.gas = !!env.VITE_GAS_URL;
    providers.canva = !!env.CANVA_CLIENT_SECRET;

    // The store lives at Vault/Agents/vp/memory/, owned by memory_core.
    // This pointed at src/blocks/memory/data/ — a block that was REMOVED, so
    // the path could never exist and system status reported 0 memories on
    // every install regardless of how many were saved. chat-stream.cjs had
    // the identical stale path and was corrected; this copy was missed, which
    // is the argument for the shared constant rather than a third hardcoding.
    let memoryCount = 0;
    try {
      const memFile = path.join(
        VAULT_ROOT || path.join(__dirname, '..', '..', 'blocks', 'aeon_matrix', 'data', 'Vault'),
        'Agents', 'vp', 'memory', 'memories.json'
      );
      if (fs.existsSync(memFile)) {
        const parsed = JSON.parse(fs.readFileSync(memFile, 'utf8'));
        memoryCount = Array.isArray(parsed) ? parsed.length : 0;
      }
    } catch {}

    let tasks = [];
    try {
      const tf = path.join(__dirname, '..', '..', 'aeon-tasks.json');
      if (fs.existsSync(tf)) tasks = JSON.parse(fs.readFileSync(tf, 'utf8')).map(t => ({ name: t.name, type: t.type, enabled: t.enabled, status: t.status }));
    } catch {}

    let vaultUnlocked = false;
    try { vaultUnlocked = require('../vault.cjs').isUnlocked(); } catch {}

    res.json({
      blocks: { total: blocks.length, ready: blocks.filter(b => b.ready).length, list: blocks },
      models: settings.models || {},
      roulette: settings.roulette || false,
      providers,
      vault: { unlocked: vaultUnlocked },
      memory: { count: memoryCount },
      tasks: { total: tasks.length, active: tasks.filter(t => t.enabled).length, list: tasks },
      telemetry: { calls: _llmTelemetry.totalCalls, tokens: _llmTelemetry.totalTokens, uptime: Math.floor(process.uptime()) },
      // B7 — IDE mode is visible state, never subtle: banner text present whenever active.
      ideMode: deps.ideMode ? deps.ideMode.status() : { active: false, banner: null },
      runtime: isVercel ? 'cloud' : 'local',
      timestamp: Date.now(),
      kernel: { skippedRoutes: _skippedRoutes, orphanedCount: _skippedRoutes.length },
    });
  });

  // Kernel health — orphaned route surface for Fleet Control
  router.get('/health', (req, res) => {
    res.json({
      ok: _skippedRoutes.length === 0,
      uptime: Math.floor(process.uptime()),
      blocks: { total: _blockRegistry.length, dynamicApiLoaded: _blockRegistry.filter(b => b.api_routes).length },
      skippedRoutes: _skippedRoutes,
      runtime: isVercel ? 'cloud' : 'local',
    });
  });

  // POST /api/system/audit — block readiness audit + matrix scan + Supabase sync
  //
  // This was registered as POST /api/system/scan, which host_os also registers.
  // host_os mounts first (block loader, server.js) and Express matches in
  // registration order, so this handler had never run — the richer of the two
  // was unreachable dead code, and nothing compared the routes. host_os keeps
  // /system/scan (its manifest declares it, and the terminal calls it); the
  // kernel's audit gets a name that says what it actually does.
  router.post('/audit', async (req, res) => {
    const logs = [];
    const settings = _loadSettings();

    // Block readiness audit
    const total = _blockRegistry.length;
    const ready = _blockRegistry.filter(b => _blockReadiness[b.id]?.ready ?? true).length;
    const notReady = _blockRegistry.filter(b => !(_blockReadiness[b.id]?.ready ?? true));
    logs.push(`[BLOCKS] ${ready}/${total} ready`);
    if (notReady.length) logs.push(`[WARN] Not ready: ${notReady.map(b => b.id).join(', ')}`);

    // Provider check
    const env = process.env;
    const providers = {
      groq: !!env.GROQ_API_KEY,
      gemini: !!(env.GEMINI_FREE_KEY_1 || env.GEMINI_PAID_KEY),
      supabase: !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY),
      coinbase: cdpKeyExists(),
    };
    const providerStatus = Object.entries(providers).map(([k, v]) => `${k}:${v ? '✔' : '✘'}`).join(' ');
    logs.push(`[PROVIDERS] ${providerStatus}`);

    // Skipped routes
    if (_skippedRoutes.length) logs.push(`[KERNEL] ${_skippedRoutes.length} skipped routes: ${_skippedRoutes.join(', ')}`);
    else logs.push(`[KERNEL] All routes mounted`);

    // Vault status
    try {
      const vault = require('../vault.cjs');
      logs.push(`[VAULT] ${vault.isUnlocked() ? 'Unlocked' : 'Locked'}`);
    } catch { logs.push('[VAULT] Unavailable'); }

    logs.push(`[SCAN] Complete @ ${new Date().toISOString()}`);
    res.json({ success: true, logs });
  });

  return router;
};
