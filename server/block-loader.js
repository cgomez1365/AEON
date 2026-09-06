/**
 * AEON Jarvis — Block Auto-Loader (Brain Stem)
 * Cartridge discovery for src/blocks/: normalizes every manifest
 * (Block Standard boot sync), scopes deps per manifest permissions,
 * and mounts every block's API routes through the rebuildable block
 * host. Drop a block folder with a manifest → auto-detected at boot,
 * kernel.rescan() hot-remounts without touching the middleware stack.
 */
const fs = require('fs');
const path = require('path');
const { createBlockStorage } = require('../src/kernel/blockStorage.cjs');

module.exports = ({ app, ROOT, isVercel, loadSettings, baseDeps }) => {

  // ── Block Standard boot sync — manifest-as-truth, heals drift ──
  const _blockReadiness = {};
  (function syncBlockStandard() {
    let blockStandard;
    try { blockStandard = require('../src/kernel/blockStandard.cjs'); }
    catch (e) { console.warn('[BLOCK STANDARD] unavailable:', e.message); return; }

    const models = {};
    try {
      const s = loadSettings();
      for (const [role, cfg] of Object.entries(s.models || {})) models[role] = { provider: cfg.provider, model: cfg.model };
    } catch {}

    let requireLogin = false;
    try { requireLogin = !!(loadSettings().prefs && loadSettings().prefs.require_login); } catch {}

    const ctx = { apiBase: '/api', runtime: isVercel ? 'cloud' : 'local', requireLogin, models, writeRuntime: !isVercel };
    try {
      if (isVercel) {
        for (const f of blockStandard.listBlockFolders()) {
          const m = blockStandard.normalizeManifest(f);
          _blockReadiness[f] = blockStandard.checkReadiness(m, process.env);
        }
      } else {
        const reg = blockStandard.syncAllBlocks(ctx);
        reg.forEach(b => { _blockReadiness[b.id] = b.readiness; });
        const ready = reg.filter(b => b.readiness.ready).length;
        console.log(`[BLOCK STANDARD] Synced ${reg.length} blocks · ${ready} ready · runtime configs flashed.`);
      }
    } catch (e) { console.warn('[BLOCK STANDARD] sync failed:', e.message); }
  })();

  // ── Block sandbox — scope deps per manifest permissions ──
  function createScopedDeps(base, manifest, blockId) {
    const scoped = { ...base };
    const perms = manifest?.contract?.permissions || {};
    const usesScopedStorage = manifest?.contract?.storage?.access === 'scoped';

    // BO-SHIP P2.2 — blockStorage is offered to EVERY block, not only to ones
    // already declaring scoped access.
    //
    // Before this, the surface a block was supposed to migrate to did not exist
    // until after it had migrated. That circularity is why all 17 shipped
    // blocks were still 'compatibility' and why every one of them reached for
    // require('fs') instead: the sanctioned path was unavailable at the moment
    // anyone would have taken it.
    //
    // Handing it out unconditionally costs nothing — it grants no capability a
    // block does not already have via the broad resolvers — and it lets a block
    // port in one commit and flip its manifest in the next.
    if (perms.filesystem !== 'none') {
      scoped.blockStorage = createBlockStorage({
        blockId,
        contract: manifest.contract,
        getBlockDataFile: base.getBlockDataFile,
        getBlockVaultFile: base.getBlockVaultFile,
        vaultSync: base.vaultSync,
        requestIndex: base.requestIndex,
      });
    }

    if (usesScopedStorage && perms.filesystem !== 'none') {
      // A scoped block must use its declared surface, so the broad resolvers go.
      delete scoped.VAULT_ROOT;
      delete scoped.DATA_ROOT;
      delete scoped.getVaultFile;
      delete scoped.getDataFile;
    }

    if (perms.secrets === false) {
      delete scoped.GEMINI_KEY_POOL;
    }
    if (perms.shell === false) {
      delete scoped.requireShellAuth;
      delete scoped.SAFE_EXEC_PREFIXES;
      delete scoped.INSTANT_PATTERNS;
    }
    if (perms.filesystem === 'none') {
      delete scoped.WORKSPACE;
      delete scoped.ALLOWED_ROOTS;
      delete scoped.HOME_ROOT;
      delete scoped.blockStorage;
    }
    if (perms.ai === false) {
      delete scoped.kernelLLM;
      delete scoped.geminiRequest;
      delete scoped.groqRequest;
      delete scoped.ollamaRequest;
      delete scoped.GEMINI_KEY_POOL;
    }
    if (blockId !== 'security') {
      delete scoped.getCloudCredentials;
      delete scoped.getCloudProviderMetadata;
      delete scoped.vaultSeal;
      delete scoped.vaultUnseal;
      delete scoped.requestRestart;
    }
    // Early middleware is the most powerful dep there is (it sees every
    // request). Only blocks that explicitly declare it may register.
    if (perms.middleware !== 'early') {
      delete scoped.registerEarlyMiddleware;
    }

    return new Proxy(scoped, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop === 'string' && !prop.startsWith('_')) {
          console.warn(`[SANDBOX] Block "${blockId}" accessed denied dep: ${prop}`);
        }
        return undefined;
      }
    });
  }

  // ── Dynamic block router — mounts every src/blocks/*/ with api_routes ──
  const _blockRegistry = [];
  let _blockHost = null;

  if (isVercel && typeof global.mountStaticBlocks === 'function') {
    console.log('[BLOCK ROUTER] Running in Vercel mode. Using explicit static mounts.');
    // Cloud and local now resolve dependencies through the SAME contract.
    // Previously this path passed a hardcoded 13-key object to every block:
    // manifest permissions were a local-only guarantee (principle 02), and any
    // block expecting a dep outside those 13 got undefined — which is why
    // dashboard/chat 500'd on every AI message in production.
    const manifestCache = new Map();
    const depsFor = (blockId) => {
      if (!manifestCache.has(blockId)) {
        let manifest = null;
        try {
          manifest = JSON.parse(fs.readFileSync(
            path.join(ROOT, 'src', 'blocks', blockId, 'block.manifest.json'), 'utf8'));
        } catch { manifest = null; }
        manifestCache.set(blockId, createScopedDeps({ ...baseDeps, path, fs }, manifest, blockId));
      }
      return manifestCache.get(blockId);
    };
    global.mountStaticBlocks(app, { ...baseDeps, path, fs }, depsFor);
  } else {
    const blocksDir = path.join(ROOT, 'src', 'blocks');
    if (!fs.existsSync(blocksDir)) {
      console.warn('[BLOCK ROUTER] src/blocks/ not found.');
    } else {
      const { createBlockHost } = require('../src/kernel/blockHost.cjs');
      _blockHost = createBlockHost({
        blocksDir, baseDeps, createScopedDeps,
        registry: _blockRegistry,
        readiness: _blockReadiness,
        getSyncCtx: () => {
          const models = {};
          let requireLogin = false;
          try {
            const s = loadSettings();
            for (const [role, cfg] of Object.entries(s.models || {})) models[role] = { provider: cfg.provider, model: cfg.model };
            requireLogin = !!(s.prefs && s.prefs.require_login);
          } catch {}
          return { apiBase: '/api', runtime: isVercel ? 'cloud' : 'local', requireLogin, models, writeRuntime: !isVercel };
        },
      });
      app.use(_blockHost.router);
      const boot = _blockHost.rescan('boot');
      const _skipNote = boot.skipped && boot.skipped.length
        ? ` ${boot.skipped.length} NOT MOUNTED.` : '';
      console.log(`[BLOCK ROUTER v2] Scanned ${boot.blocks} blocks. Mounted ${boot.mounted} API routes.${_skipNote}`);
    }
  }

  return {
    blockRegistry: _blockRegistry,
    blockReadiness: _blockReadiness,
    blockHost: _blockHost,
    rescan: (reason) => _blockHost ? _blockHost.rescan(reason) : { ok: false, error: 'rescan unavailable' },
  };
};
