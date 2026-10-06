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
// The key-shape rule of the Settings key store (services/settings.js
// keyShapeProblem), restated: a block may not require services/
// (tests/block-shell-contract). Printable ASCII, no spaces; the answer names
// the position, never the value. tests/sweep-keys-key-shape holds the two to
// the same words.
const KEY_SHAPE_RE = /^[\x21-\x7e]+$/;
function keyShapeProblem(value) {
  if (typeof value !== 'string' || !value) return 'is empty';
  if (KEY_SHAPE_RE.test(value)) return null;
  const chars = [...value];
  const at = chars.findIndex((ch) => !KEY_SHAPE_RE.test(ch));
  const ch = chars[at];
  const what = /\s/.test(ch) ? 'a space or line break'
    : ch.codePointAt(0) < 0x80 ? 'a control character'
    : 'a non-ASCII character (often an invisible one picked up while copying)';
  return `contains ${what} at position ${at + 1}`;
}

// A key that cannot go in a header is refused where it is saved — accepted, it
// showed "connected" and then failed every call before any HTTP status existed
// (a TypeError from Node's Headers), so it was never rotated out or cooled.
// Returns the operator-facing refusal, or null for a usable key.
const keyRefusal = (value, field = 'API key', remedy = 'Paste the key by itself, with no note after it.') => {
  const problem = keyShapeProblem(String(value).trim());
  return problem ? `${field} is not a usable key: it ${problem}. ${remedy}` : null;
};

