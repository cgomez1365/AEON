/**
 * Block Customization Routes
 * GET  /api/blocks/icons              — library of available icons
 * GET  /api/blocks/customizations     — all user overrides (label/iconAsset per block)
 * PATCH /api/blocks/:blockId/customize — set label and/or iconAsset
 * DELETE /api/blocks/:blockId/customize — reset a block to its defaults
 */
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const blockCustomizations = require('../../services/block-customizations.js');

const ICONS_DIR = path.join(__dirname, '..', '..', 'public', 'brand', 'block-icons');

// Cache the icon scan for the lifetime of the process (icons only change on deploy).
let _iconCache = null;
function getIconLibrary() {
  if (_iconCache) return _iconCache;
  try {
    _iconCache = fs.readdirSync(ICONS_DIR)
      .filter(f => f.endsWith('.svg') && !f.startsWith('_'))
      .map(f => {
        const id = f.replace('.svg', '');
        const label = id.split(/[_-]+/).filter(Boolean)
          .map(w => w[0].toUpperCase() + w.slice(1))
          .join(' ');
        return { id, label, path: `/brand/block-icons/${f}` };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  } catch { _iconCache = []; }
  return _iconCache;
}

module.exports = function customizeRouter(deps) {
  const router = express.Router();

  // No auth — these are public brand assets.
  router.get('/api/blocks/icons', (_req, res) => {
    res.json({ icons: getIconLibrary() });
  });

  // Returns the full map so the frontend can apply all overrides in one fetch.
  router.get('/api/blocks/customizations', (_req, res) => {
    res.json({ customizations: blockCustomizations.getAll() });
  });

  // PATCH /api/blocks/:blockId/customize
  // Body: { label?: string, iconAsset?: string }
  router.patch('/api/blocks/:blockId/customize', (req, res) => {
    const { blockId } = req.params;
    const { label, iconAsset } = req.body || {};

    if (!label && !iconAsset) {
      return res.status(400).json({ error: 'provide label and/or iconAsset' });
    }
    if (label !== undefined && (typeof label !== 'string' || !label.trim())) {
      return res.status(422).json({ error: 'label must be a non-empty string' });
    }

    const validIcons = getIconLibrary().map(i => i.path);
    if (iconAsset !== undefined && !validIcons.includes(iconAsset)) {
      return res.status(422).json({ error: 'iconAsset not in icon library' });
    }

    const patch = {};
    if (label) patch.label = label.trim();
    if (iconAsset) patch.iconAsset = iconAsset;

    blockCustomizations.set(blockId, patch);

    // Rewrite the physical manifest so the terminal sees the updated name/icon.
    try {
      const { normalizeManifest, BLOCKS_DIR } = require('../../src/kernel/blockStandard.cjs');
      const blockPath = require('path').join(BLOCKS_DIR, blockId);
      if (require('fs').existsSync(blockPath)) {
        const updated = normalizeManifest(blockId);
        require('fs').writeFileSync(
          require('path').join(BLOCKS_DIR, blockId, 'block.manifest.json'),
          JSON.stringify(updated, null, 2)
        );
      }
    } catch (e) {
      console.warn('[CUSTOMIZE] manifest rewrite failed:', e.message);
    }

    res.json({ ok: true, blockId, applied: patch });
  });

  // DELETE /api/blocks/:blockId/customize — reset to defaults
  router.delete('/api/blocks/:blockId/customize', (req, res) => {
    const { blockId } = req.params;
    blockCustomizations.reset(blockId);

    try {
      const { normalizeManifest, BLOCKS_DIR } = require('../../src/kernel/blockStandard.cjs');
      const blockPath = require('path').join(BLOCKS_DIR, blockId);
      if (require('fs').existsSync(blockPath)) {
        const restored = normalizeManifest(blockId);
        require('fs').writeFileSync(
          require('path').join(BLOCKS_DIR, blockId, 'block.manifest.json'),
          JSON.stringify(restored, null, 2)
        );
      }
    } catch (e) {
      console.warn('[CUSTOMIZE] manifest restore failed:', e.message);
    }

    res.json({ ok: true, blockId, reset: true });
  });

  return router;
};
