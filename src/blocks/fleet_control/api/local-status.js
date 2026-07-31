// Route: /api/local-status — Phase 7 replacement for the former daemon-status probe.
// Reports the native local runtime state from the Phase 2 registry. No daemon, no TCP.
const _handler = async (req, res) => {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const storage = require('../../../../services/storage.js');
    const reg = storage.getLocalRuntimeRegistry();
    const active = reg.activeRuntime();
    const models = reg.readyModels();
    return res.status(200).json({
      online: !!(active && models.length > 0),
      runtimeId: active ? active.id : null,
      runtimeBackend: active ? active.backend : null,
      activeModel: models.length ? models[0].id : null,
      availableModels: models.map(m => m.id),
    });
  } catch (e) {
    return res.status(200).json({ online: false, runtimeId: null, activeModel: null, availableModels: [], error: e.message });
  }
};

// Declared as (router, deps) — the plugin shape. An arity-1 export receives
// blockDeps rather than a router, so `app.get` hit the sandbox proxy, was
// denied, and this route silently never mounted. The second parameter is what
// tells the block host which shape this is.
module.exports = (router, _deps) => {
  router.get('/api/local-status', _handler);
  return _handler;
};
