/**
 * Where AEON installs packs "from the store", and proof that what arrives is
 * what the store listed.
 *
 * `AEON_STORE` (in the environment or AEON's .env) names the store:
 *   https://…/store/catalog.json   the deployed store site's catalog
 *   /path/to/aeon-store            a local checkout of the store repository
 *                                  (site/store/catalog.json + cartridges/)
 *
 * The catalog is derived from the cartridges by the store's build-catalog.py
 * and carries each cartridge's SHA-256. A cartridge whose bytes do not hash to
 * the catalog's value is refused before it reaches the airlock. Before this,
 * `install { name }` only looked in the install's own dist-blocks/ and nothing
 * checked a cartridge's hash (`meta.sha: null`, 2026-09-23).
 *
 * A paid pack is never downloadable from the store site (the site only hosts
 * `free` packs); its catalog entry has no `download`, and installing it by id
 * says where to buy it instead of failing on a 404.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function resolveSource(env = process.env) {
  const raw = String(env.AEON_STORE || '').trim();
  if (!raw) return null;
  if (/^https:\/\//i.test(raw)) return { kind: 'url', catalogUrl: raw };
  if (/^http:\/\//i.test(raw)) return { kind: 'invalid', error: 'AEON_STORE must be an https URL or a folder' };
  // .env values are not shell-expanded, so "~" would be a folder literally
  // named "~". Ask for the full path rather than guessing a home directory.
  if (raw.startsWith('~')) return { kind: 'invalid', error: `AEON_STORE must be a full path (for example /Users/you/aeon-store), not ${raw}` };
  if (!path.isAbsolute(raw)) return { kind: 'invalid', error: `AEON_STORE must be a full path or an https URL, not ${raw}` };
  return { kind: 'dir', dir: path.resolve(raw) };
}

function dirCatalogFile(dir) {
  for (const f of [path.join(dir, 'site', 'store', 'catalog.json'), path.join(dir, 'catalog.json')]) {
    if (fs.existsSync(f)) return f;
  }
  return null;
}

async function loadCatalog(source) {
  if (!source) throw new Error('No store is configured. Set AEON_STORE to the store catalog URL or a local store folder.');
  if (source.kind === 'invalid') throw new Error(source.error);
  let catalog;
  if (source.kind === 'url') {
    const r = await fetch(source.catalogUrl);
    if (!r.ok) throw new Error(`store catalog unavailable: HTTP ${r.status} from ${source.catalogUrl}`);
    catalog = await r.json();
  } else {
    const file = dirCatalogFile(source.dir);
    if (!file) throw new Error(`no catalog.json in ${source.dir} (looked in site/store/ and the folder itself)`);
    catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const items = Array.isArray(catalog?.items) ? catalog.items : [];
  return { store: catalog?.store || null, generatedAt: catalog?.generatedAt || null, items };
}

/** The newest catalog entry for an id (versions compared numerically). */
function pickItem(items, id) {
  const cmp = (a, b) => {
    const pa = String(a.version || '0').split('.').map(Number);
    const pb = String(b.version || '0').split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d;
    }
    return 0;
  };
  return items.filter((it) => it && it.id === id).sort(cmp).pop() || null;
}

/** Read or download one cartridge and prove it is the one the catalog lists. */
async function fetchCartridge(source, item) {
  // The catalog may be remote: its names are data, never paths.
  if (!/^[a-z0-9][a-z0-9_]*$/.test(String(item?.id || '')) || !/^[a-z0-9][a-z0-9_]*-[0-9A-Za-z.+-]+\.aeon$/.test(String(item?.file || ''))) {
    throw new Error(`catalog entry refused: id ${JSON.stringify(item?.id)} / file ${JSON.stringify(item?.file)} is not a cartridge name`);
  }
  let buf;
  if (source.kind === 'dir') {
    const candidates = [path.join(source.dir, 'cartridges', item.file), path.join(source.dir, 'site', 'store', 'cartridges', item.file)];
    const file = candidates.find((f) => fs.existsSync(f));
    if (!file) throw new Error(`${item.id}: ${item.file} is listed in the catalog but not present in ${source.dir}/cartridges`);
    buf = fs.readFileSync(file);
  } else {
    if (!item.download) {
      const page = new URL('./', source.catalogUrl).href;
      const err = new Error(`${item.label || item.id} is sold, not downloadable from the store. Buy it at ${page}, then install the cartridge you receive: aeon install <file.aeon>`);
      err.notDownloadable = true;
      throw err;
    }
    const url = new URL(item.download, source.catalogUrl).href;
    if (!/^https:\/\//.test(url)) throw new Error(`${item.id}: cartridge URL must be https (${url})`);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${item.id}: cartridge download failed: HTTP ${r.status}`);
    buf = Buffer.from(await r.arrayBuffer());
  }
  const got = sha256(buf);
  if (!item.sha256 || got !== String(item.sha256).toLowerCase()) {
    const err = new Error(`${item.id}: the cartridge does not match the store's catalog (expected ${item.sha256 || 'a sha256'}, got ${got}) — not installed.`);
    err.integrity = true;
    throw err;
  }
  return { buf, sha: got };
}

module.exports = { resolveSource, loadCatalog, pickItem, fetchCartridge, sha256 };
