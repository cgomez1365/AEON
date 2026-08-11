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
  let lastSkipped = [];             // API modules the last rescan could not mount
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

  /**
   * Is this value something Express can actually mount?
   *
   * Checked structurally, not by `.name === 'router'`. The name is a minifier-
   * and version-dependent implementation detail of Express; the stack is the
   * thing that makes it mountable.
   */
  function isMountableRouter(v) {
    return typeof v === 'function' && typeof v.use === 'function' && Array.isArray(v.stack);
  }

  function mountBlock(router, folder, manifest) {
    const result = { mounted: 0, skipped: [] };
    const apiDir = path.join(blocksDir, folder, 'api');
    if (!fs.existsSync(apiDir)) return result;
    const blockDeps = createScopedDeps(baseDeps, manifest, folder);
    blockDeps.lifecycle = makeLifecycle(folder);

    const skip = (file, why) => {
      result.skipped.push({ block: folder, file, why });
      // R-05: a module that contributes no routes is a silent failure unless it
      // is said out loud. This was how fleet_control/local-status.js went
      // missing — an arity-1 `(app) => …` plugin receives blockDeps, calls .get
      // on the sandbox proxy, is denied, and returns a bare handler. The old
      // code counted it as mounted and moved on.
      log.error(`[BLOCK HOST] NOT MOUNTED: ${folder}/${file} — ${why}`);
    };

    const apiFiles = fs.readdirSync(apiDir).filter(f => (f.endsWith('.js') || f.endsWith('.cjs')) && !f.startsWith('_'));
    for (const file of apiFiles) {
      try {
        const dynamicRequire = eval('require');
        const factory = dynamicRequire(path.join(apiDir, file));

        if (isMountableRouter(factory)) {
          // Shape 1 — the module exports a ready-made router.
          router.use(`/block/${folder}`, gateRunning(folder, factory, { exclusive: true }));
          router.use('/api', gateRunning(folder, factory));
        } else if (typeof factory !== 'function') {
          skip(file, `export is ${factory === null ? 'null' : typeof factory}, expected a function or a router`);
          continue;
        } else if (factory.length === 1) {
          // Shape 2 — a factory that receives deps and RETURNS a router.
          // An arity-1 module that instead registers on its argument is
          // indistinguishable here by signature, so it is caught by its return
          // value and reported rather than dropped.
          const produced = factory(blockDeps);
          if (!isMountableRouter(produced)) {
            skip(file, 'arity-1 factory did not return an Express router '
              + '(a `(app) => { app.get(...) }` plugin must declare a second parameter '
              + 'so it is mounted as `(router, deps)`)');
            continue;
          }
          router.use(`/block/${folder}`, gateRunning(folder, produced, { exclusive: true }));
          router.use('/api', gateRunning(folder, produced));
        } else {
          // Shape 3 — plugin: registers verbs directly on the router it is
          // handed. The inner router quacks enough like `app` (verified: only
          // get/post/put/delete in use) and is discarded on rescan, which is
          // what makes these tear-downable. Run-state gating applies here too.
          const sub = express.Router();
          factory(sub, blockDeps);
          if (!sub.stack.length) {
            skip(file, `plugin (arity ${factory.length}) registered zero routes`);
            continue;
          }
          router.use(gateRunning(folder, sub));
        }
        result.mounted++;
      } catch (e) {
        skip(file, `threw during mount: ${e.message}`);
      }
    }
    return result;
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
      // syncAllBlocks() writes manifests to blockStandard's OWN module-level
      // BLOCKS_DIR — it does not take a directory. A host pointed anywhere
      // else (the M3 boot proof mounts from staging/) would therefore rewrite
      // the CANONICAL tree as a side effect of mounting a different one.
      //
      // That is how the settings manifest was corrupted on 2026-08-10: several
      // boot proofs ran in parallel test workers, each triggering a sync of
      // src/blocks, and one read a manifest another was mid-write on. It got
      // normalizeManifest's defaults — description '', category 'system',
      // permissions downgraded — and wrote them back.
      //
      // Sync only when this host actually manages the canonical directory.
      const { BLOCKS_DIR } = require('./blocksDir.cjs');
      if (path.resolve(blocksDir) === path.resolve(BLOCKS_DIR)) {
        const ctx = typeof getSyncCtx === 'function' ? getSyncCtx() : {};
        synced = blockStandard.syncAllBlocks(ctx);
      }
    } catch (e) { log.warn(`[BLOCK HOST] block standard sync failed: ${e.message}`); }

    const fresh = express.Router();
    registry.length = 0;
    for (const k of Object.keys(readiness)) delete readiness[k];

    let mounted = 0;
    const skipped = [];
    for (const folder of folders) {
      let manifest = null;
      try { manifest = JSON.parse(fs.readFileSync(path.join(blocksDir, folder, 'block.manifest.json'), 'utf8')); } catch {}
      registry.push(manifest || { id: folder, label: folder, tier: 'unknown' });
      const s = synced.find(b => b.id === folder);
      if (s) readiness[folder] = s.readiness;
      const r = mountBlock(fresh, folder, manifest);
      mounted += r.mounted;
      skipped.push(...r.skipped);
    }

    inner = fresh;
    generation++;
    lastSkipped = skipped;
    const ms = Date.now() - t0;
    log.log(`[BLOCK HOST] rescan(${reason}) gen ${generation}: ${folders.length} blocks, ${mounted} API mounts, ${ms}ms`);
    // The count above is now routes actually mounted, not files processed.
    // A non-empty skip list means the UI is calling something nothing serves.
    if (skipped.length) {
      log.error(`[BLOCK HOST] ${skipped.length} API module(s) did not mount: `
        + skipped.map(s => `${s.block}/${s.file}`).join(', '));
    }
    return { ok: true, generation, blocks: folders.length, mounted, skipped, ms, reason };
  }

  return {
    router: trampoline,
    rescan,
    /**
     * Tear down every mounted block without remounting — the same teardown
     * rescan() performs, exposed so a caller that is FINISHED with a host can
     * stop its timers and listeners. Used by the M3 boot proof: a proof that
     * leaks an interval into the parent process has changed the thing it was
     * measuring.
     */
    dispose() {
      for (const id of [...lifecycles.keys()]) teardownBlock(id);
      inner = express.Router();
    },
    getGeneration: () => generation,
    getSkipped: () => lastSkipped.slice(),
    _lifecycles: lifecycles, // exposed for tests (test-hotreload.cjs)
  };
}

module.exports = { createBlockHost };
