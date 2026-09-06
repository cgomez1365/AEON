/**
 * AEON Connections API — manage model endpoints + the encrypted vault.
 *
 * Sits in the settings block. Drives the "Add connection" UI for both cloud
 * (API key → vault) and local (base_url discovery) models, and persists the
 * registry so connections survive reboot and mirror to Supabase for roaming.
 */
const path = require('path');

let vault, endpoints;
try {
  vault = require(path.join(__dirname, '..', '..', '..', 'kernel', 'vault.cjs'));
  endpoints = require(path.join(__dirname, '..', '..', '..', 'kernel', 'endpoints.cjs'));
} catch (e) {
  console.error('[CONNECTIONS] kernel modules failed to load:', e.message);
}

module.exports = (app, deps) => {
  if (!vault || !endpoints) return;
  const supabase = deps && deps.supabase ? deps.supabase : null;
  const audit = (deps && deps.writeOSAudit) || (() => {});

  // ── GET /api/connections — registry + vault status (no secrets) ────
  app.get('/api/connections', async (req, res) => {
    try {
      const reg = await endpoints.load(supabase);
      const refs = vault.isUnlocked() ? await vault.listRefs(supabase) : [];
      res.json({
        endpoints: reg.endpoints,
        roles: reg.roles,
        vault: { unlocked: vault.isUnlocked(), refs },
        runtime: endpoints.isVercel ? 'cloud' : 'local',
        cloudMirror: !!supabase,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /api/connections/discover — probe a base_url for models ───
  //
  // SECURITY. This route decrypts a vault secret and sends it to a URL. Those
  // two inputs must never both come from the caller: a request naming a stored
  // auth_ref alongside an attacker-chosen base_url would have AEON decrypt the
  // operator's saved key and hand it to that host as a Bearer token — or, on
  // the gemini transport, in a query string that lands in its access log.
  //
  // The rule: a key the CALLER supplies may go to a URL the caller supplies
  // (they already hold it, nothing is disclosed). A key from the VAULT may only
  // go to the address already recorded for that endpoint in the registry.
  app.post('/api/connections/discover', async (req, res) => {
    const { provider, base_url, apiKey, auth_ref } = req.body || {};
    if (!provider) return res.status(400).json({ error: 'provider required' });

    let key = apiKey || null;
    let target = base_url;

    if (!key && auth_ref && vault.isUnlocked()) {
      const reg = await endpoints.load(supabase);
      const owner = (reg.endpoints || []).find(e => e.auth_ref === auth_ref);
      if (!owner) {
        return res.status(403).json({ ok: false, error: 'That saved key does not belong to any connection.' });
      }
      // The registry's address wins — never the request's.
      target = owner.base_url || null;
      key = await vault.getSecret(auth_ref, supabase);
    }

    const models = await endpoints.discoverModels(provider, target, key);
    if (models && models.error) return res.json({ ok: false, error: models.error, manual: !!models.manual });
    res.json({ ok: true, models });
  });

  // ── POST /api/connections — add/update an endpoint (+ optional key) ─
  app.post('/api/connections', async (req, res) => {
    try {
      const { id, label, provider, base_url, models, reachable_from, apiKey,
              preferred_model, rpm_limit } = req.body || {};
      if (!provider) return res.status(400).json({ error: 'provider required' });

      // Validate the address BEFORE writing anything. This used to run after
      // the vault write, so a rejected save still left an orphaned secret
      // behind under a ref no endpoint referenced.
      if (base_url) {
        const check = endpoints.checkBaseUrl(base_url);
        if (!check.ok) return res.status(400).json({ error: check.error });
      }

      let auth_ref = req.body.auth_ref || null;
      // If a raw key was supplied, stash it in the vault under a ref and only
      // persist the ref in the registry — never the key itself.
      if (apiKey) {
        if (!vault.isUnlocked())
          return res.status(400).json({ error: 'Vault locked — set AEON_VAULT_MASTER_KEY to store keys' });
        auth_ref = auth_ref || `${provider}-${(id || Date.now().toString(36))}`;
        await vault.setSecret(auth_ref, apiKey, supabase);
      }

      // No models supplied → discover them now so the connection is usable
      // immediately (Save no longer requires a manual Discover click first).
      // Discovery failing is NOT fatal: plenty of OpenAI-compatible servers do
      // not publish /models, and the operator can name the model themselves.
      let modelList = models;
      if ((!modelList || !modelList.length) && (apiKey || base_url)) {
        const found = await endpoints.discoverModels(provider, base_url, apiKey || null);
        if (Array.isArray(found)) modelList = found;
      }
      // Keep a hand-typed model usable even when discovery returned nothing.
      if (preferred_model && !(modelList || []).includes(preferred_model)) {
        modelList = [preferred_model, ...(modelList || [])];
      }

      const ep = await endpoints.addEndpoint({
        id, label, provider, base_url, models: modelList, reachable_from, auth_ref,
        preferred_model: preferred_model || null,
        rpm_limit: Number.isFinite(rpm_limit) ? rpm_limit : undefined,
      }, supabase);
      audit('CONN_ADD', `Endpoint ${ep.id} (${provider})`, 200, 0);
      res.json({ ok: true, endpoint: ep });
    } catch (e) {
      // addEndpoint throws operator-facing refusals with e.status = 400. This
      // used to answer 500 for all of them, turning "enter a Base URL" into
      // "internal server error".
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // ── DELETE /api/connections/:id ────────────────────────────────────
  app.delete('/api/connections/:id', async (req, res) => {
    try {
      // Capture the provider before removal so we can dehydrate its runtime
      // keys if this was the provider's last endpoint. Without this, deleted
      // keys ghost in process.env + pools until restart (Fleet Control bug).
      let provider = null;
      try {
        const before = await endpoints.load(supabase);
        provider = (before.endpoints || []).find(e => e.id === req.params.id)?.provider || null;
      } catch {}
      const reg = await endpoints.removeEndpoint(req.params.id, supabase);
      if (provider && deps.dehydrateProvider
        && !(reg.endpoints || []).some(e => e.provider === provider)) {
        deps.dehydrateProvider(provider);
      }
      audit('CONN_REMOVE', `Endpoint ${req.params.id}`, 200, 0);
      res.json({ ok: true, endpoints: reg.endpoints });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /api/connections/assign-role — global role → endpoint+model ─
  app.post('/api/connections/assign-role', async (req, res) => {
    try {
      const { role, endpoint_id, model, cloud_fallback } = req.body || {};
      if (!role || !endpoint_id || !model)
        return res.status(400).json({ error: 'role, endpoint_id, model required' });
      const mapping = await endpoints.assignRole(role, endpoint_id, model, cloud_fallback, supabase);
      audit('CONN_ASSIGN', `${role} → ${endpoint_id}/${model}`, 200, 0);
      res.json({ ok: true, mapping });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── GET /api/connections/resolve/:role — debug what the kernel picks ─
  app.get('/api/connections/resolve/:role', async (req, res) => {
    const r = await endpoints.resolveForRole(req.params.role, supabase);
    // Never leak the key to the client — report presence only.
    if (r.apiKey) { r.hasKey = true; delete r.apiKey; }
    res.json(r);
  });

  // ── POST /api/connections/sync — force desktop → cloud mirror ───────
  app.post('/api/connections/sync', async (req, res) => {
    try {
      const reg = await endpoints.load(supabase);
      await endpoints.save(reg, supabase);     // re-write pushes to cloud
      const vaultOk = vault.isUnlocked() ? await vault.syncToCloud(supabase) : false;
      res.json({ ok: true, registry: true, vault: vaultOk, mirror: !!supabase });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
