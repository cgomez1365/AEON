/**
 * B6 — Block host: hot-reload as FULL teardown-and-remount, never a diff.
 * (Ship Plan v2, Month 3. Accepts the remount cost in exchange for predictability.)
 *
 * The host owns a single inner Express router that is thrown away and rebuilt
 * on every rescan(). server.cjs mounts only the stable trampoline, so remounts
 * never touch the app's middleware stack (Express cannot unmount — this
 * indirection is what makes kernel.rescan() possible without a reboot).
 *
 * The six failure modes and where each is handled:
 *   1. Memory leaks       → blocks register lifecycle.onCleanup(fn); all hooks
 *                           run before teardown, errors isolated per hook.
 *   2. Duplicate listeners→ lifecycle.listen(emitter, evt, fn) records every
 *                           subscription; torn down atomically per block.
 *   3. React state        → frontend: blockRegistry mounts blocks per-route with
 *                           key={id}; a registry refetch forces full unmount/
 *                           remount. Kernel side exposes generation counter so
 *                           the UI knows a remount happened.
 *   4. Module cache       → require.cache entries under each block dir deleted
 *                           before reimport, every rescan, unconditionally.
 *   5. Circular imports   → staging lint 'circular-import' check blocks promote
 *                           (see staging.cjs detectCircularImports).
 *   6. Zombie timers      → lifecycle.setInterval/setTimeout are tracked;
 *                           cleared atomically on teardown.
 *
 * Blocks that ignore the lifecycle still work (it's additive to deps), but
 * anything they leak survives remount — the lint template README documents this.
 */
const express = require('express');
const path = require('path');
const fs = require('fs');

