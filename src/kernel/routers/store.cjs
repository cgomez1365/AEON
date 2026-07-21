/**
 * /api/store — BGI Store (S1, Month 5).
 *
 *   GET  /api/store/catalog          all cartridges in dist-blocks (purchase summaries)
 *   GET  /api/store/catalog/:id      one cartridge — THE PURCHASE SCREEN payload
 *                                    (Tier 2/3 perms + warnings shown here, pre-install)
 *   POST /api/store/install          { name | base64 | url } → standard pipeline
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
