/**
 * /api/build — Track B pipeline + Track W approval routing + B7 IDE mode.
 *
 *   POST /api/build/scaffold              { id, label, api, widget, storage, memory, ... } → envelope payload
 *   POST /api/build/validate              { source?, manifest, files } — every gate, writes nothing
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
const { scaffold } = require('../blockScaffold.cjs');

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

  // Master M1 — turn scaffold options into an envelope payload. Emits files,
  // writes none. The response feeds /validate and /submit unchanged.
  router.post('/scaffold', (req, res) => {
    const result = scaffold(req.body || {});
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  });

  // Master M2 — every gate, no disk. 200 even when the block would fail: the
  // check ran successfully and its answer is "no". Reserve non-2xx for a
  // check that could not be performed, so "your block is bad" and "the
  // checker is broken" never wear the same status code.
  router.post('/validate', async (req, res) => {
    const { source = 'local', ...payload } = req.body || {};
    const result = await pipeline.validateBuild(source, payload);
    res.status(result.ok ? 200 : 400).json(result);
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

  // ── Block lifecycle: start / stop / uninstall / restore ─────────────────
  // Measured 2026-09-23, one block at a time: 16 of 17 blocks can leave and
  // AEON continues — but stop answered 400 for every shipped block (only
  // pipeline installs had run state), there was no uninstall, and a rescan
  // left removed blocks' commands listed. Nothing here deletes: uninstall moves
  // the folder to <data>/removed-blocks/<id>@<time>, restore moves it back.
  const runState = require('../runState.cjs');
  const fs = require('fs');
  const path = require('path');
  const blocksDir = deps.blocksDir || require('../blocksDir.cjs').BLOCKS_DIR;
  const removedDir = deps.removedDir || path.join(
    require('../aeonHome.cjs').roots({ appRoot: path.join(__dirname, '..', '..', '..') }).data, 'removed-blocks');
  // Without security every guarded route answers 401 and login 404 — the
  // operator is locked out (measured). It can be neither stopped nor removed here.
  const NEVER_STOP = new Set(['security']);
  const ID_RE = /^[a-z0-9][a-z0-9_]*$/;
  const blockPath = (id) => path.join(blocksDir, id);
  const isInstalled = (id) => ID_RE.test(id) && fs.existsSync(path.join(blockPath(id), 'block.manifest.json'));
  const refuse = (res, status, error) => res.status(status).json({ ok: false, error });
  // A kernel rescan remounts block APIs; the command registry scans on its own.
  // Both, every time, or a removed block's /commands keep answering 404.
  const rescanAll = (reason) => {
    const result = kernelRescan ? kernelRescan(reason) : { ok: false, error: 'rescan unavailable (Vercel mode)' };
    try { deps.commandRescan?.(); } catch (e) { result.commandRescanError = e.message; }
    return result;
  };
  const dependentsOf = (id) => {
    const out = [];
    for (const d of fs.readdirSync(blocksDir, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith('_') || d.name === id) continue;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(blocksDir, d.name, 'block.manifest.json'), 'utf8'));
        if ((m.requires?.blocks || []).includes(id)) out.push(d.name);
      } catch { /* not a block */ }
    }
    return out.sort();
  };
  // rename, or copy + remove when the two roots are on different volumes.
  const move = (from, to) => {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try { fs.renameSync(from, to); }
    catch (e) {
      if (e.code !== 'EXDEV') throw e;
      fs.cpSync(from, to, { recursive: true });
      fs.rmSync(from, { recursive: true, force: true });
    }
  };
  const removedCopies = () => {
    if (!fs.existsSync(removedDir)) return [];
    return fs.readdirSync(removedDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.includes('@'))
      .map((d) => ({ blockId: d.name.split('@')[0], path: path.join(removedDir, d.name), removedAt: d.name.split('@')[1] }))
      .sort((a, b) => String(b.removedAt).localeCompare(String(a.removedAt)));
  };
  const UI_NOTE = 'The block\'s screen changes after `npm run build` (then reload the tab); no restart is needed.';

  router.get('/blocks', (_req, res) => res.json({ blocks: runState.listManual() }));
  router.get('/blocks/removed', (_req, res) => res.json({ removed: removedCopies() }));
  router.get('/blocks/:id/state', (req, res) => res.json({ blockId: req.params.id, ...runState.getState(req.params.id) }));
  router.post('/blocks/:id/start', (req, res) => {
    const id = req.params.id;
    if (!isInstalled(id)) return refuse(res, 404, `no installed block "${id}"`);
    const r = runState.setRunning(id, true, { operator: operator(req), allowAuto: true });
    res.status(r.ok ? 200 : 400).json(r);
  });
  router.post('/blocks/:id/stop', (req, res) => {
    const id = req.params.id;
    if (NEVER_STOP.has(id)) return refuse(res, 409, `"${id}" cannot be stopped: without it every guarded route answers 401 and login is gone — the operator would be locked out.`);
    if (!isInstalled(id)) return refuse(res, 404, `no installed block "${id}"`);
    const r = runState.setRunning(id, false, { operator: operator(req), allowAuto: true });
    res.status(r.ok ? 200 : 400).json(r);
  });

  router.post('/blocks/:id/uninstall', (req, res) => {
    const id = req.params.id;
    if (NEVER_STOP.has(id)) return refuse(res, 409, `"${id}" cannot be uninstalled: without it the operator is locked out of every guarded route.`);
    if (!isInstalled(id)) return refuse(res, 404, `no installed block "${id}"`);
    const dependents = dependentsOf(id);
    const movedTo = path.join(removedDir, `${id}@${new Date().toISOString().replace(/[:.]/g, '-')}`);
    try { move(blockPath(id), movedTo); }
    catch (e) { return refuse(res, 500, `could not move ${id} aside: ${e.message}`); }
    try { runState.forget(id); } catch { /* state file unavailable; a reinstall resets anyway */ }
    const rescan = rescanAll(`uninstall:${id}`);
    try { global.broadcastTerminalEvent?.('BLOCK-LIFECYCLE', `${id} UNINSTALLED by ${operator(req)}`); } catch {}
    res.json({
      ok: true, removed: id, movedTo, dependents, rescan, ui: UI_NOTE,
      ...(dependents.length ? { warning: `${dependents.join(', ')} declare${dependents.length === 1 ? 's' : ''} a dependency on ${id} and will be degraded until it is restored.` } : {}),
      restore: `POST /api/build/blocks/${id}/restore`,
    });
  });

  router.post('/blocks/:id/restore', (req, res) => {
    const id = req.params.id;
    if (!ID_RE.test(id)) return refuse(res, 400, 'invalid block id');
    if (isInstalled(id)) return refuse(res, 409, `"${id}" is already installed — remove it first to restore an older copy.`);
    const copy = removedCopies().find((c) => c.blockId === id);
    if (!copy) return refuse(res, 404, `no removed copy of "${id}" under ${removedDir}`);
    try { move(copy.path, blockPath(id)); }
    catch (e) { return refuse(res, 500, `could not restore ${id}: ${e.message}`); }
    const rescan = rescanAll(`restore:${id}`);
    try { global.broadcastTerminalEvent?.('BLOCK-LIFECYCLE', `${id} RESTORED by ${operator(req)}`); } catch {}
    res.json({ ok: true, restored: id, from: copy.path, rescan, ui: UI_NOTE });
  });

  router.post('/rescan', (_req, res) => {
    const result = rescanAll('manual');
    res.status(result.ok ? 200 : 503).json(result);
  });

  return router;
};
