/**
const { isInside } = require('../pathContainment.cjs');
 * AEON Operator Console — kernel-level terminal superpowers.
 *
 * The terminal is the window into ALL of AEON. This router gives it:
 *   GET  /god/blocks            → every block: id, label, route, readiness (for /open)
 *   GET  /god/data              → every block data namespace under DATA_ROOT
 *   GET  /god/data/:blockId     → live state files of one block (+ JSON previews)
 *   GET  /god/vault/tree        → vault folder tree (depth 2, for placement)
 *   POST /god/file-drop         → analyze a dropped file, recommend vault placement
 *   POST /god/file-save         → save the file into the chosen vault folder
 *   GET  /god/models            → providers + models grouped by key availability
 *   POST /god/model-swap        → hotswap a role's model (settings workflow, not a bypass)
 *   POST /god/keys              → add an API key (settings workflow, not a bypass)
 *
 * God mode NEVER bypasses the nervous system: key adds proxy to
 * /api/settings/secrets and model swaps proxy to /api/settings/nl, so the
 * terminal and the Settings panel stay one source of truth.
 * All routes are localhost-desktop only — never mounted on Vercel.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');

// provider → canonical env var written by the settings workflow
const PROVIDER_ENV = {
  gemini: 'GEMINI_FREE_KEY_1',
  groq: 'GROQ_API_KEY',
  openai: 'OPENAI_API_KEY',
  claude: 'ANTHROPIC_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  grok: 'GROK_API_KEY',
  brave: 'BRAVE_API_KEY',
  serper: 'SERPER_API_KEY',
  tavily: 'TAVILY_API_KEY',
};

module.exports = function ({ storage, kernelLLM, _blockRegistry, _blockReadiness } = {}) {
  const router = express.Router();
  const PORT = Number(process.env.PORT) || 3001;
  const BASE = `http://127.0.0.1:${PORT}`;
  const VAULT_ROOT = storage.VAULT_ROOT || (storage.getVaultFile ? storage.getVaultFile('') : null);
  const DATA_ROOT = storage.DATA_ROOT || (storage.getDataFile ? storage.getDataFile('') : null);
  const BLOCKS_DIR = path.join(__dirname, '..', '..', 'blocks');

  // Containment via path.relative, not a string prefix. This guards an
  // arbitrary-filename vault WRITE (/file-save), so a sibling-directory escape
  // here is a write outside the Vault.
  const safeJoin = (root, rel) => {
    const p = path.resolve(root, rel || '');
    if (!isInside(root, p, { allowRoot: true })) throw new Error('Path escapes root');
    return p;
  };

  // ── /god/blocks — for /open <block> ────────────────────────────────────────
  router.get('/blocks', (_req, res) => {
    const out = [];
    try {
      for (const folder of fs.readdirSync(BLOCKS_DIR)) {
        if (folder.startsWith('_')) continue;
        const mf = path.join(BLOCKS_DIR, folder, 'block.manifest.json');
        if (!fs.existsSync(mf)) continue;
        try {
          const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
          out.push({
            id: m.id || folder, label: m.label || folder, icon: m.icon || '▦',
            route: m.route || `/${folder}`, group: m.nav?.group || 'block',
            hidden: !!m.nav?.hidden,
            ready: _blockReadiness ? _blockReadiness[folder]?.ready !== false : true,
          });
        } catch {}
      }
    } catch {}
    res.json({ ok: true, blocks: out });
  });

  // ── /god/data — terminal reads any block's saved state ─────────────────────
  function respondBlockData(id, res) {
    const candidates = [safeJoin(DATA_ROOT, id), path.join(BLOCKS_DIR, id, 'data')];
    const files = [];
    const walk = (dir, base, depth) => {
      if (depth > 2) return;
      let entries = [];
      try { entries = fs.readdirSync(dir); } catch { return; }
      for (const f of entries) {
        const full = path.join(dir, f);
        let st; try { st = fs.statSync(full); } catch { continue; }
        if (st.isDirectory()) { walk(full, base ? `${base}/${f}` : f, depth + 1); continue; }
        const rel = base ? `${base}/${f}` : f;
        const entry = { file: rel, size: st.size, modified: st.mtime };
        if (f.endsWith('.json') && st.size < 200 * 1024) {
          try {
            const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
            entry.preview = JSON.stringify(parsed, null, 1).slice(0, 500);
            entry.shape = Array.isArray(parsed) ? `array[${parsed.length}]` : `object{${Object.keys(parsed).length} keys}`;
          } catch { entry.preview = '(unparseable JSON)'; }
        }
        files.push(entry);
      }
    };
    for (const c of candidates) walk(c, '', 0);
    if (!files.length) return res.status(404).json({ ok: false, error: `No saved data found for "${id}".` });
    res.json({ ok: true, blockId: id, files, text: files.map(f => `${f.file}  ${(f.size / 1024).toFixed(1)}kb  ${f.shape || ''}`).join('\n') });
  }

  // ?block= lets the command bus dispatch /data with a query param instead of
  // a path segment — blocks declare route /api/console/data in their manifest and
  // the bus appends ?block=<arg> for GET commands.
  router.get('/data', (req, res) => {
    const blockId = req.query.block;
    if (blockId) return respondBlockData(String(blockId).replace(/[^A-Za-z0-9_-]/g, ''), res);
    const namespaces = new Set();
    try { for (const d of fs.readdirSync(DATA_ROOT)) if (fs.statSync(path.join(DATA_ROOT, d)).isDirectory()) namespaces.add(d); } catch {}
    try {
      for (const b of fs.readdirSync(BLOCKS_DIR)) {
        if (!b.startsWith('_') && fs.existsSync(path.join(BLOCKS_DIR, b, 'data'))) namespaces.add(b);
      }
    } catch {}
    const list = [...namespaces].sort();
    res.json({ ok: true, namespaces: list, text: list.join('\n') });
  });

  router.get('/data/:blockId', (req, res) => {
    respondBlockData(String(req.params.blockId).replace(/[^A-Za-z0-9_-]/g, ''), res);
  });

  // ── /god/vault/tree — folder map for placement decisions ───────────────────
  function vaultTree() {
    const tree = [];
    const walk = (dir, rel, depth) => {
      if (depth > 1) return;
      let entries = [];
      try { entries = fs.readdirSync(dir); } catch { return; }
      for (const f of entries) {
        const full = path.join(dir, f);
        try {
          if (fs.statSync(full).isDirectory()) {
            const r = rel ? `${rel}/${f}` : f;
            tree.push(r);
            walk(full, r, depth + 1);
          }
        } catch {}
      }
    };
    if (VAULT_ROOT && fs.existsSync(VAULT_ROOT)) walk(VAULT_ROOT, '', 0);
    return tree;
  }
  router.get('/vault/tree', (_req, res) => res.json({ ok: true, folders: vaultTree() }));

  // ── /god/file-drop — read the file, read the vault, recommend placement ────
  router.post('/file-drop', async (req, res) => {
    try {
      const { name, content, encoding } = req.body || {};
      if (!name || content == null) return res.status(400).json({ ok: false, error: 'name and content required' });
      const folders = vaultTree();
      const text = encoding === 'base64'
        ? Buffer.from(String(content), 'base64').toString('utf8').replace(/[^\x09\x0A\x0D\x20-\x7E -￿]/g, ' ')
        : String(content);
      const sample = text.slice(0, 3000);

      let recommendation = { folder: folders[0] || 'Inbox', reason: 'Default location.' };
      if (kernelLLM && folders.length) {
        try {
          const out = await kernelLLM(
            `You organize a personal document vault. Existing folders:\n${folders.join('\n')}\n\n` +
            `A user dropped a file named "${name}". Content sample:\n---\n${sample}\n---\n` +
            `Reply with STRICT JSON only: {"folder":"<one existing folder, or a sensible new folder name>","reason":"<one plain-English sentence a non-technical user understands>"}`,
            { role: 'analyst', background: true }
          );
          const raw = typeof out === 'string' ? out : (out?.text || '');
          const m = raw.match(/\{[\s\S]*\}/);
          if (m) {
            const parsed = JSON.parse(m[0]);
            if (parsed.folder) recommendation = { folder: String(parsed.folder), reason: String(parsed.reason || '') };
          }
        } catch { /* recommendation stays default — never block the drop on LLM failure */ }
      }
      res.json({ ok: true, name, recommendation, folders });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ── /god/file-save — commit the drop into the vault ────────────────────────
  router.post('/file-save', (req, res) => {
    try {
      const { name, content, folder, encoding } = req.body || {};
      if (!name || content == null || !folder) return res.status(400).json({ ok: false, error: 'name, content, folder required' });
      const cleanName = path.basename(String(name));
      const dir = safeJoin(VAULT_ROOT, String(folder));
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, cleanName);
      const buf = encoding === 'base64' ? Buffer.from(String(content), 'base64') : Buffer.from(String(content), 'utf8');
      fs.writeFileSync(dest, buf);
      res.json({ ok: true, saved: path.join(String(folder), cleanName), text: `Saved to Vault → ${folder}/${cleanName}` });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ── /god/models — hotswap dropdown source, grouped by key availability ─────
  router.get('/models', async (_req, res) => {
    try {
      const r = await fetch(`${BASE}/api/settings/nervous-system`);
      const ns = await r.json();
      const providers = ns.providers || ns.data?.providers || [];
      const groups = (Array.isArray(providers) ? providers : Object.entries(providers).map(([id, v]) => ({ id, ...v })))
        .map(p => ({
          provider: p.id || p.provider || p.name,
          label: p.label || p.id || p.provider,
          hasKey: !!(p.hasKey ?? p.configured ?? p.ready ?? p.available),
          models: (p.models || []).map(m => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean),
        }))
        .filter(g => g.provider);
      res.json({ ok: true, groups });
    } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
  });

  // ── /god/model-swap — the settings workflow, spoken from the terminal ──────
  router.post('/model-swap', async (req, res) => {
    try {
      const { role = 'chat', provider, model } = req.body || {};
      if (!model) return res.status(400).json({ ok: false, error: 'model required' });
      const phrase = `set ${role} to ${provider ? provider + ' ' : ''}${model}`;
      const r = await fetch(`${BASE}/api/settings/nl`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phrase }),
      });
      const data = await r.json();
      res.status(r.status).json(data);
    } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
  });

  // ── /god/keys — add an API key from the terminal (settings workflow) ───────
  router.post('/keys', async (req, res) => {
    try {
      let { provider, key, arg } = req.body || {};
      // Command bus sends arg="groq gsk_abc123" when dispatched as a single-param command.
      if (arg && (!provider || !key)) { [provider, key] = String(arg).split(/\s+/); }
      const envVar = PROVIDER_ENV[String(provider || '').toLowerCase()];
      if (!envVar) return res.status(400).json({ ok: false, error: `Unknown provider "${provider}". Known: ${Object.keys(PROVIDER_ENV).join(', ')}` });
      if (!key || String(key).length < 8) return res.status(400).json({ ok: false, error: 'Key looks too short.' });
      // /api/settings/env explicitly REJECTS anything matching KEY|SECRET|TOKEN|
      // PASSWORD|CREDENTIAL (every PROVIDER_ENV var does) and tells the caller to
      // use /api/settings/secrets instead — this endpoint was silently 400ing on
      // every single call before this fix. Same {vars} body shape either way.
      const r = await fetch(`${BASE}/api/settings/secrets`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', host: `127.0.0.1:${PORT}` },
        body: JSON.stringify({ vars: { [envVar]: String(key).trim() } }),
      });
      const data = await r.json();
      res.status(r.status).json({
        ...data,
        text: data.ok !== false && !data.error
          ? `${provider} key saved (${envVar}). Blocks that need ${provider} will light up on the next restart — run /restart or use Settings → Restart.`
          : data.error,
      });
    } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
  });

  return router;
};
