/**
 * __BLANK__ block API — factory pattern (fn(deps) => express.Router).
 * Auto-mounted by the block loader when the manifest has "api_routes": true.
 * All routes MUST be namespaced /crn/__BLANK__/... — nothing else.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');

module.exports = function (deps) {
  const router = express.Router();
  const { kernelLLM, writeOSAudit } = deps || {};

  // Block-scoped storage — the ONLY place this block persists data.
  // data/ is auto-created on first write; never pre-populate it.
  const DATA_DIR = path.join(__dirname, '..', 'data');
  const DATA_FILE = path.join(DATA_DIR, 'items.json');
  const load = () => { try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return []; } };
  const save = (items) => { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(DATA_FILE, JSON.stringify(items, null, 2)); };

  // Health — every block has one; readiness checks and the dashboard use it.
  router.get('/crn/__BLANK__/health', (_req, res) => res.json({ ok: true, items: load().length }));

  /// EDIT ZONE — add your routes below, following these two working patterns.

  // Pattern 1: read the collection
  router.get('/crn/__BLANK__/items', (_req, res) => res.json(load()));

  // Pattern 2: append an item (with optional AI enrichment via the kernel)
  router.post('/crn/__BLANK__/items', async (req, res) => {
    const { text } = req.body || {};
    if (!text || !String(text).trim()) return res.status(400).json({ error: 'text required' });
    const items = load();
    const item = { id: Date.now().toString(36), text: String(text).trim(), createdAt: new Date().toISOString() };
    // AI through the kernel ONLY — never call a provider URL from a block:
    // if (kernelLLM) item.summary = await kernelLLM(`Summarize in 5 words: ${item.text}`, { role: 'chat' });
    items.push(item);
    save(items);
    if (writeOSAudit) writeOSAudit('__BLANK___ADD', item.text.slice(0, 60), 200, 0);
    res.json(item);
  });

  /// END EDIT ZONE

  return router;
};
