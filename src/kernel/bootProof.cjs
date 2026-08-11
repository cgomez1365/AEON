/**
 * Master M3 — prove a staged block actually boots, before it can be approved.
 *
 * Every gate before this one reads: validateManifest checks a document,
 * scanSources checks text, the complexity gate scores an envelope. None of
 * them executes the block. The 24 store packs are recorded in the 2026-08-08
 * report as "checked for manifest shape but not for booting", and that
 * sentence is exactly the gap this closes.
 *
 * It reuses createBlockHost — the SAME mount path the kernel uses at runtime,
 * pointed at the staging directory. Writing a second mounting implementation
 * here would prove that a block boots under a mount path no user ever runs,
 * which is the duplicate-code-path defect Principle 04 exists to prevent (the
 * two model registries in BO-C, the two activity routers in BO-D2g).
 *
 * What it reports, and deliberately separates:
 *
 *   mounted      api modules that produced routes
 *   skipped      modules the host refused, with the host's own reason
 *   probes       each declared route actually called — status, not assumption
 *   collisions   staged routes that already exist in the live registry
 *
 * How a response is judged:
 *
 *   5xx / no answer   did not boot
 *   404               the manifest DECLARES that route and nothing answered it
 *                     — a declaration with no route behind it. The first
 *                     version of this gate counted every 4xx as success, which
 *                     passed a block whose api threw at require time: its
 *                     routes 404'd and that read as "booted and enforcing".
 *   401/403/400/422   booted, and enforcing something. That IS ability (§08).
 *
 * The block's code runs. That is the point, and it is why this is sequenced
 * after lint and the complexity gate rather than before them: those refuse
 * shell, eval, path traversal and secret reads, so what reaches here has
 * already been judged on what it may do.
 */
const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createBlockHost } = require('./blockHost.cjs');
const { validateManifest } = require('./staging.cjs');

const DEFAULT_TIMEOUT_MS = 5000;

/** Minimal deps. A staged block that needs more than this is over-reaching. */
function makeProofDeps(dataRoot) {
  const noop = () => {};
  return {
    // No cloud flag is declared here. A boot proof is always a local mount, and
    // blocks branch on a falsy `deps.isVercel` — undefined behaves identically
    // to false. Declaring it would add a cloud-conditional to the BO-A3a
    // ratchet (which may only fall), for a branch that can never be taken.
    getDataFile: () => dataRoot,
    getBlockDataFile: (id) => path.join(dataRoot, id),
    getBlockVaultFile: (id) => path.join(dataRoot, 'vault', id),
    vaultSync: noop,
    requestIndex: noop,
    writeOSAudit: noop,
    // No kernelLLM, no vault, no supabase: a boot proof must not spend tokens
    // or touch credentials. A block that cannot mount without them fails here,
    // which is the correct answer — it cannot mount on a fresh install either.
  };
}

/** Routes a manifest declares, normalised to paths we can call. */
function declaredRoutes(manifest) {
  const out = [];
  for (const r of manifest.routes || []) {
    if (!r || typeof r.path !== 'string') continue;
    // Wildcards cannot be called literally; record them for collision checks
    // but do not probe them.
    out.push({ method: (r.method || 'GET').toUpperCase(), path: r.path, wildcard: r.path.includes('*') });
  }
  const widget = manifest.widget?.endpoint;
  if (widget && !out.some((r) => r.path === widget)) {
    out.push({ method: 'GET', path: widget, wildcard: false, widget: true });
  }
  return out;
}

function request(port, method, urlPath, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: urlPath, timeout: timeoutMs },
      (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); }
    );
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: `no response in ${timeoutMs}ms` }); });
    req.end();
  });
}

/**
 * @param {string} stagingDir  directory CONTAINING the block folder
 * @param {string} blockId     folder name under stagingDir
 * @param {object} opts        { liveRoutes: string[], timeoutMs }
 */