module.exports = (app, deps) => {
  if (!vault || !endpoints) return;
  const supabase = deps && deps.supabase ? deps.supabase : null;
  const audit = (deps && deps.writeOSAudit) || (() => {});

  // forgetKey works by VALUE: every env slot and pool entry holding it goes.
  // The same key saved under another ref (a second connection) or in the
  // Settings key store (deps.providerSecretHeld — a block may not require
  // services/) is still configured, and forgetting it stopped a key that is
  // meant to serve until the next restart.
  const heldElsewhere = async (value, refs) => {
    for (const r of refs) {
      if ((await vault.getSecret(r, supabase).catch(() => null)) === value) return true;
    }
    try { if (deps && typeof deps.providerSecretHeld === 'function' && deps.providerSecretHeld(value)) return true; } catch { /* unknown: forget, as before */ }
    return false;
  };

  // ── GET /api/connections — registry + vault status (no secrets) ────
  app.get('/api/connections', async (req, res) => {
    try {
      const reg = await endpoints.load(supabase);
      const refs = vault.isUnlocked() ? await vault.listRefs(supabase) : [];
      res.json({
        // rpm_default is added to this response copy only (the Settings card
        // shows "Default: N/min" when the limit is the provider's own); it is
        // never written back to the registry.
        endpoints: (reg.endpoints || []).map(e => ({ ...e, rpm_default: endpoints.rpmDefault(e.provider) })),
        roles: reg.roles,
        // Per connection: how many accounts it holds, which one is up next,
        // which are resting. Refs only — a ref is a name, never key material.
        keyPools: await endpoints.credentialReport(supabase),
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

    let key = apiKey ? String(apiKey).trim() : null;
    let target = base_url;
    if (key) {
      const refusal = keyRefusal(key);
      if (refusal) return res.status(400).json({ ok: false, error: refusal });
    }

    if (!key && auth_ref && vault.isUnlocked()) {
      const reg = await endpoints.load(supabase);
      const owner = (reg.endpoints || []).find(e => e.auth_ref === auth_ref);
      if (!owner) {
        return res.status(403).json({ ok: false, error: 'That saved key does not belong to any connection.' });
      }
      // The registry's address wins — never the request's.
      target = owner.base_url || null;
      key = await vault.getSecret(auth_ref, supabase);
      // A key saved before keys were checked can still hold such a value; say
      // so, instead of discovery's "Could not reach that address".
      const refusal = key ? keyRefusal(key, 'The saved key', 'Re-enter it on this connection.') : null;
      if (refusal) return res.json({ ok: false, error: refusal });
    }

    // The catalogue, not just the ids: `free` carries the rows the provider
    // itself priced at zero, and `models` arrives with those first. Without it
    // this route handed the form a paid-first list and the form auto-selected
    // models[0] — which on OpenRouter is a paid model, every time.
    const found = await endpoints.discoverModelCatalogue(provider, target, key);
    if (found && found.error) return res.json({ ok: false, error: found.error, manual: !!found.manual });
    res.json({ ok: true, models: found.models, free: found.free });
  });

  // ── POST /api/connections — add/update an endpoint (+ optional key) ─
  app.post('/api/connections', async (req, res) => {
    try {
      const { id, label, provider, base_url, models, reachable_from,
              preferred_model, rpm_limit } = req.body || {};
      if (!provider) return res.status(400).json({ error: 'provider required' });
      // Same reading of the limit as POST /:id/rpm, and before anything is
      // written: a refused limit must not leave a key behind in the vault.
      let rpmValue;
      if (rpm_limit !== undefined) {
        const n = endpoints.normalizeRpmLimit(rpm_limit);
        if (!n.ok) return res.status(400).json({ error: n.error });
        if (!n.unset) rpmValue = n.value;
        if (rpmValue !== undefined && !endpoints.isPaced(provider)) return res.status(400).json({ error: endpoints.LOCAL_NOT_PACED });
      }
      // Stored trimmed — it used to go into the vault exactly as pasted.
      const apiKey = req.body?.apiKey ? String(req.body.apiKey).trim() : '';
      if (apiKey) {
        const refusal = keyRefusal(apiKey);
        if (refusal) return res.status(400).json({ error: refusal });
      }

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
      // On a re-save the list it joins is the one already on the connection.
      if (preferred_model) {
        const prior = id ? ((await endpoints.load(supabase)).endpoints || []).find(e => e.id === id && e.provider === provider) : null;
        const known = modelList && modelList.length ? modelList : (prior?.models || []);
        if (!known.includes(preferred_model)) modelList = [preferred_model, ...known];
      }

      // For the audit line below: what the limit was before this save.
      const priorRow = id ? ((await endpoints.load(supabase)).endpoints || []).find(e => e.id === id && e.provider === provider) : null;
      const priorLimit = priorRow ? (priorRow.rpm_limit ?? null) : null;

      // What the caller did not send is passed as undefined, which addEndpoint
      // reads as "leave it as it is" — an empty list or a null is a decision.
      const ep = await endpoints.addEndpoint({
        id, label, provider, base_url, reachable_from, auth_ref,
        models: Array.isArray(modelList) && modelList.length ? modelList : undefined,
        preferred_model: preferred_model || undefined,
        rpm_limit: rpmValue,
      }, supabase);
      audit('CONN_ADD', `Endpoint ${ep.id} (${provider})`, 200, 0);
      // The limit is the operator's own policy, so a change made here is
      // recorded exactly as one made through POST /:id/rpm is.
      if (rpmValue !== undefined && rpmValue !== priorLimit) {
        audit('CONN_RPM', `Endpoint ${ep.id} (${provider}) rpm_limit ${priorLimit ?? 'unset'} -> ${ep.rpm_limit ?? 'unset'}`, 200, 0);
      }
      res.json({ ok: true, endpoint: ep });
    } catch (e) {
      // addEndpoint throws operator-facing refusals with e.status = 400. This
      // used to answer 500 for all of them, turning "enter a Base URL" into
      // "internal server error".
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // ── POST /api/connections/:id/rpm — the operator's requests-per-minute limit ─
  //
  // ONE field, nothing else on the row. The value is the operator's own account
  // policy, read off their provider's dashboard; no provider's number lives in
  // AEON. 0 = no pacing, empty = the provider default (only "custom" has one).
  // Takes effect on the next call: the router re-reads the registry per resolve.
  app.post('/api/connections/:id/rpm', async (req, res) => {
    try {
      const body = req.body || {};
      if (!Object.prototype.hasOwnProperty.call(body, 'rpm_limit')) {
        return res.status(400).json({ error: 'Send rpm_limit: a whole number from 0 to 600, 0 for no pacing, or empty to use the default.' });
      }
      const { endpoint, previous } = await endpoints.setRpmLimit(req.params.id, body.rpm_limit, supabase);
      const next = endpoint.rpm_limit ?? null;
      const changed = next !== previous;
      if (changed) {
        audit('CONN_RPM', `Endpoint ${endpoint.id} (${endpoint.provider}) rpm_limit ${previous ?? 'unset'} -> ${next ?? 'unset'}`, 200, 0);
      }
      res.json({
        ok: true, changed,
        endpoint: { ...endpoint, rpm_default: endpoints.rpmDefault(endpoint.provider) },
        rpm: { limit: next, previous, default: endpoints.rpmDefault(endpoint.provider) },
      });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // ── DELETE /api/connections/:id ────────────────────────────────────
  app.delete('/api/connections/:id', async (req, res) => {
    try {
      // Capture the provider before removal so we can dehydrate its runtime
      // keys if this was the provider's last endpoint. Without this, deleted
      // keys ghost in process.env + pools until restart (Fleet Control bug).
      let provider = null;
      let heldRefs = [];
      try {
        const before = await endpoints.load(supabase);
        const ep = (before.endpoints || []).find(e => e.id === req.params.id);
        provider = ep?.provider || null;
        heldRefs = ep ? endpoints.credentialRefs(ep) : [];
      } catch {}
      const reg = await endpoints.removeEndpoint(req.params.id, supabase);
      if (provider && deps.dehydrateProvider
        && !(reg.endpoints || []).some(e => e.provider === provider)) {
        deps.dehydrateProvider(provider);
      }
      // The connection's keys go with it (measured 2026-09-23: they stayed in
      // the vault, encrypted, referenced by nothing, shown nowhere). A ref
      // another connection still uses is kept — auth_ref can be shared.
      //
      // And they stop serving now. Only the provider's LAST connection was
      // dehydrated (and only for four providers), so deleting one of two
      // OpenRouter connections left its key in OPENROUTER_API_KEY_n and the
      // pool, rotated into requests until restart, while this answered
      // removedKeys:[ref]. Same read-then-forget as the per-key DELETE below.
      const stillUsed = new Set((reg.endpoints || []).flatMap(e => endpoints.credentialRefs(e)));
      const removedKeys = [];
      const keptKeys = [];
      for (const ref of heldRefs) {
        if (stillUsed.has(ref)) { keptKeys.push(ref); continue; }
        const secretValue = await vault.getSecret(ref, supabase).catch(() => null);
        try { await vault.removeSecret(ref, supabase); removedKeys.push(ref); }
        catch (e) { keptKeys.push(ref); console.warn(`[CONNECTIONS] could not remove key ${ref}: ${e.message}`); continue; }
        if (deps.forgetKey && secretValue && !(await heldElsewhere(secretValue, [...stillUsed]))) deps.forgetKey(secretValue);
      }
      audit('CONN_REMOVE', `Endpoint ${req.params.id}${removedKeys.length ? ` + ${removedKeys.length} key(s)` : ''}`, 200, 0);
      res.json({ ok: true, endpoints: reg.endpoints, removedKeys, keptKeys });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Key pools: several accounts behind one connection ──────────────
  //
  // Several keys the operator is entitled to use, for failover; not a way
  // around a provider's limits. The kernel round-robins the pool per turn,
  // paces each key on its own per-minute budget, and rests one that answers
  // 429/402/401 instead of condemning the whole provider.

  // POST /api/connections/:id/keys — add an account to this connection
  app.post('/api/connections/:id/keys', async (req, res) => {
    try {
      const { apiKey, label } = req.body || {};
      if (!apiKey || !String(apiKey).trim()) return res.status(400).json({ error: 'Paste the API key to add.' });
      const refusal = keyRefusal(apiKey);
      if (refusal) return res.status(400).json({ error: refusal });
      if (!vault.isUnlocked()) return res.status(400).json({ error: 'Encrypted Vault is locked — unlock it before saving keys.' });

      const reg = await endpoints.load(supabase);
      const ep = (reg.endpoints || []).find(e => e.id === req.params.id);
      if (!ep) return res.status(404).json({ error: 'Connection not found' });

      // The ref is a NAME the operator will see in Settings, so it must never
      // be derived from the key. Numbered within the connection, which also
      // makes it stable across a rename.
      const existing = endpoints.credentialRefs(ep);
      const clean = String(label || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
      let ref = clean ? `${ep.id}-${clean}` : `${ep.id}-key-${existing.length + 1}`;
      let n = existing.length + 1;
      while (existing.includes(ref)) { n++; ref = `${ep.id}-key-${n}`; }

      await vault.setSecret(ref, String(apiKey).trim(), supabase);
      let updated;
      try { updated = await endpoints.addCredential(ep.id, ref, supabase); }
      catch (e) {
        // Registry refused: the secret just written is referenced by nothing.
        try { await vault.removeSecret(ref, supabase); }
        catch (ve) { console.error(`[CONNECTIONS] key ${ref} left in vault after a failed add: ${ve.message}`); }
        throw e;
      }
      // A new account is new capacity: let the running process use it without
      // a restart, the same way hydration does on boot.
      if (deps.hydrateEnvFromVault) {
        try { await deps.hydrateEnvFromVault(); }
        catch (e) { console.error('[CONNECTIONS] new key saved but not loaded until restart:', e.message); }
      }
      audit('CONN_KEY_ADD', `Endpoint ${ep.id} (${ep.provider}) key ${ref}`, 200, 0);
      res.json({ ok: true, endpoint: updated, keyPool: await endpoints.credentialReport(supabase) });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // DELETE /api/connections/:id/keys/:ref — drop one account
  app.delete('/api/connections/:id/keys/:ref', async (req, res) => {
    try {
      const { id, ref } = req.params;
      const reg = await endpoints.load(supabase);
      const ep = (reg.endpoints || []).find(e => e.id === id);
      if (!ep) return res.status(404).json({ error: 'Connection not found' });
      // Registry first: it is the one that refuses to empty the pool. Removing
      // the secret first would leave a ref pointing at nothing if it did.
      const secretValue = await vault.getSecret(ref, supabase).catch(() => null);
      const updated = await endpoints.removeCredential(id, ref, supabase);
      let warning = null;
      try { await vault.removeSecret(ref, supabase); }
      catch (e) {
        warning = `The key was removed from the connection but its secret stayed in the vault: ${e.message}`;
        console.error(`[CONNECTIONS] ${warning}`);
      }
      // The removed key stops serving now, not at the next restart — unless
      // it is still held under another name.
      const remaining = ((await endpoints.load(supabase)).endpoints || []).flatMap(e => endpoints.credentialRefs(e));
      if (deps.forgetKey && secretValue && !(await heldElsewhere(secretValue, remaining))) deps.forgetKey(secretValue);
      audit('CONN_KEY_REMOVE', `Endpoint ${id} key ${ref}`, 200, 0);
      res.json({ ok: true, endpoint: updated, keyPool: await endpoints.credentialReport(supabase), ...(warning ? { warning } : {}) });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  // ── POST /api/connections/assign-role — global role → endpoint+model ─
  app.post('/api/connections/assign-role', async (req, res) => {
    try {
      const { role, endpoint_id, model, cloud_fallback } = req.body || {};
      if (!role || !endpoint_id || !model)
        return res.status(400).json({ error: 'role, endpoint_id, model required' });
      // Unknown connection is a 404, not a role that silently points nowhere.
      const reg = await endpoints.load(supabase);
      const ep = (reg.endpoints || []).find((e) => e.id === endpoint_id);
      if (!ep) return res.status(404).json({ error: `Connection "${endpoint_id}" not found` });
      // A model this connection's provider does not list is refused (400) before
      // either store is written, so settings.models never gets a pair the
      // provider would 404 on.
      const mapping = await endpoints.assignRole(role, endpoint_id, model, cloud_fallback, supabase);
      // settings.models is what the kernel routes by; keep it the same.
      if (deps && deps.loadSettings && deps.saveSettings) {
        const s = deps.loadSettings();
        s.models = { ...(s.models || {}), [role]: { ...((s.models || {})[role] || {}), provider: ep.provider, model } };
        deps.saveSettings(s);
      }
      audit('CONN_ASSIGN', `${role} → ${endpoint_id}/${model}`, 200, 0);
      res.json({ ok: true, mapping });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
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
