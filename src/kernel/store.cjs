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

const ROOT = path.join(__dirname, '..', '..');
const DIST_DIR = path.join(ROOT, 'dist-blocks');

// ── Cartridge reader (zip-slip safe) ────────────────────────────────────────
function readCartridgeBuffer(buf) {
  const zip = new AdmZip(buf);
  const entries = zip.getEntries().filter(e => !e.isDirectory);
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
  for (const f of fs.readdirSync(DIST_DIR).filter(f => f.endsWith('.aeon'))) {
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
  const names = fs.readdirSync(DIST_DIR).filter(f => f.endsWith('.aeon'));
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
async function installCartridge(pipeline, source, { operator = 'operator' } = {}) {
  let buf;
  if (source.base64) {
    buf = Buffer.from(source.base64, 'base64');
  } else if (source.url) {
    if (!/^https:\/\//.test(source.url)) throw new Error('cartridge url must be https');
    const r = await fetch(source.url);
    if (!r.ok) throw new Error(`cartridge download failed: HTTP ${r.status}`);
    buf = Buffer.from(await r.arrayBuffer());
  } else if (source.name) {
    const file = findCartridgeFile(source.name);
    if (!file) throw new Error(`cartridge not found in dist-blocks: ${source.name}`);
    buf = fs.readFileSync(file);
  } else {
    throw new Error('install requires { name } or { base64 } or { url }');
  }

  const { blockId, manifest, files } = readCartridgeBuffer(buf);
  const summary = purchaseSummary(manifest);
  const result = await pipeline.submitBuild('store', {
    spec: `BGI Store install: ${summary.label} v${summary.version}`,
    manifest, files,
    meta: { cartridge: source.name || source.url || 'upload', sha: null },
  }, { operator });
  return { ...result, blockId, purchase: summary };
}

module.exports = { readCartridgeBuffer, purchaseSummary, listCatalog, findCartridgeFile, installCartridge, DIST_DIR };