async function bootProof(stagingDir, blockId, { liveRoutes = [], timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const result = {
    ok: false, blockId,
    mounted: 0, skipped: [], probes: [], collisions: [], errors: [],
  };

  const blockDir = path.join(stagingDir, blockId);
  const manifestPath = path.join(blockDir, 'block.manifest.json');
  if (!fs.existsSync(manifestPath)) {
    result.errors.push('no block.manifest.json');
    return result;
  }

  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (e) { result.errors.push(`manifest is not valid JSON: ${e.message}`); return result; }

  // A staged block is NEW, so the strict rules apply — no grandfathering.
  result.errors.push(...validateManifest(manifest));

  // Collisions are checked before mounting: a staged route that already exists
  // live is a refusal regardless of whether it boots. The collision gate was
  // blind to plugin-pattern routes until 2026-08-04; this is the
  // operator-facing half of that fix.
  const routes = declaredRoutes(manifest);
  const live = new Set(liveRoutes);
  for (const r of routes) {
    if (live.has(r.path)) result.collisions.push(`${r.path} already served by a live block`);
  }

  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-bootproof-'));
  let server;
  let host;
  try {
    const baseDeps = makeProofDeps(dataRoot);
    host = createBlockHost({
      blocksDir: stagingDir,
      baseDeps,
      // Scoping is exercised by the real loader; here the point is whether the
      // module mounts at all, so deps pass through unchanged.
      createScopedDeps: (base) => ({ ...base }),
      registry: [],
      readiness: {},
      getSyncCtx: () => ({ apiBase: '/api', runtime: 'local', models: {}, writeRuntime: false }),
      // The host logs refusals to console.error by design (R-05). Capture them
      // instead so a proof run is not noise, and so they land in `skipped`.
      log: { log: () => {}, error: () => {}, warn: () => {} },
    });

    const scan = host.rescan('boot-proof');
    result.skipped = (scan.skipped || []).filter((s) => s.block === blockId);
    // scan.mounted counts EVERY block in the staging directory. Attributing
    // another block's successful mount to this one is how the first version of
    // this gate passed a block whose api threw at require time.
    const apiDir = path.join(blockDir, 'api');
    const apiFiles = fs.existsSync(apiDir)
      ? fs.readdirSync(apiDir).filter((f) => (f.endsWith('.js') || f.endsWith('.cjs')) && !f.startsWith('_'))
      : [];
    result.mounted = Math.max(0, apiFiles.length - result.skipped.length);

    // A staging directory outside the repo tree cannot resolve node_modules,
    // so EVERY module fails with "Cannot find module 'express'". That is the
    // harness being wrong, not the block, and reporting it as a block defect
    // would be a false negative dressed as a verdict (§08). Say which.
    const unresolved = result.skipped.filter((s) => /Cannot find module '(express|[^']+)'/.test(s.why));
    if (unresolved.length && unresolved.length === result.skipped.length && result.mounted === 0) {
      result.environmentError =
        `staging directory ${stagingDir} cannot resolve node_modules — run the proof from a staging `
        + `dir inside the repo (src/kernel/staging.cjs STAGING_DIR). The block was not judged.`;
      result.errors.push(result.environmentError);
      return result;
    }

    const app = express();
    app.use(express.json());
    app.use(host.router);

    server = await new Promise((resolve, reject) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
      s.on('error', reject);
    });
    const { port } = server.address();

    for (const r of routes) {
      if (r.wildcard) {
        result.probes.push({ path: r.path, method: r.method, skipped: 'wildcard — not callable literally' });
        continue;
      }
      const res = await request(port, r.method, r.path, timeoutMs);
      // 5xx or no answer  = did not boot.
      // 404               = the route the manifest DECLARES is not there. The
      //                     first version of this gate treated every 4xx as
      //                     "booted and enforcing", which passed a block whose
      //                     api threw at require time — its routes 404'd and
      //                     that read as success. A declaration with no route
      //                     behind it is the §08 defect, not evidence of one.
      // 401/403/400/422   = booted and enforcing something. That IS ability.
      const ok = res.status > 0 && res.status < 500 && res.status !== 404;
      result.probes.push({
        path: r.path, method: r.method, status: res.status, ok,
        ...(r.widget ? { widget: true } : {}),
        ...(res.error ? { error: res.error } : {}),
      });
      if (!ok) {
        result.errors.push(
          res.status === 0 ? `${r.method} ${r.path} — ${res.error}`
            : res.status === 404 ? `${r.method} ${r.path} is declared in the manifest but no route answered it`
            : `${r.method} ${r.path} returned ${res.status}`
        );
      }
    }

    if (manifest.api_routes && result.mounted === 0) {
      result.errors.push('api_routes is declared but no API module mounted');
    }
  } catch (e) {
    result.errors.push(`boot proof threw: ${e.message}`);
  } finally {
    // Tear down in reverse. A proof that leaks a listener or a timer into the
    // parent process has changed the thing it was measuring.
    try { if (server) await new Promise((r) => server.close(r)); } catch {}
    try { if (host) host.dispose(); } catch {}
    try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch {}
  }

  result.ok = result.errors.length === 0 && result.collisions.length === 0;
  return result;
}

module.exports = { bootProof, declaredRoutes };
