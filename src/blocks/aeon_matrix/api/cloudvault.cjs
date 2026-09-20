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

  // The index ingest.cjs writes lives in the shared data root — reading it
  // from the block folder found nothing once the roots moved out of the install.
  const DATA_ROOT = deps?.DATA_ROOT || path.join(__dirname, '..', 'data');
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

  // Found live, 2026-09-20: this built its OWN Supabase client from raw
  // process.env.SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY, bypassing
  // services/cloud.js — the ONE client every other consumer (sync.cjs,
  // ai.js, security.js, the terminal's isCloudLinked gate) shares via
  // deps.supabase. That client is null under AEON_LOCAL_ONLY=1 or
  // AEON_PORTABLE=true specifically so a portable/local-only install cannot
  // reach a cloud mirror (cloud.js: "a drive that boots on an untrusted host
  // must not reach for a cloud mirror") — but this route never asked it. A
  // host with leftover SUPABASE_URL/KEY env vars (a prior non-portable
  // install, an inherited shell env) would still push full Vault document
  // content off the local-only guarantee the rest of the kernel enforces.
  // The manifest's `when: "supabase"` stops the TERMINAL command from
  // reaching this in that state; it never protected a direct HTTP call.
  async function sbUpsert(rows) {
    if (!deps?.supabase) {
      const e = new Error('No cloud mirror is linked (local-only, or Supabase not configured) — nothing was sent.');
      e.code = 'no_cloud_mirror';
      throw e;
    }
    const { error } = await deps.supabase.from('vault_docs').upsert(rows, { onConflict: 'path' });
    if (error) throw new Error(`Supabase: ${error.message}`);
  }

  router.post('/crn/second-brain/vault-push', async (_req, res) => {
    if (!deps?.supabase) {
      return res.status(409).json({
        ok: false, error: 'no_cloud_mirror',
        message: 'This install is local-only, or Supabase is not configured — nothing was sent.',
        remedy: 'Add SUPABASE_URL and a key to .env and restart, or stay local. Nothing is lost.',
      });
    }
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
