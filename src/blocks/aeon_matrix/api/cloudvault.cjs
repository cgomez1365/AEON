/**
 * Second Brain — Cloud Vault Sync
 * Mirrors Second Brain documents to Supabase `vault_docs` so the Vercel
 * Command Center has full visibility on the go. Incremental: only docs
 * whose index hash changed since the last push are re-uploaded.
 *
 * Routes:
 *   POST /crn/second-brain/vault-push          — push new/changed docs to cloud
 *   GET  /crn/second-brain/vault-push/status   — last push stats
 *
 * Uses SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY directly (writes require
 * service role — see db/vault_docs_schema.sql). Run that schema once first.
 */
const express = require('express');
const path = require('path');
const { isInside } = require('../../../kernel/pathContainment.cjs');
const fs = require('fs');
const { loadExtractors, extractText } = require('./_lib.cjs');

const MAX_CONTENT = 20000; // chars per doc pushed to cloud
const BATCH = 25;

module.exports = function cloudVaultFactory(deps) {
  const router = express.Router();

  const DATA_ROOT = path.join(__dirname, '..', 'data');
  const INDEX_FILE = path.join(DATA_ROOT, 'vault_index.json');
  const STATE_FILE = path.join(DATA_ROOT, 'cloudvault_state.json');
  const VAULT_ROOT = deps?.VAULT_ROOT || path.join(DATA_ROOT, 'Vault');

  // Stored index paths are "Vault/relative/path" — resolve against the
  // shared VAULT_ROOT, same rationale as retrieve.cjs's resolveIndexedPath.
  function resolveIndexedPath(relPath) {
    const rel = relPath.startsWith('Vault/') ? relPath.slice('Vault/'.length) : relPath;
    const full = path.resolve(VAULT_ROOT, rel);
    return isInside(VAULT_ROOT, full, { allowRoot: true }) ? full : null;
  }

  const readJSON = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };

  async function sbUpsert(rows) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing in .env');
    const r = await fetch(`${url}/rest/v1/vault_docs?on_conflict=path`, {
      method: 'POST',
      headers: {
        apikey: key, Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(rows),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }

  router.post('/crn/second-brain/vault-push', async (_req, res) => {
    const index = readJSON(INDEX_FILE, { documents: {} });
    const docs = Object.values(index.documents || {});
    if (!docs.length) return res.status(400).json({ error: 'vault_index.json empty — run a Second Brain reindex first' });

    const state = readJSON(STATE_FILE, { pushed: {} });
    // hash = updatedAt+size from the index — cheap change detection
    const changed = docs.filter(d => {
      const h = `${d.updatedAt || 0}:${d.sizeBytes || 0}`;
      return state.pushed[d.path] !== h;
    });

    loadExtractors();
    let pushed = 0, errors = 0;
    for (let i = 0; i < changed.length; i += BATCH) {
      const slice = changed.slice(i, i + BATCH);
      const rows = [];
      for (const d of slice) {
        let content = d.summary || '';
        try {
          const full = resolveIndexedPath(d.path);
          if (full && fs.existsSync(full)) {
            content = (await extractText(full)) || content;
          }
        } catch { /* summary fallback */ }
        rows.push({
          path: d.path,
          title: d.title || path.basename(d.path),
          summary: (d.summary || '').slice(0, 1000),
          content: String(content).slice(0, MAX_CONTENT),
          tags: Array.isArray(d.tags) ? d.tags : [],
          hash: `${d.updatedAt || 0}:${d.sizeBytes || 0}`,
          updated_at: new Date().toISOString(),
        });
      }
      try {
        await sbUpsert(rows);
        for (const r of rows) state.pushed[r.path] = r.hash;
        pushed += rows.length;
      } catch (e) {
        errors++;
        console.warn('[CLOUDVAULT] batch failed:', e.message);
        if (errors >= 3) break; // don't hammer a broken connection
      }
    }

    state.lastPush = new Date().toISOString();
    state.lastResult = { total: docs.length, changed: changed.length, pushed, errors };
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch {}
    res.json({ ok: errors === 0, ...state.lastResult, hint: errors ? 'check server log; did you run db/vault_docs_schema.sql in Supabase?' : undefined });
  });

  router.get('/crn/second-brain/vault-push/status', (_req, res) => {
    res.json(readJSON(STATE_FILE, { pushed: {}, lastPush: null }));
  });

  return router;
};
