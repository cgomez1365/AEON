# api/ — optional server routes

Drop `*.cjs` or `*.js` files here and set `"api_routes": true` in the manifest.
Two supported shapes (the loader detects which):

```js
// Factory (preferred): fn(deps) => express.Router — dual-mounted at /block/<id> and /api
// Every path starts with /<id>/, so this answers GET /api/<id>/health.
module.exports = (deps) => {
  const router = require('express').Router();
  router.get('/<id>/health', (_req, res) => res.json({ ok: true }));
  return router;
};

// Plugin: fn(app, deps) — mounts directly at /api/*
module.exports = (app, deps) => { app.get('/api/<id>/thing', ...); };
```

`deps` is permission-scoped by the manifest (`contract.permissions`) — declare what
you use or you'll get `[SANDBOX]` warnings. Files starting with `_` are not mounted
(use for shared helpers).

Persist through `deps.blockStorage` (`readJSON` / `writeJSON`), which writes
under the AEON home, never inside the block folder. Scheduled work goes through
`deps.lifecycle.setInterval`. The full list of deps — and what AEON does not
provide yet — is in `src/blocks/master/README.md`.