function createBlockHost({ blocksDir, baseDeps, createScopedDeps, registry, readiness, getSyncCtx, log = console }) {
  let inner = express.Router();     // replaced wholesale on every rescan
  let generation = 0;               // bumps per rescan — UI remount signal (#3)
  const lifecycles = new Map();     // blockId → { cleanups, timers, listeners }

  // Stable trampoline — the ONLY thing server.cjs ever mounts.
  const trampoline = (req, res, next) => inner(req, res, next);

  function makeLifecycle(blockId) {
    const lc = { cleanups: [], timers: new Set(), listeners: [] };
    lifecycles.set(blockId, lc);
    return {
      onCleanup: (fn) => { if (typeof fn === 'function') lc.cleanups.push(fn); },
      setInterval: (fn, ms, ...a) => { const t = setInterval(fn, ms, ...a); lc.timers.add(t); return t; },
      setTimeout:  (fn, ms, ...a) => { const t = setTimeout(fn, ms, ...a); lc.timers.add(t); return t; },
      clearInterval: (t) => { clearInterval(t); lc.timers.delete(t); },
      clearTimeout:  (t) => { clearTimeout(t); lc.timers.delete(t); },
      listen: (emitter, evt, fn) => { emitter.on(evt, fn); lc.listeners.push({ emitter, evt, fn }); return fn; },
    };
  }

  function teardownBlock(blockId) {
    const lc = lifecycles.get(blockId);
    if (!lc) return;
    // Order matters: cleanup hooks (#1) may still need timers/listeners alive.
    for (const fn of lc.cleanups) { try { fn(); } catch (e) { log.warn(`[BLOCK HOST] ${blockId} cleanup() threw: ${e.message}`); } }
    for (const { emitter, evt, fn } of lc.listeners) { try { emitter.removeListener(evt, fn); } catch {} }   // (#2)
    for (const t of lc.timers) { clearTimeout(t); clearInterval(t); }                                        // (#6)
    lifecycles.delete(blockId);
  }

  function purgeRequireCache(dir) {                                                                          // (#4)
    const prefix = path.resolve(dir) + path.sep;
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(prefix)) delete require.cache[key];
    }
  }

  // Interruption mode: pipeline-built blocks are manual start/stop. A stopped
  // block keeps its mounts but the kernel refuses for it — enforced here, not
  // trusted to block code. Hand-built blocks are mode:auto and unaffected.
  let runState = null;
  try { runState = require('./runState.cjs'); } catch {}

  // Would this router handle the request? Regexp-match only — no handler runs,
  // so a stopped block can't cause side effects during the probe. Needed because
  // all blocks share the /api mount: refusing before matching would 503 every
  // other block's traffic whenever one stopped block exists.
  function routerMatches(router, req) {
    const url = (req.url || '/').split('?')[0];
    const method = req.method.toLowerCase();
    return (router.stack || []).some(layer => {
      if (!layer.regexp || !layer.regexp.test(url)) return false;
      if (layer.route) return !!(layer.route.methods[method] || layer.route.methods._all);
      return true; // matching nested middleware/router prefix
    });
  }

  function gateRunning(folder, handler, { exclusive = false } = {}) {
    if (!runState) return handler;
    return (req, res, next) => {
      if (runState.isRunning(folder)) return handler(req, res, next);
      if (!exclusive && !routerMatches(handler, req)) return next(); // not this block's route
      res.status(503).json({ error: `block "${folder}" is stopped (manual-start block)`, hint: `POST /api/build/blocks/${folder}/start` });
    };
  }

  function mountBlock(router, folder, manifest) {
    const apiDir = path.join(blocksDir, folder, 'api');
    if (!fs.existsSync(apiDir)) return 0;
    const blockDeps = createScopedDeps(baseDeps, manifest, folder);
    blockDeps.lifecycle = makeLifecycle(folder);

    let mounted = 0;
    const apiFiles = fs.readdirSync(apiDir).filter(f => (f.endsWith('.js') || f.endsWith('.cjs')) && !f.startsWith('_'));
    for (const file of apiFiles) {
      try {
        const dynamicRequire = eval('require');
        const factory = dynamicRequire(path.join(apiDir, file));
        if (typeof factory !== 'function') continue;
        if (factory.name === 'router' || (typeof factory.use === 'function' && Array.isArray(factory.stack))) {
          router.use(`/block/${folder}`, gateRunning(folder, factory, { exclusive: true }));
          router.use('/api', gateRunning(folder, factory));
        } else if (factory.length === 1) {
          const result = factory(blockDeps);
          if (result && result.name === 'router') {
            router.use(`/block/${folder}`, gateRunning(folder, result, { exclusive: true }));
            router.use('/api', gateRunning(folder, result));
          }
        } else {
          // Plugin pattern registers verbs directly; the inner router quacks
          // enough like `app` (verified: only get/post/put/delete in use) and
          // is discarded on rescan, which is what makes these tear-downable.
          // Run-state gating: plugins register on a per-block sub-router that
          // is itself gated, preserving interruption for this pattern too.
          const sub = express.Router();
          factory(sub, blockDeps);
          router.use(gateRunning(folder, sub));
        }
        mounted++;
      } catch (e) {
        log.error(`[BLOCK HOST] Failed: ${folder}/${file}: ${e.message}`);
      }
    }
    return mounted;
  }

  /**
   * B4 tail: teardown → cache purge → manifest sync (index refresh +
   * .aeon.runtime.json flash) → rebuild router → registry/readiness refreshed
   * in place (same array/object identity — kernel routers hold references).
   */
  function rescan(reason = 'manual') {
    const t0 = Date.now();

    for (const id of [...lifecycles.keys()]) teardownBlock(id);

    const folders = fs.existsSync(blocksDir)
      ? fs.readdirSync(blocksDir).filter(f => {
          if (f.startsWith('_')) return false; // _template never mounts (K2)
          try { return fs.statSync(path.join(blocksDir, f)).isDirectory(); } catch { return false; }
        })
      : [];

    for (const f of folders) purgeRequireCache(path.join(blocksDir, f));

    // Manifest-as-truth refresh: normalize + readiness + runtime flash.
    // Invalid manifests are skipped without cascading (K3 idempotency rule).
    let synced = [];
    try {
      const blockStandard = require('./blockStandard.cjs');
      const ctx = typeof getSyncCtx === 'function' ? getSyncCtx() : {};
      synced = blockStandard.syncAllBlocks(ctx);
    } catch (e) { log.warn(`[BLOCK HOST] block standard sync failed: ${e.message}`); }

    const fresh = express.Router();
    registry.length = 0;
    for (const k of Object.keys(readiness)) delete readiness[k];

    let mounted = 0;
    for (const folder of folders) {
      let manifest = null;
      try { manifest = JSON.parse(fs.readFileSync(path.join(blocksDir, folder, 'block.manifest.json'), 'utf8')); } catch {}
      registry.push(manifest || { id: folder, label: folder, tier: 'unknown' });
      const s = synced.find(b => b.id === folder);
      if (s) readiness[folder] = s.readiness;
      mounted += mountBlock(fresh, folder, manifest);
    }

    inner = fresh;
    generation++;
    const ms = Date.now() - t0;
    log.log(`[BLOCK HOST] rescan(${reason}) gen ${generation}: ${folders.length} blocks, ${mounted} API mounts, ${ms}ms`);
    return { ok: true, generation, blocks: folders.length, mounted, ms, reason };
  }

  return {
    router: trampoline,
    rescan,
    getGeneration: () => generation,
    _lifecycles: lifecycles, // exposed for tests (test-hotreload.cjs)
  };
}

module.exports = { createBlockHost };
