/**
 * __BLANK__ block API — factory pattern (fn(deps) => express.Router).
 * Auto-mounted by the block loader when the manifest has "api_routes": true.
 * All routes MUST be namespaced /crn/__BLANK__/... — nothing else.
 */
const express = require('express');

module.exports = function (deps) {
  const router = express.Router();
  const { kernelLLM, writeOSAudit, blockStorage } = deps || {};

  // ── Block-scoped storage — the ONLY place this block persists data ──
  //
  // BO-SHIP P2.2. This scaffold used to open with `require('fs')` and write to
  // path.join(__dirname, '..', 'data') — INSIDE the block's own source folder,
  // which is the checkout. Every block cloned from here inherited both habits,
  // which is most of why 14 blocks held the real fs module and why audit P0-07
  // found the manifest sandbox unable to constrain any of them: it can only
  // withhold what it injects, and a block that requires fs was never asking.
  //
  // `blockStorage` is the sanctioned surface. Paths are RELATIVE to this
  // block's own namespace, `..` cannot escape it, and writes are refused
  // unless the manifest declares permissions.filesystem: "write".
  //
  // Do not require('fs') in a block. `npm run scan:block-fs` fails the build
  // when the number of blocks doing so rises.
  const store = blockStorage;
  const load = () => (store ? store.readJSON('items.json', []) : []);
  const save = (items) => {
    if (!store) throw new Error('This block was mounted without block storage; it cannot persist.');
    store.writeJSON('items.json', items);
  };

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
