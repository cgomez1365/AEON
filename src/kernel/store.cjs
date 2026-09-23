/**
 * S1 — BGI Store (Month 5, Track S). Deterministic, never an LLM call.
 *
 * A cartridge (.aeon, produced by `aeon pack`) is a zip whose single top-level
 * folder is the block id. Install path = the SAME pipeline as every other
 * build source (no special trust for store blocks):
 *
 *   readCartridge → envelope('store', untrusted) → gate → staging → lint
 *     → LOW auto-live (STOPPED) / MEDIUM+HIGH approval queue / Tier 3 IDE mode
 *
 * OWNER DECISION honored: Tier 2/3 permission requests surface on the
 * PURCHASE payload (purchaseSummary) — shell access shows on checkout,
 * never after install.
 */
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const { isOsJunk, isHidden } = require('./osJunk.cjs');

const ROOT = path.join(__dirname, '..', '..');
const DIST_DIR = path.join(ROOT, 'dist-blocks');

// ── Cartridge reader (zip-slip safe) ────────────────────────────────────────
function readCartridgeBuffer(buf) {
  const zip = new AdmZip(buf);
  // A zip made by Finder's "Compress" carries a "__MACOSX/" folder and "._"
  // sidecars; counted as content, __MACOSX read as a second top-level block
  // and every such cartridge was refused. OS droppings are not the block.
  const entries = zip.getEntries().filter(e => !e.isDirectory
    && !e.entryName.replace(/\\/g, '/').split('/').some(isOsJunk));
  if (!entries.length) throw new Error('cartridge is empty');

  const tops = new Set(entries.map(e => e.entryName.replace(/\\/g, '/').split('/')[0]));
  if (tops.size !== 1) throw new Error(`cartridge must contain exactly one top-level block folder, found: ${[...tops].join(', ')}`);
  const blockId = [...tops][0];
  if (!/^[a-z0-9_]+$/.test(blockId)) throw new Error(`invalid block id in cartridge: "${blockId}"`);

  const files = [];
  let manifest = null;
  for (const e of entries) {
    const rel = e.entryName.replace(/\\/g, '/').slice(blockId.length + 1);
    // zip-slip / escape guard — stageEnvelope re-checks, but fail here first
    if (!rel || rel.includes('..') || path.isAbsolute(rel)) throw new Error(`unsafe path in cartridge: ${e.entryName}`);
    // runtime + data never ship in a cartridge (pack excludes them; enforce on read too)
    if (rel === '.aeon.runtime.json' || rel.startsWith('data/')) continue;
    const content = e.getData().toString('utf8');
    if (rel === 'block.manifest.json') {
      try { manifest = JSON.parse(content); } catch (err) { throw new Error(`cartridge manifest is not valid JSON: ${err.message}`); }
    } else {
      files.push({ path: rel, content });
    }
  }
  if (!manifest) throw new Error('cartridge has no block.manifest.json');
  if (manifest.id !== blockId) throw new Error(`manifest id "${manifest.id}" != cartridge folder "${blockId}"`);
  return { blockId, manifest, files };
}

// ── PURCHASE screen payload — permission tiers surfaced BEFORE install ──────
function purchaseSummary(manifest) {
  const perms = manifest.contract?.permissions || {};
  const crossRead = perms.crossBlockRead || [];
  const crossWrite =
    (perms.filesystem === 'write' && manifest.contract?.storage?.scope && manifest.contract.storage.scope !== 'block') ||
    (manifest.contract?.outputs || []).some(o => typeof o === 'object' && o.block && o.block !== manifest.id);

  const tier = perms.shell === true ? 3 : crossWrite ? 2 : crossRead.length ? 1.5 : 1;
  const warnings = [];
  if (perms.shell === true) warnings.push('SHELL ACCESS — this block can run commands on your machine. Approving it requires IDE mode (Tier 3 full review).');
  if (crossWrite) warnings.push('CROSS-BLOCK WRITE — this block writes outside its own folder (Tier 2 approval).');
  if (crossRead.length) warnings.push(`Reads data from: ${crossRead.join(', ')} (declared, Tier 1.5).`);
  const secrets = (manifest.requires?.env || []).concat(manifest.contract?.requiredSecrets || []);
  if (secrets.length) warnings.push(`Needs your API keys: ${secrets.join(', ')} (added by you, never bundled).`);

  return {
    id: manifest.id,
    version: manifest.version || '0.0.0',
    label: manifest.label || manifest.id,
    description: manifest.description || '',
    tier,
    permissions: {
      filesystem: perms.filesystem || 'none',
      network: perms.network || 'none',
      shell: perms.shell === true,
      ai: perms.ai === true,
      crossBlockRead: crossRead,
      crossBlockWrite: !!crossWrite,
    },
    requiredSecrets: secrets,
    warnings, // shown on checkout — the purchase screen contract (OWNER DECISION)
  };
}

