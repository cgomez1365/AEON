const express = require('express');
const { buildWidgetCatalogue } = require('../widgets.cjs');

module.exports = function createBlocksRouter(deps) {
  const router = express.Router();
  const { _blockRegistry, _blockReadiness, fs, path, VAULT_ROOT } = deps;

  router.get('/registry', (req, res) => {
    res.json(
      _blockRegistry.map(b => ({ ...b, readiness: _blockReadiness[b.id] || null }))
    );
  });

  // Widget catalogue — the consumer side of the widget contract.
  // Settings renders one card per entry. A block declaring no widget is
  // absent from `widgets` entirely; a block declaring a malformed or
  // out-of-namespace one appears in `refused` with the reason, because a
  // silently dropped declaration is exactly the class of dishonesty
  // BO-F3 existed to remove.
  router.get('/widgets', (_req, res) => {
    const withReadiness = _blockRegistry.map(b => ({ ...b, readiness: _blockReadiness[b.id] || null }));
    res.json(buildWidgetCatalogue(withReadiness));
  });

  // Live per-block state — whatever each block last wrote via vaultSync()
  // (Vault/blocks/{id}/state.json). Powers the Dashboard's block grid so
  // it reflects only what's actually installed, with no hardcoded list.
  router.get('/state', (_req, res) => {
    const out = {};
    try {
      const blocksDir = path.join(VAULT_ROOT, 'blocks');
      const ids = fs.existsSync(blocksDir) ? fs.readdirSync(blocksDir, { withFileTypes: true }) : [];
      for (const ent of ids) {
        if (!ent.isDirectory()) continue;
        const statePath = path.join(blocksDir, ent.name, 'state.json');
        try { out[ent.name] = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
      }
    } catch {}
    res.json(out);
  });

  return router;
};
