/**
 * AEON Model Scanner — detect which provider an API key belongs to, list its
 * live models, and refresh every saved connection in one sweep.
 *
 *   POST /api/connections/detect     { apiKey, base_url? } → { provider, models }
 *   GET  /api/connections/scan-all   live-scan every registry endpoint, refresh
 *                                    stored model lists (?save=0 for dry run)
 */
const path = require('path');

let vault, endpoints;
try {
  vault = require(path.join(__dirname, '..', '..', '..', 'kernel', 'vault.cjs'));
  endpoints = require(path.join(__dirname, '..', '..', '..', 'kernel', 'endpoints.cjs'));
} catch (e) {
  console.error('[MODEL SCAN] kernel modules failed to load:', e.message);
}

// Key-prefix heuristics decide probe ORDER only — every match is verified by a
// real list-models call before we claim a provider.
const PREFIX_HINTS = [
  { re: /^sk-ant-/, providers: ['claude'] },
  { re: /^gsk_/, providers: ['groq'] },
  { re: /^AIza/, providers: ['gemini'] },
  { re: /^xai-/, providers: ['grok'] },
  { re: /^sk-/, providers: ['openai', 'groq', 'grok'] },
];
const ALL_PROVIDERS = ['claude', 'groq', 'gemini', 'grok', 'openai'];

module.exports = (app, deps) => {
  if (!vault || !endpoints) return;
  const supabase = deps && deps.supabase ? deps.supabase : null;

  // ── POST /api/connections/detect — paste a key, learn what it is ────
  app.post('/api/connections/detect', async (req, res) => {
    const { apiKey, base_url } = req.body || {};
    if (!apiKey && !base_url) return res.status(400).json({ error: 'apiKey or base_url required' });

    // Local endpoint probe (no key): lmstudio / openai-compatible
    if (!apiKey && base_url) {
      for (const p of ['lmstudio', 'openai']) {
        const models = await endpoints.discoverModels(p, base_url, null);
        if (Array.isArray(models) && models.length) return res.json({ ok: true, provider: p, base_url, models });
      }
      return res.json({ ok: false, error: 'No model server answered at that address.' });
    }

    const hint = PREFIX_HINTS.find(h => h.re.test(apiKey));
    const order = [...new Set([...(hint ? hint.providers : []), ...ALL_PROVIDERS])];
    const tried = [];
    for (const provider of order) {
      const models = await endpoints.discoverModels(provider, base_url, apiKey);
      if (Array.isArray(models) && models.length) {
        return res.json({ ok: true, provider, models, tried });
      }
      tried.push(provider);
    }
    res.json({ ok: false, error: 'Key was not accepted by any known provider.', tried });
  });

  // ── GET /api/connections/scan-all — refresh every saved connection ──
  app.get('/api/connections/scan-all', async (req, res) => {
    try {
      const save = req.query.save !== '0';
      const reg = await endpoints.load(supabase);
      const results = [];
      for (const ep of (reg.endpoints || [])) {
        let key = null;
        if (ep.auth_ref && vault.isUnlocked()) {
          try { key = await vault.getSecret(ep.auth_ref, supabase); } catch {}
        }
        const models = await endpoints.discoverModels(ep.provider, ep.base_url, key);
        if (Array.isArray(models)) {
          results.push({ id: ep.id, provider: ep.provider, ok: true, count: models.length, models });
          if (save && models.length) {
            await endpoints.addEndpoint({ ...ep, models }, supabase); // upsert refreshes list
          }
        } else {
          results.push({ id: ep.id, provider: ep.provider, ok: false, error: (models && models.error) || 'unreachable' });
        }
      }
      res.json({ ok: true, scanned: results.length, saved: save, results });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
