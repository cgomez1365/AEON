const express = require('express');

module.exports = function createCoreRouter(deps) {
  const router = express.Router();
  const {
    _blockRegistry, _blockReadiness, _loadSettings, _llmTelemetry,
    getDailyCost, isVercel, fs, path, kernelLLM,
    _skippedRoutes, getLocalFile,
    getProviderHealth, confirmLocal, isLocalConfirmed, getKeyPoolInfo,
  } = deps;

  // Coinbase CDP key: inside the install (secrets/) first, Desktop only as legacy.
  const cdpKeyExists = () => [
    path.join(__dirname, '..', '..', '..', 'secrets', 'cdp_api_key.json'),
    path.join(process.env.USERPROFILE || process.env.HOME || '', 'Desktop', 'cdp_api_key.json'),
  ].some(p => { try { return fs.existsSync(p); } catch { return false; } });

  // GET /api/system/provider-health — cooldown state per LLM provider, for
  // Settings and the terminal to show WHY a request degraded.
  router.get('/provider-health', (_req, res) => {
    res.json({
      providers: getProviderHealth ? getProviderHealth() : {},
      localConfirmed: isLocalConfirmed ? isLocalConfirmed() : false,
      keyPools: getKeyPoolInfo ? getKeyPoolInfo() : {},
    });
  });

  // POST /api/system/allow-local — operator's "yes" to run this session's AI
  // calls on the local Ollama model for 15 minutes while cloud is down.
  // Triggered by the /allow-local terminal command.
  router.post('/allow-local', (_req, res) => {
    const r = confirmLocal ? confirmLocal() : { until: 0 };
    res.json({ ok: true, ...r });
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
    providers.ollama = !!env.OLLAMA_HOST;
    providers.supabase = !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
    providers.firebase = !!env.VITE_FIREBASE_PROJECT_ID;
    providers.youtube = !!env.YOUTUBE_REFRESH_TOKEN;
    providers.coingecko = !!env.COINGECKO_API_KEY;
    providers.coinbase = cdpKeyExists();
    providers.gas = !!env.VITE_GAS_URL;
    providers.canva = !!env.CANVA_CLIENT_SECRET;

    let memoryCount = 0;
    try {
      const memDir = path.join(__dirname, '..', '..', 'blocks', 'memory', 'data');
      const memFile = path.join(memDir, 'memories.json');
      if (fs.existsSync(memFile)) {
        memoryCount = JSON.parse(fs.readFileSync(memFile, 'utf8')).length;
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

  // POST /api/system/scan — full matrix scan + Supabase 2-way sync
  router.post('/scan', async (req, res) => {
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
