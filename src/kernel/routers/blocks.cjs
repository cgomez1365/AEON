const express = require('express');

module.exports = function createBlocksRouter(deps) {
  const router = express.Router();
  const { _blockRegistry, _blockReadiness } = deps;

  router.get('/registry', (req, res) => {
    res.json(
      _blockRegistry.map(b => ({ ...b, readiness: _blockReadiness[b.id] || null }))
    );
  });

  return router;
};