// ── Catalog — scan dist-blocks/*.aeon ───────────────────────────────────────
function listCatalog() {
  if (!fs.existsSync(DIST_DIR)) return [];
  const out = [];
  for (const f of fs.readdirSync(DIST_DIR).filter(f => f.endsWith('.aeon') && !isHidden(f))) {
    try {
      const { manifest } = readCartridgeBuffer(fs.readFileSync(path.join(DIST_DIR, f)));
      out.push({ file: f, ...purchaseSummary(manifest) });
    } catch (e) {
      out.push({ file: f, error: e.message });
    }
  }
  return out;
}

function findCartridgeFile(idOrFile) {
  if (!fs.existsSync(DIST_DIR)) return null;
  const names = fs.readdirSync(DIST_DIR).filter(f => f.endsWith('.aeon') && !isHidden(f));
  const exact = names.find(f => f === idOrFile);
  if (exact) return path.join(DIST_DIR, exact);
  // latest version for a bare id: lexicographic on the version suffix
  const byId = names.filter(f => f.startsWith(`${idOrFile}-`)).sort();
  return byId.length ? path.join(DIST_DIR, byId[byId.length - 1]) : null;
}

/**
 * Install a cartridge through the standard pipeline.
 * source: { name } (dist-blocks lookup) | { base64 } | { url } (store front).
 * Returns the pipeline result (live-but-STOPPED, queued, or a lint stop).
 */
