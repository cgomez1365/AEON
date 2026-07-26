/**
 * AEON Jarvis OS — Server Composition Root
 * The old 1,586-line server.cjs monolith, rebuilt on the aeon-213 skeleton:
 *   security/security.js  — enforcement middleware + audit + SDI
 *   services/*            — storage, cloud (optional), ai, search, media, system
 *   server/block-loader.js — cartridge discovery + sandbox + block host
 * This file only composes: build deps → apply security → mount routers →
 * mount blocks → listen. No business logic lives here.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const isVercel = !!process.env.VERCEL;
const ROOT = path.join(__dirname, '..');

// ── Vault first-run guard — the vault must ALWAYS be usable out of the box ──
// If no master key exists (user skipped the launcher wizard or booted via npm),
// generate one, persist it to .env, and inject it into the live process.
// Local/desktop only — on Vercel the filesystem is read-only and keys come from env.
if (!isVercel && !process.env.AEON_VAULT_MASTER_KEY) {
  try {
    const crypto = require('crypto');
    const envFile = path.join(ROOT, '.env');
    const key = crypto.randomBytes(32).toString('hex');
    let env = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
    if (/^AEON_VAULT_MASTER_KEY=\s*$/m.test(env)) {
      env = env.replace(/^AEON_VAULT_MASTER_KEY=\s*$/m, `AEON_VAULT_MASTER_KEY=${key}`);
    } else {
      env += `${env.endsWith('\n') || !env ? '' : '\n'}AEON_VAULT_MASTER_KEY=${key}\n`;
    }
    fs.writeFileSync(envFile, env);
    process.env.AEON_VAULT_MASTER_KEY = key;
    console.log('[FIRST RUN] Vault master key generated and saved to .env');
  } catch (e) { console.warn('[FIRST RUN] vault key guard failed:', e.message); }
}

// ── Envelope keyslots — wrap the DEK under the .env protector PLUS a recovery
// slot so a lost or rotated .env never bricks the vault. Runs for fresh AND
// existing installs (idempotent); the DEK is stable, so no store is re-encrypted.
// Desktop only — Vercel has no writable FS and sources the key from env.
if (!isVercel) {
  try {
    const r = require('../src/kernel/vault.cjs').ensureKeyslots();
    if (r.created) console.log('[FIRST RUN] Vault keyslots initialized (file + recovery).');
  } catch (e) { console.warn('[FIRST RUN] keyslot init failed:', e.message); }
}

// ── Terminal event bus ──
const aeonTerminalStream = new EventEmitter();
global.broadcastTerminalEvent = (type, message, meta = null) => {
  aeonTerminalStream.emit('log', { type, message, timestamp: Date.now(), meta });
};

// ── Settings first-run guard — fresh installs get a working settings file ──
// (aeon-213 pattern: settings.default.json → settings.json copy-on-boot)
try {
  const SETTINGS_PATH = path.join(ROOT, 'src', 'aeon-settings.json');
  const DEFAULT_PATH = path.join(ROOT, 'src', 'settings.default.json');
  if (!fs.existsSync(SETTINGS_PATH) && fs.existsSync(DEFAULT_PATH)) {
    fs.copyFileSync(DEFAULT_PATH, SETTINGS_PATH);
    console.log('[FIRST RUN] settings.default.json → aeon-settings.json');
  }
} catch (e) { console.warn('[FIRST RUN] settings guard failed:', e.message); }

// ── Services ──
const settingsService = require('../services/settings.js');
const { loadSettings, hydrateProviderSecrets } = settingsService;
hydrateProviderSecrets(process.env);
const cloudCredentialStore = settingsService.createCloudCredentialStore();
const vaultCrypto = require('../src/kernel/vault.cjs');
const vaultSync = require('../src/kernel/vaultSync.cjs');
const storage = require('../services/storage.js');
const { supabase } = require('../services/cloud.js');
const security = require('../security/security.js')({
  supabase,
  getLocalFile: storage.getLocalFile,
  WORKSPACE: storage.WORKSPACE,
  AUDIT_FILE: storage.AUDIT_FILE,
  SDI_VIOLATION_LOG: storage.SDI_VIOLATION_LOG,
});
const ai = require('../services/ai.js')({
  supabase,
  writeOSAudit: security.writeOSAudit,
  TOKEN_LEDGER_FILE: storage.TOKEN_LEDGER_FILE,
  loadSettings,
  aeonTerminalStream,
});
const search = require('../services/search.js')({
  writeOSAudit: security.writeOSAudit,
  kernelLLM: ai.kernelLLM,
});
const media = require('../services/media.js')({
  ROOT,
  writeOSAudit: security.writeOSAudit,
});
const system = require('../services/system.js')({
  ROOT,
  getLocalFile: storage.getLocalFile,
  logTrivial: storage.logTrivial,
  WORKSPACE: storage.WORKSPACE,
  writeOSAudit: security.writeOSAudit,
  kernelLLM: ai.kernelLLM,
});

// ── App + middleware stack (order preserved from the monolith) ──
const app = express();
app.use(security.correlationId);
app.use(security.corsMiddleware);
app.use(security.helmetMiddleware);
app.use(express.json({ limit: '10mb' }));
app.use(['/api', '/core', '/block'], security.apiLimiter);

// Root health check
app.get('/', (req, res, next) => {
  if (req.headers.accept && req.headers.accept.includes('text/html')) return next();
  res.json({ status: 'ok', runtime: isVercel ? 'cloud' : 'local', ts: Date.now() });
});

// Tunnel Bearer gate on /api
app.use('/api', security.tunnelGate);

// ── Dynamic earlyware — kernel hook for drag-in blocks (e.g. Security) ──
// Registered HERE, ahead of every router and block mount, but the list is
// mutable: a block mounted later can push a middleware and it still runs
// early in the chain for every request. This is how a cartridge adds
// cross-cutting policy (auth guard, no-store cache shield) without the
// kernel knowing the block exists.
// Registry is replace-by-id (see earlyware.cjs) — a Security rescan re-registers
// 'security-guardian' and REPLACES the prior instance instead of stacking one
// Guardian per rescan (BO4).
const earlyware = require('./earlyware.cjs').createEarlyware();
const registerEarlyMiddleware = (fn, label = 'anonymous') => {
  if (typeof fn !== 'function') return;
  const { replaced, count } = earlyware.register(fn, label);
  console.log(`[EARLYWARE] ${replaced ? '~' : '+'}${label} (${count} active)`);
};
app.use(earlyware.middleware);

// Chat log bootstrap
if (!fs.existsSync(storage.LOG_FILE)) {
  fs.writeFileSync(storage.LOG_FILE, JSON.stringify([
    { id: 1, sender: 'system', name: 'AEON_CORTEX', content: 'SYSTEM INITIALIZED. WAITING FOR CEO COMMAND.', time: new Date().toLocaleTimeString(), color: '#00f2ff' }
  ], null, 2));
}

// ── Web search ──
app.use('/api', search.router);

// ── Host telemetry + startup hygiene ──
system.startTelemetry();
storage.cleanupOrphans();

// ── Legacy modules/ plugin auto-discovery ──
const modulesPath = path.join(ROOT, 'modules');
if (fs.existsSync(modulesPath)) {
  const pluginFiles = fs.readdirSync(modulesPath).filter(file => file.endsWith('.js'));
  pluginFiles.forEach(file => {
    try {
      const dynamicRequire = eval('require');
      dynamicRequire(path.join(modulesPath, file))(app, security.validateSDI, ai.geminiRequest, security.writeOSAudit, supabase);
      console.log(`[SMART ROUTER] Successfully mounted plugin: ${file}`);
    } catch (err) {
      console.error(`[SMART ROUTER] Failed to mount plugin ${file}:`, err.message);
    }
  });
}

// ── Block loader — deps every cartridge can request ──
const baseDeps = {
  supabase,
  geminiRequest: ai.geminiRequest, groqRequest: ai.groqRequest, ollamaRequest: ai.ollamaRequest,
  validateSDI: security.validateSDI, writeOSAudit: security.writeOSAudit,
  path, fs, getLocalFile: storage.getLocalFile,
  fetchDuckDuckGo: search.fetchDuckDuckGo,
  fetchBraveSearch: search.fetchBraveSearch,
  fetchSerperSearch: search.fetchSerperSearch,
  fetchTavilySearch: search.fetchTavilySearch,
  fetchWebSearch: search.fetchWebSearch,
  kernelLLM: ai.kernelLLM,
  upload: storage.upload, videoUpload: storage.videoUpload,
  requireShellAuth: security.requireShellAuth, WORKSPACE: storage.WORKSPACE,
  ALLOWED_ROOTS: security.ALLOWED_ROOTS, SAFE_EXEC_PREFIXES: security.SAFE_EXEC_PREFIXES,
  INSTANT_PATTERNS: system.INSTANT_PATTERNS,
  LOG_FILE: storage.LOG_FILE, AUDIT_FILE: storage.AUDIT_FILE, NOTES_FILE: storage.NOTES_FILE,
  TOKEN_LEDGER_FILE: storage.TOKEN_LEDGER_FILE,
  registerEarlyMiddleware,
  isVercel, addRunCost: ai.addRunCost, getDailyCost: ai.getDailyCost,
  getProviderHealth: ai.getProviderHealth, getKeyPoolInfo: ai.getKeyPoolInfo,
  dehydrateProvider: ai.dehydrateProvider,
  _llmTelemetry: ai._llmTelemetry, loadSettings,
  GEMINI_KEY_POOL: ai.GEMINI_KEY_POOL, _trackLLM: ai._trackLLM,
  GEMINI_PRICE_PER_TOKEN: ai.GEMINI_PRICE_PER_TOKEN, GROQ_PRICE_PER_TOKEN: ai.GROQ_PRICE_PER_TOKEN,
  KILL_SWITCH_THRESHOLD: ai.KILL_SWITCH_THRESHOLD,
  aeonTerminalStream, TERMINAL_HISTORY_FILE: storage.TERMINAL_HISTORY_FILE,
  SDI_SCHEMAS: security.SDI_SCHEMAS, SDI_VIOLATION_LOG: storage.SDI_VIOLATION_LOG,
  runReaper: system.runReaper,
  activeStreams: media.activeStreams, processingJobs: media.processingJobs,
  finalizeVideoStitch: media.finalizeVideoStitch,
  VAULT_ROOT: storage.VAULT_ROOT, DATA_ROOT: storage.DATA_ROOT,
  getVaultFile: storage.getVaultFile, getDataFile: storage.getDataFile,
  getBlockVaultFile: storage.getBlockVaultFile, getBlockDataFile: storage.getBlockDataFile,
  vaultSync: vaultSync.vaultSync, requestIndex: vaultSync.requestIndex,
  getCloudCredentials: (provider) => cloudCredentialStore.credentials(provider),
  getCloudProviderMetadata: () => cloudCredentialStore.metadata(),
  vaultSeal: vaultCrypto.seal, vaultUnseal: vaultCrypto.unseal,
  requestRestart: () => {
    const restartScript = path.join(ROOT, 'restart.bat');
    if (fs.existsSync(restartScript)) {
      require('child_process').spawn('cmd.exe', ['/c', restartScript], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
    } else {
      process.exit(0);
    }
  },
  defaultLocalModel: ai.defaultLocalModel,
  localRuntimePresent: ai.localRuntimePresent,
  DEFAULT_LOCAL_MODEL: ai.defaultLocalModel(), // legacy snapshot for old block deps
};

// ── /api/ping — liveness probe, deliberately mounted BEFORE the auth gate ──
// The terminal CLI (tools/aeon-cli.cjs) uses this to choose Connected vs
// Standalone mode. It must answer while the vault is locked, otherwise a
// locked server is indistinguishable from no server at all and the CLI would
// wrongly fall back to spinning up its own runtime against the same data dir.
// Kept deliberately thin: liveness + whether auth is required. No block list,
// no model names, no paths — nothing here is worth reading unauthenticated.
app.get('/api/ping', (req, res) => {
  let authRequired = false;
  try {
    const sessions = require('../src/kernel/server-utils/sessionValidator.cjs');
    authRequired = sessions.guardActive(sessions.loadPolicy());
  } catch {}
  res.json({
    ok: true,
    name: 'aeon',
    version: require('../package.json').version,
    portable: process.env.AEON_PORTABLE === 'true',
    authRequired,
    uptime: Math.floor(process.uptime()),
  });
});

// ── Operator auth gate — MUST mount before any block/kernel routes ──
// Security owns /api/auth/*; the kernel enforces its Vault-backed policy.
const _authGate = require('../src/kernel/authGate.cjs');
_authGate.mountAuth(app);
app.use(_authGate.guard);

const loader = require('./block-loader.js')({ app, ROOT, isVercel, loadSettings, baseDeps });

// ── Kernel router mounts (namespace separation) ──
const _skippedRoutes = [];
const _routerDeps = {
  _blockRegistry: loader.blockRegistry, _blockReadiness: loader.blockReadiness,
  _loadSettings: loadSettings, _llmTelemetry: ai._llmTelemetry,
  getDailyCost: ai.getDailyCost, isVercel, fs, path,
  kernelLLM: ai.kernelLLM, kernelVision: ai.kernelVision, _trackLLM: ai._trackLLM,
  _skippedRoutes, getLocalFile: storage.getLocalFile, aeonTerminalStream,
  getProviderHealth: ai.getProviderHealth, confirmLocal: ai.confirmLocal, isLocalConfirmed: ai.isLocalConfirmed,
  getKeyPoolInfo: ai.getKeyPoolInfo, VAULT_ROOT: storage.VAULT_ROOT,
};

// Build pipeline + approvals + IDE mode + BGI Store
try {
  const _approvals = require('../src/kernel/approvals.cjs');
  const _ideMode = require('../src/kernel/ideMode.cjs');
  const { createBuildPipeline } = require('../src/kernel/buildPipeline.cjs');
  const _vault = require('../src/kernel/vault.cjs');
  const _pipeline = createBuildPipeline({
    getVaultSecrets: async () => { try { return await _vault.listRefs(supabase); } catch { return []; } },
    rescan: (reason) => loader.rescan(reason),
  });
  const buildRouter = require('../src/kernel/routers/build.cjs')({
    pipeline: _pipeline, approvals: _approvals, ideMode: _ideMode,
    kernelRescan: (reason) => loader.rescan(reason),
  });
  app.use('/api/build', buildRouter);
  _routerDeps.ideMode = _ideMode;
  if (!isVercel) setInterval(() => { try { _approvals.checkStaleQueue(); } catch {} }, 3600 * 1000).unref();
  console.log('[BUILD PIPELINE] /api/build mounted — envelope→gate→staging→approve→promote→rescan→live');

  const storeRouter = require('../src/kernel/routers/store.cjs')({ pipeline: _pipeline });
  app.use('/api/store', storeRouter);
  console.log('[BGI STORE] /api/store mounted — catalog + purchase-screen perms + install via airlock');
} catch (e) { console.error('[BUILD PIPELINE] mount failed:', e.message); }

// Scoped retrieval + citation gate
try {
  const retrievalRouter = require('../src/kernel/routers/retrieval.cjs')({ kernelLLM: ai.kernelLLM, fetchDuckDuckGo: search.fetchDuckDuckGo });
  app.use('/api/retrieval', retrievalRouter);
  console.log('[RETRIEVAL] /api/retrieval mounted — scoped indexes + citation gate (classes 1-4)');
} catch (e) { console.error('[RETRIEVAL] mount failed:', e.message); }

// Command Registry — Terminal 2.0 command bus (manifest-as-truth)
try {
  const commandRegistry = require('../src/kernel/commandRegistry.cjs')({
    blockReadiness: loader.blockReadiness, isVercel, writeOSAudit: security.writeOSAudit,
  });
  app.use('/api', commandRegistry.router);
  _routerDeps.commandRescan = commandRegistry.rescan;
  console.log('[CMD REGISTRY] /api/commands mounted — manifest-discovered, kernel-gated dispatch');
} catch (e) { console.error('[CMD REGISTRY] mount failed:', e.message); }

const coreRouter = require('../src/kernel/routers/core.cjs')(_routerDeps);
const telemetryRouter = require('../src/kernel/routers/telemetry.cjs')(_routerDeps);
const aiRouter = require('../src/kernel/routers/ai.cjs')(_routerDeps);
const blocksRouter = require('../src/kernel/routers/blocks.cjs')(_routerDeps);
const eventsRouter = require('../src/kernel/routers/events.cjs')(_routerDeps);

// God Mode — kernel-level terminal superpowers (desktop only, never cloud)
if (!isVercel) {
  try {
    const godRouter = require('../src/kernel/routers/god.cjs')({
      storage, kernelLLM: ai.kernelLLM,
      _blockRegistry: loader.blockRegistry, _blockReadiness: loader.blockReadiness,
    });
    app.use('/api/god', godRouter);
    console.log('[GOD MODE] /api/god mounted — blocks, data reader, vault drops, model hotswap, key adds');
  } catch (e) { console.error('[GOD MODE] mount failed:', e.message); }
}

// Canonical paths
app.use('/core', coreRouter);
app.use('/core/telemetry', telemetryRouter);
app.use('/api/ai', aiRouter);
app.use('/blocks', blocksRouter);
app.use('/events', eventsRouter);

// Backward-compat aliases
app.use('/api/system', coreRouter);
app.get('/api/system/context', (req, res) => res.redirect(307, '/core/state'));
app.get('/api/kernel/health', (req, res) => res.redirect(307, '/core/health'));
app.post('/api/kernel/llm', (req, res, next) => { req.url = '/'; aiRouter(req, res, next); });
app.use('/api/llm-telemetry', telemetryRouter);
app.use('/api/blocks', blocksRouter);

// Token Heatmap — daily activity for the dashboard heatmap/activity charts
try {
  const tokenAnalyticsRouter = require('../src/blocks/activity/api/token-analytics.cjs')({
    getLocalFile: storage.getLocalFile, AUDIT_FILE: storage.AUDIT_FILE,
    LOG_FILE: storage.LOG_FILE, TOKEN_LEDGER_FILE: storage.TOKEN_LEDGER_FILE,
  });
  app.use('/api', tokenAnalyticsRouter);
  if (tokenAnalyticsRouter._recordActivity) ai.setActivityRecorder(tokenAnalyticsRouter._recordActivity);
  console.log('[TOKEN HEATMAP] Routes mounted: /api/token-analytics/*');
} catch (e) {
  console.error('[TOKEN HEATMAP] Mount failed:', e.message);
}

// Second Brain RAG
const _sbDeps = {
  supabase, isVercel, geminiRequest: ai.geminiRequest,
  VAULT_ROOT: storage.VAULT_ROOT, DATA_ROOT: storage.DATA_ROOT,
};
try {
  const sbIngest = require('../src/blocks/aeon_matrix/api/ingest.cjs')(_sbDeps);
  const sbRetrieve = require('../src/blocks/aeon_matrix/api/retrieve.cjs')(_sbDeps);
  // Locally the block loader already dual-mounts second_brain/api/*.cjs; on
  // Vercel the static mounts list doesn't include it, so mount here for that case.
  if (isVercel) {
    app.use('/api', sbRetrieve);
    app.use('/api', sbIngest);
  }
  console.log('[SECOND BRAIN] RAG routes ready: /api/crn/second-brain/retrieve, /api/crn/second-brain/ingest/*');

  // Coalesce block memory writes into one Matrix refresh instead of a scan per write.
  let matrixIndexTimer = null;
  vaultSync.setIndexScheduler(() => {
    if (isVercel || typeof sbIngest.runSecondBrainScan !== 'function') return;
    clearTimeout(matrixIndexTimer);
    matrixIndexTimer = setTimeout(() => {
      sbIngest.runSecondBrainScan().catch(e => console.error('[SECOND BRAIN] Memory refresh failed:', e.message));
    }, 500);
    matrixIndexTimer.unref?.();
  });

  // Boot auto-sync (aeon-213 pattern): incremental scan EVERY boot, delayed,
  // background, non-fatal. First boot does the full index; later boots pick
  // up new/changed/deleted docs so the index never needs a manual /index-brain.
  if (!isVercel && typeof sbIngest.readSecondBrainStatus === 'function') {
    const status = sbIngest.readSecondBrainStatus();
    const kind = status.lastRun ? 'incremental' : 'first-time';
    setTimeout(() => {
      console.log(`[SECOND BRAIN] Boot auto-sync (${kind}) starting in background...`);
      sbIngest.runSecondBrainScan().then(r => {
        console.log(`[SECOND BRAIN] Boot sync complete: ${r.ingested} ingested, ${r.skipped} skipped, ${r.deleted} deleted.`);
      }).catch(e => console.error('[SECOND BRAIN] Boot sync failed (non-fatal):', e.message));
    }, 15000).unref();
  }
} catch (e) {
  console.error('[SECOND BRAIN] RAG mount failed:', e.message);
}

console.log('[KERNEL] Route namespaces mounted: /core, /core/telemetry, /api/ai, /blocks, /events');

// Auto-Pilot daemon
try {
  require('../tools/autopilot-daemon.cjs').setupAutopilot(app);
} catch (e) {
  console.error('[AEON] Failed to mount Auto-Pilot daemon:', e);
}

// ── Serve the built SPA (tunnel + production) ──
const DIST = path.join(ROOT, 'dist');
if (fs.existsSync(path.join(DIST, 'index.html'))) {
  app.use(express.static(DIST));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/events') || req.path.startsWith('/ws') || req.path.startsWith('/core') || req.path.startsWith('/block/')) return next();
    res.sendFile(path.join(DIST, 'index.html'));
  });
}

// ── Global error handler (zero-trust) ──
app.use((err, req, res, next) => {
  console.error('[CRITICAL] Unhandled Middleware Error:', err);
  if (typeof global.broadcastTerminalEvent === 'function') {
    global.broadcastTerminalEvent('CRIT', `Internal Router Fault: ${err.message}`);
  }
  const exposeDetail = process.env.NODE_ENV !== 'production';
  res.status(err.status || 500).json({
    correlation_id: req.correlationId || 'AEON-SYS',
    error: 'Internal Core Error.',
    ...(exposeDetail ? { message: err.message } : {}),
  });
});

// ── Startup with port-conflict handling ──
// Respect PORT env (test boots, alternate deploys); default stays 3001.
const PORT = Number(process.env.PORT) || 3001;

const startServer = () => {
  const httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n====================================`);
    console.log(`  AEON Jarvis OS — Kernel v5`);
    console.log(`  Kernel Routes: /core, /core/telemetry, /api/ai`);
    console.log(`  Block Routes:  /block/:id/* + /api/* (compat)`);
    console.log(`  Events:        /events (SSE)`);
    console.log(`  WebSocket:     /ws`);
    console.log(`  OS Exec: ONLINE (Allowlist Secured)`);
    console.log(`  Audit Trail: ONLINE`);
    console.log(`  Port: ${PORT}`);
    console.log(`====================================\n`);

    try {
      require('../src/kernel/ws.cjs')(httpServer, { aeonTerminalStream });
    } catch (e) {
      console.error('[KERNEL] WebSocket attach failed:', e.message);
    }

    // If a vendored (contained-in-AEON) Ollama is installed, start its daemon
    // once at boot — a system install auto-starts as a background service,
    // but the vendored copy has no such service, so without this any block
    // that dials OLLAMA_HOST (chat, council, ...) before Cookbook happens to
    // spin it up first would just get connection-refused. Non-blocking,
    // best-effort: cloud AI still works immediately regardless.
    (async () => {
      try {
        if (process.env.OLLAMA_HOST) return; // operator pointed at their own instance — don't touch it
        const ollamaVendor = require('../services/ollamaVendor.js');
        const vendorDir = path.join(storage.DATA_ROOT, 'cookbook', 'runtime', 'ollama');
        const bin = ollamaVendor.vendoredBin(vendorDir);
        if (!bin) return;
        const host = 'http://localhost:11434';
        try {
          const r = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(1200) });
          if (r.ok) return; // already running
        } catch {}
        const modelsDir = path.join(storage.DATA_ROOT, 'cookbook', 'models', 'ollama');
        fs.mkdirSync(modelsDir, { recursive: true });
        const proc = require('child_process').spawn(bin, ['serve'], { env: { ...process.env, OLLAMA_MODELS: modelsDir }, detached: true, stdio: 'ignore', windowsHide: true });
        proc.unref();
        console.log('[KERNEL] Started vendored Ollama daemon (contained inside AEON).');
      } catch {}
    })();
  }).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${PORT} in use. Killing zombie and retrying...`);
      try {
        require('child_process').execSync(
          `for /f "tokens=5" %a in ('netstat -ano ^| findstr :${PORT} ^| findstr LISTENING') do taskkill /F /PID %a`,
          { shell: 'cmd.exe', stdio: 'ignore' }
        );
      } catch (e) { /* port already free */ }
      setTimeout(startServer, 1000);
    } else {
      console.error('Server error:', err);
    }
  });
};

if (isVercel) {
  module.exports = app;
} else {
  startServer();
  system.startTaskCron();
}

// ── Process-level crash guards ──
process.on('unhandledRejection', (reason) => {
  console.error('[CRITICAL] Unhandled Promise Rejection:', reason);
  if (typeof global.broadcastTerminalEvent === 'function') {
    global.broadcastTerminalEvent('CRIT', `Unhandled rejection: ${reason && reason.message ? reason.message : reason}`);
  }
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err);
  if (typeof global.broadcastTerminalEvent === 'function') {
    global.broadcastTerminalEvent('CRIT', `Uncaught exception: ${err.message}`);
  }
  process.exit(1);
});

// Graceful shutdown hooks
const shutdown = (sig) => {
  console.log(`${sig} signal received: closing server.`);
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
