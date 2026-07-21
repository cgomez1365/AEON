# api/ — optional server routes

Drop `*.cjs` or `*.js` files here and set `"api_routes": true` in the manifest.
Two supported shapes (the loader detects which):

```js
// Factory (preferred): fn(deps) => express.Router — dual-mounted at /block/<id> and /api
module.exports = (deps) => {
  const router = require('express').Router();
  router.get('/crn/<id>/health', (_req, res) => res.json({ ok: true }));
  return router;
};

// Plugin: fn(app, deps) — mounts directly at /api/*
module.exports = (app, deps) => { app.get('/api/<id>/thing', ...); };
```

`deps` is permission-scoped by the manifest (`contract.permissions`) — declare what
you use or you'll get `[SANDBOX]` warnings. Files starting with `_` are not mounted
(use for shared helpers).

`data/` next door is auto-created on first boot — never pre-populate it, never
write outside your own block folder (that's a Tier 2+ action).
