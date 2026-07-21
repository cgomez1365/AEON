/**
 * /api/build — Track B pipeline + Track W approval routing + B7 IDE mode.
 *
 *   POST /api/build/submit                { source, spec, manifest, files, estimatedDailyCost, meta }
 *   GET  /api/build/queue[?status=pending]
 *   GET  /api/build/queue/:id
 *   POST /api/build/queue/:id/approve     { note }   — explicit click (W5)
 *   POST /api/build/queue/:id/reject      { note }
 *   POST /api/build/queue/check-stale                — 48h fallback sweep
 *   GET  /api/build/roles
 *   POST /api/build/roles/backup-contact  { contact }
 *   GET  /api/build/ide-mode
 *   POST /api/build/ide-mode              { active }  — explicit Tier 3 switch (B7)
 *   POST /api/build/rescan                            — manual kernel rescan (B6)
 */
const express = require('express');

module.exports = function createBuildRouter(deps) {
  const router = express.Router();
  const { pipeline, approvals, ideMode, kernelRescan } = deps;
  const operator = (req) => req.headers['x-aeon-operator'] || 'operator';

  router.post('/submit', async (req, res) => {
    const { source, ...payload } = req.body || {};
    if (!source) return res.status(400).json({ error: 'source required (kernelLLM|userKey|local|paste)' });
    const result = await pipeline.submitBuild(source, payload, { operator: operator(req) });
    res.status(result.ok ? 200 : 422).json(result);
  });

  router.get('/queue', (req, res) => {
    approvals.checkStaleQueue(); // every read sweeps for 48h-stale items (W5)
    res.json({ items: approvals.list(req.query.status || null) });
  });

  router.get('/queue/:id', (req, res) => {
    const item = approvals.getItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'approval not found' });
    res.json(item);
  });

  router.post('/queue/:id/approve', (req, res) => {
    const result = pipeline.approveBuild(req.params.id, { approver: operator(req), note: req.body?.note });
    res.status(result.ok ? 200 : result.tier3 ? 403 : 422).json(result);
  });

  router.post('/queue/:id/reject', (req, res) => {
    const result = pipeline.rejectBuild(req.params.id, { approver: operator(req), note: req.body?.note });
    res.status(result.ok ? 200 : 422).json(result);
  });

  router.post('/queue/check-stale', (_req, res) => res.json(approvals.checkStaleQueue()));

  router.get('/roles', (_req, res) => res.json(approvals.getRoles()));
  router.post('/roles/backup-contact', (req, res) => {
    if (!req.body?.contact) return res.status(400).json({ error: 'contact required' });
    res.json(approvals.setBackupContact(req.body.contact));
  });

  router.get('/ide-mode', (_req, res) => res.json(ideMode.status()));
  router.post('/ide-mode', (req, res) => {
    if (typeof req.body?.active !== 'boolean') return res.status(400).json({ error: 'active:boolean required — explicit toggle only (B7)' });
    res.json(ideMode.setActive(req.body.active, { operator: operator(req) }));
  });
  router.get('/ide-mode/audit', (req, res) => res.json({ lines: ideMode.readAudit(Number(req.query.lines) || 100) }));

  // Interruption mode — explicit start/end for self-built blocks (trading-block pattern).
  const runState = require('../runState.cjs');
  router.get('/blocks', (_req, res) => res.json({ blocks: runState.listManual() }));
  router.get('/blocks/:id/state', (req, res) => res.json({ blockId: req.params.id, ...runState.getState(req.params.id) }));
  router.post('/blocks/:id/start', (req, res) => {
    const r = runState.setRunning(req.params.id, true, { operator: operator(req) });
    res.status(r.ok ? 200 : 400).json(r);
  });
  router.post('/blocks/:id/stop', (req, res) => {
    const r = runState.setRunning(req.params.id, false, { operator: operator(req) });
    res.status(r.ok ? 200 : 400).json(r);
  });

  router.post('/rescan', (_req, res) => {
    const result = kernelRescan ? kernelRescan('manual') : { ok: false, error: 'rescan unavailable (Vercel mode)' };
    res.status(result.ok ? 200 : 503).json(result);
  });

  return router;
};
