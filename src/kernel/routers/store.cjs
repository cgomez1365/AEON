/**
 * /api/store — BGI Store (S1, Month 5).
 *
 *   GET  /api/store/catalog          all cartridges in dist-blocks (purchase summaries)
 *   GET  /api/store/source           what the configured store (AEON_STORE) offers + installed versions
 *   GET  /api/store/catalog/:id      one cartridge — THE PURCHASE SCREEN payload
 *                                    (Tier 2/3 perms + warnings shown here, pre-install)
 *   POST /api/store/install          { name | base64 | url } → standard pipeline
 *                                    (name: dist-blocks/, then the store, SHA-256 checked)
 *                                    (gate → staging → lint → LOW live-STOPPED / queue)
 *   POST /api/store/publish          regenerate site catalog.json + cartridges/ on the
 *                                    BGI site folder (deploy stays a portfolio-block act)
 */
const express = require('express');

module.exports = function createStoreRouter(deps) {
  const router = express.Router();
  const store = require('../store.cjs');
  const { pipeline } = deps;
  const operator = (req) => req.headers['x-aeon-operator'] || 'operator';

  router.get('/catalog', (_req, res) => res.json({ items: store.listCatalog() }));

  // What the configured store (AEON_STORE) offers, and which of it is installed.
  router.get('/source', async (_req, res) => {
    const storeSource = require('../storeSource.cjs');
    const src = storeSource.resolveSource();
    if (!src) return res.json({ configured: false, items: [], hint: 'Set AEON_STORE to the store catalog URL or a local store folder, then restart AEON.' });
    try {
      const { store: name, generatedAt, items } = await storeSource.loadCatalog(src);
      const fs = require('fs');
      const path = require('path');
      const { BLOCKS_DIR } = require('../blocksDir.cjs');
      const installedVersion = (id) => {
        try { return JSON.parse(fs.readFileSync(path.join(BLOCKS_DIR, id, 'block.manifest.json'), 'utf8')).version || '0.0.0'; }
        catch { return null; }
      };
      res.json({
        configured: true, source: src.kind === 'url' ? src.catalogUrl : src.dir, store: name, generatedAt,
        items: items.map((it) => ({
          id: it.id, version: it.version, label: it.label, description: it.description, tier: it.tier,
          warnings: it.warnings || [], size: it.size, sha256: it.sha256,
          installable: src.kind === 'dir' || !!it.download,
          installedVersion: installedVersion(it.id),
        })),
      });
    } catch (e) { res.status(502).json({ configured: true, error: e.message, items: [] }); }
  });

  router.get('/catalog/:id', (req, res) => {
    const fs = require('fs');
    const file = store.findCartridgeFile(req.params.id);
    if (!file) return res.status(404).json({ error: `cartridge not found: ${req.params.id}` });
    try {
      const { manifest } = store.readCartridgeBuffer(fs.readFileSync(file));
      res.json({ file: require('path').basename(file), ...store.purchaseSummary(manifest) });
    } catch (e) { res.status(422).json({ error: e.message }); }
  });

  router.post('/install', async (req, res) => {
    try {
      const result = await store.installCartridge(pipeline, req.body || {}, { operator: operator(req) });
      res.status(result.ok ? 200 : 422).json(result);
    } catch (e) { res.status(422).json({ ok: false, error: e.message }); }
  });

  router.post('/publish', (_req, res) => {
    try {
      const { publishStore } = require('../../../tools/publish-store.cjs');
      res.json(publishStore());
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  return router;
};