async function installCartridge(pipeline, source, { operator = 'operator', env = process.env } = {}) {
  let buf;
  let sha = null;
  let from = source.name || source.url || 'upload';
  if (source.base64) {
    buf = Buffer.from(source.base64, 'base64');
  } else if (source.url) {
    if (!/^https:\/\//.test(source.url)) throw new Error('cartridge url must be https');
    const r = await fetch(source.url);
    if (!r.ok) throw new Error(`cartridge download failed: HTTP ${r.status}`);
    buf = Buffer.from(await r.arrayBuffer());
  } else if (source.name) {
    // This install's own dist-blocks/ first (what `aeon pack` wrote), then the
    // store AEON_STORE names — verified against its catalog's SHA-256.
    const file = findCartridgeFile(source.name);
    if (file) {
      buf = fs.readFileSync(file);
    } else {
      const storeSource = require('./storeSource.cjs');
      const src = storeSource.resolveSource(env);
      if (!src) throw new Error(`cartridge not found in dist-blocks: ${source.name} — and no store is configured (set AEON_STORE to the store's catalog URL or a local store folder)`);
      const { items } = await storeSource.loadCatalog(src);
      const item = storeSource.pickItem(items, source.name);
      if (!item) throw new Error(`"${source.name}" is not in the store's catalog (${items.length} pack${items.length === 1 ? '' : 's'} listed)`);
      ({ buf, sha } = await storeSource.fetchCartridge(src, item));
      from = `store:${item.file}`;
    }
  } else {
    throw new Error('install requires { name } or { base64 } or { url }');
  }

  if (!sha) sha = require('./storeSource.cjs').sha256(buf);
  const { blockId, manifest, files } = readCartridgeBuffer(buf);
  const summary = purchaseSummary(manifest);
  const result = await pipeline.submitBuild('store', {
    spec: `BGI Store install: ${summary.label} v${summary.version}`,
    manifest, files,
    meta: { cartridge: from, sha },
  }, { operator });
  return { ...result, blockId, sha, from, purchase: summary };
}

/**
 * Update an installed pack to the store's newest version.
 *
 * The pipeline refuses to install over a live block ("bump version and use
 * the update flow") and there was no update flow: an operator had to remove
 * the pack and install it again (store builder B4, 2026-09-23). This is it:
 *   1. resolve the newest catalog version; nothing to do if installed is current
 *   2. fetch it and prove it by the catalog's SHA-256 — before touching anything
 *   3. it must be a pack that goes live on its own (score LOW); one that needs
 *      approval is refused here with how to do it through the queue, rather
 *      than leaving the pack half-removed while it waits
 *   4. move the installed folder aside (<data>/removed-blocks/<id>@<time>),
 *      install the new one through the same airlock, restore the old folder if
 *      the new one does not go live, and start it again if it was running.
 * The pack's data lives in the data home, not its folder, so it carries over.
 */
async function updateFromStore(pipeline, id, {
  operator = 'operator', env = process.env, blocksDir, stagingDir, removedDir, rescan = () => {}, runState,
} = {}) {
  const storeSource = require('./storeSource.cjs');
  const aside = require('./blockAside.cjs');
  const BLOCKS = blocksDir || require('./blocksDir.cjs').BLOCKS_DIR;
  const STAGING = stagingDir || require('./staging.cjs').STAGING_DIR;
  const REMOVED = removedDir || aside.defaultRemovedDir();
  const rs = runState || require('./runState.cjs');
  if (!/^[a-z0-9][a-z0-9_]*$/.test(String(id || ''))) return { ok: false, status: 400, error: 'invalid block id' };

  const manifestFile = path.join(BLOCKS, id, 'block.manifest.json');
  if (!fs.existsSync(manifestFile)) return { ok: false, status: 404, error: `${id} is not installed — install it from the store instead` };
  let installed = '0.0.0';
  try { installed = JSON.parse(fs.readFileSync(manifestFile, 'utf8')).version || '0.0.0'; } catch { /* unreadable: treat as oldest */ }

  const src = storeSource.resolveSource(env);
  if (!src) return { ok: false, status: 409, error: 'no store is configured (set AEON_STORE)' };
  const { items } = await storeSource.loadCatalog(src);
  const item = storeSource.pickItem(items, id);
  if (!item) return { ok: false, status: 404, error: `"${id}" is not in the store's catalog` };
  if (storeSource.compareVersions(item.version, installed) <= 0) {
    return { ok: true, upToDate: true, id, installed, latest: item.version, message: `${id} ${installed} is the newest version in the store.` };
  }

  const { buf, sha } = await storeSource.fetchCartridge(src, item);
  const { manifest, files } = readCartridgeBuffer(buf);
  if (manifest.id !== id || String(manifest.version) !== String(item.version)) {
    return { ok: false, status: 422, error: `${item.file} carries ${manifest.id} ${manifest.version}, not ${id} ${item.version} as the catalog says — not installed` };
  }

  const check = await pipeline.validateBuild('store', { manifest, files });
  // submitBuild goes live on the GATE's verdict (verdict.score); lint findings
  // (check.score) must be clean too or the staged lint stops it.
  const score = check.verdict?.score !== 'LOW' ? (check.verdict?.score || 'unknown') : check.score;
  if (!check.ok || check.errors?.length || score !== 'LOW') {
    return {
      ok: false, status: 409, id, installed, latest: item.version, score,
      error: `${id} ${item.version} needs your review before it runs (score ${score}), so it is not swapped in automatically. `
        + `Remove ${id} (its data stays), then install it — it will wait in the approval queue.`,
    };
  }

  const wasRunning = !!rs.isRunning?.(id);
  const keptAt = path.join(REMOVED, aside.asideName(id));
  aside.moveDir(path.join(BLOCKS, id), keptAt);
  let result;
  try {
    result = await pipeline.submitBuild('store', {
      spec: `BGI Store update: ${id} ${installed} → ${item.version}`,
      manifest, files, meta: { cartridge: `store:${item.file}`, sha, update: { from: installed } },
    }, { operator });
  } catch (e) {
    result = { ok: false, stage: 'submit', error: e.message };
  }

  if (!result.ok || result.stage !== 'live') {
    // Put the working version back; keep the failed attempt, never delete it.
    const failed = path.join(STAGING, id);
    if (fs.existsSync(failed)) aside.moveDir(failed, path.join(REMOVED, aside.asideName(id, '-failed-update')));
    if (fs.existsSync(path.join(BLOCKS, id))) aside.moveDir(path.join(BLOCKS, id), path.join(REMOVED, aside.asideName(id, '-failed-update')));
    aside.moveDir(keptAt, path.join(BLOCKS, id));
    try { rescan(`update-rollback:${id}`); } catch { /* reported below */ }
    if (wasRunning) { try { rs.setRunning(id, true, { operator, allowAuto: true }); } catch {} }
    return {
      ok: false, status: 422, id, installed, latest: item.version, rolledBack: true, stage: result.stage,
      error: `${id} ${item.version} did not install (${result.error || result.stage}); ${installed} is back in place${wasRunning ? ' and running' : ''}.`,
      result,
    };
  }

  if (wasRunning) { try { rs.setRunning(id, true, { operator, allowAuto: true }); } catch {} }
  return {
    ok: true, updated: true, id, from: installed, to: item.version, sha, keptAt,
    running: !!rs.isRunning?.(id),
    message: `${id} updated ${installed} → ${item.version} (verified against the store). The previous version is kept at ${keptAt}.`
      + (wasRunning ? ' It is running again.' : ' It is stopped; start it when ready.'),
  };
}

module.exports = { readCartridgeBuffer, purchaseSummary, listCatalog, findCartridgeFile, installCartridge, updateFromStore, DIST_DIR };
