/**
 * Block Customization Routes — ICON ONLY.
 *
 * The display NAME is never editable: it always derives from the block's
 * folder name (folder-is-truth, CEO rule 2026-07-16). Only the icon can be
 * changed, and only for blocks that declare themselves customizable.
 *
 * The store is the block's own manifest (nav.iconAsset). block.manifest.json
 * is git-tracked, so a committed icon change survives a fresh clone — a
 * separate data/ store would not. blockStandard.normalizeManifest() preserves
 * nav.iconAsset through boot sync, which is what makes this durable.
 *
 *   GET    /api/blocks/icons              — the icon library (folder scan)
 *   GET    /api/blocks/nav                — live icon + editability per block
 *   PATCH  /api/blocks/:blockId/customize — set iconAsset
 *   DELETE /api/blocks/:blockId/customize — revert to the folder default
 */
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const {
  BLOCKS_DIR, ICON_BASE, ICON_DIR,
  listBlockFolders, readManifest, normalizeManifest,
} = require('../../src/kernel/blockStandard.cjs');

// Cache the icon scan for the lifetime of the process (icons change on deploy).
let _iconCache = null;
function getIconLibrary() {
  if (_iconCache) return _iconCache;
  try {
    _iconCache = fs.readdirSync(ICON_DIR)
      .filter(f => f.endsWith('.svg') && !f.startsWith('_'))
      .map(f => {
        const id = f.replace('.svg', '');
        const label = id.split(/[_-]+/).filter(Boolean)
          .map(w => w[0].toUpperCase() + w.slice(1))
          .join(' ');
        return { id, label, path: `${ICON_BASE}/${f}` };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  } catch { _iconCache = []; }
  return _iconCache;
}

/** Persist a manifest patch, then re-normalize so the file stays canonical. */
function writeManifestPatch(folder, mutate) {
  const file = path.join(BLOCKS_DIR, folder, 'block.manifest.json');
  const m = readManifest(folder) || {};
  m.nav = m.nav || {};
  mutate(m);
  fs.writeFileSync(file, JSON.stringify(m, null, 2));
  // normalizeManifest now reads the patched nav.iconAsset and preserves it.
  const normalized = normalizeManifest(folder);
  fs.writeFileSync(file, JSON.stringify(normalized, null, 2));
  return normalized;
}

module.exports = function customizeRouter(deps) {
  const router = express.Router();

  // Resolve :blockId against the real registry. An unknown id must 404 — the
  // absence of this check is what let a literal "undefined" become a stored
  // key and bleed one block's icon onto every row.
  function resolveBlock(req, res) {
    const { blockId } = req.params;
    if (!blockId || !listBlockFolders().includes(blockId)) {
      res.status(404).json({ error: `unknown block: ${blockId}` });
      return null;
    }
    const m = readManifest(blockId) || {};
    if (m.contract?.customizable?.icon === false) {
      res.status(403).json({ error: `${blockId} declares its icon not customizable` });
      return null;
    }
    return blockId;
  }

  // No auth — these are public brand assets.
  router.get('/api/blocks/icons', (_req, res) => {
    res.json({ icons: getIconLibrary() });
  });

  // Live per-block icon state, read from disk. The frontend registry reads
  // manifests through Vite's build-time glob, so a prod build would not see a
  // manifest write until rebuild — this endpoint keeps the running UI honest
  // without introducing a second store.
  router.get('/api/blocks/nav', (_req, res) => {
    const blocks = {};
    for (const folder of listBlockFolders()) {
      const m = readManifest(folder);
      if (!m) continue;
      blocks[folder] = {
        iconAsset:    m.nav?.iconAsset || `${ICON_BASE}/${folder}.svg`,
        iconEditable: m.contract?.customizable?.icon !== false,
      };
    }
    res.json({ blocks });
  });

  // PATCH /api/blocks/:blockId/customize   Body: { iconAsset }
  router.patch('/api/blocks/:blockId/customize', (req, res) => {
    const blockId = resolveBlock(req, res);
    if (!blockId) return;

    const { iconAsset, label } = req.body || {};

    // The name is folder-derived and not negotiable. Fail loudly rather than
    // accepting a field we would silently drop.
    if (label !== undefined) {
      return res.status(422).json({
        error: 'label is not editable — the display name derives from the block folder',
      });
    }
    if (typeof iconAsset !== 'string' || !iconAsset.trim()) {
      return res.status(422).json({ error: 'iconAsset is required' });
    }
    if (!getIconLibrary().some(i => i.path === iconAsset)) {
      return res.status(422).json({ error: 'iconAsset not in icon library' });
    }

    try {
      const updated = writeManifestPatch(blockId, m => { m.nav.iconAsset = iconAsset; });
      res.json({ ok: true, blockId, iconAsset: updated.nav.iconAsset });
    } catch (e) {
      console.warn('[CUSTOMIZE] manifest write failed:', e.message);
      res.status(500).json({ error: 'manifest write failed' });
    }
  });

  // DELETE /api/blocks/:blockId/customize — back to the folder default
  router.delete('/api/blocks/:blockId/customize', (req, res) => {
    const blockId = resolveBlock(req, res);
    if (!blockId) return;

    try {
      const restored = writeManifestPatch(blockId, m => { delete m.nav.iconAsset; });
      res.json({ ok: true, blockId, iconAsset: restored.nav.iconAsset, reset: true });
    } catch (e) {
      console.warn('[CUSTOMIZE] manifest restore failed:', e.message);
      res.status(500).json({ error: 'manifest restore failed' });
    }
  });

  return router;
};
