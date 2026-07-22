const express = require('express');

module.exports = function createBlocksRouter(deps) {
  const router = express.Router();
  const { _blockRegistry, _blockReadiness, fs, path, VAULT_ROOT } = deps;

  router.get('/registry', (req, res) => {
    res.json(
      _blockRegistry.map(b => ({ ...b, readiness: _blockReadiness[b.id] || null }))
    );
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
