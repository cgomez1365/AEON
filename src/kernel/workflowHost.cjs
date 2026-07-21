/**
 * S2 (Month 5) — generic per-block workflow runtime, factored from the
 * workflow_engine block so a workflow can ship as a store cartridge.
 *
 * A workflow cartridge block calls createWorkflowHost(__dirname-of-block) and
 * gets a Router serving ONE definition under its own namespace:
 *
 *   GET  /crn/<blockId>            — definition + records
 *   POST /crn/<blockId>/records    — create record at initialState
 *   POST /crn/<blockId>/records/:id/trigger   { trigger }
 *   GET  /crn/<blockId>/notifications
 *
 * All side effects (W3 closed vocab) write inside the BLOCK'S OWN data/ —
 * Tier 1 by construction, same guarantee as workflow_engine. The definition
 * ships in the cartridge's definitions/ and seeds into data/ at first boot
 * (K2: data/ is never pre-populated in the shipped unit).
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const { validateWorkflow, applyTrigger, validTriggers } = require('./workflow.cjs');
const { getRoles } = require('./approvals.cjs');

/**
 * S3 (Month 5) — cross-track interface, DECIDED: a block firing a workflow
 * transition is a cross-block WRITE (Tier 2), declared through the EXISTING
 * manifest field contract.outputs — never Tier 1.5 (that tier is read-only by
 * K4 definition) and not a W3 vocab entry (W3 says what transitions do, not
 * who may fire them). No schema change; the complexity gate already scores
 * declared outputs into another block as MEDIUM single-click.
 *
 * Enforcement mirrors R3's dual gate: caller identity via x-aeon-block header.
 * No header = operator/UI traffic, passes. A foreign block must declare
 *   contract.outputs: [{ block: "<target>", type: "workflowTransition",
 *                        workflows: ["<wf-id>"] }]   // workflows optional = all
 * or the trigger is refused 403 at this boundary.
 */
function authorizeTransitionCaller(callerBlock, targetBlock, workflowId) {
  if (!callerBlock || callerBlock === targetBlock) return { ok: true, via: 'operator-or-self' };
  try {
    const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'blocks', callerBlock, 'block.manifest.json'), 'utf8'));
    const declared = (m.contract?.outputs || []).some(o =>
      o && typeof o === 'object' && o.block === targetBlock && o.type === 'workflowTransition' &&
      (!o.workflows || o.workflows.includes(workflowId)));
    return declared
      ? { ok: true, via: 'declared-output-tier2' }
      : { ok: false, error: `block "${callerBlock}" has no declared workflowTransition output for ${targetBlock}/${workflowId} — Tier 2: declare it in contract.outputs and rebuild` };
  } catch {
    return { ok: false, error: `caller block "${callerBlock}" not found — undeclared callers cannot fire transitions` };
  }
}

function createWorkflowHost(blockDir) {
  const router = express.Router();
  const blockId = path.basename(blockDir);

  const DATA_DIR = path.join(blockDir, 'data');
  const DEFS_DIR = path.join(DATA_DIR, 'definitions');
  const RECS_DIR = path.join(DATA_DIR, 'records');
  for (const d of [DEFS_DIR, RECS_DIR]) fs.mkdirSync(d, { recursive: true });

  // Seed shipped definition(s) into data/ once (same first-boot copy as workflow_engine).
  const SHIPPED = path.join(blockDir, 'definitions');
  if (fs.existsSync(SHIPPED)) {
    for (const f of fs.readdirSync(SHIPPED).filter(f => f.endsWith('.workflow.json'))) {
      const dst = path.join(DEFS_DIR, f);
      if (!fs.existsSync(dst)) fs.copyFileSync(path.join(SHIPPED, f), dst);
    }
  }

  const readJson  = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };
  const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2), 'utf8');
  const recsPath  = () => path.join(RECS_DIR, `${blockId}.json`);

  function loadDef() {
    const p = path.join(DEFS_DIR, `${blockId}.workflow.json`);
    const def = readJson(p, null);
    if (!def) return null;
    return validateWorkflow(def).length ? null : def;
  }

  function actorFrom(req) {
    const user = req.headers['x-aeon-operator'] || 'operator';
    const roles = ['operator'];
    try { if (getRoles().admin === user) roles.push('admin'); } catch {}
    return { user, roles };
  }

  function interpolate(tpl, record) {
    if (typeof tpl !== 'string') return tpl;
    return tpl.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, keypath) =>
      keypath.split('.').reduce((o, k) => (o == null ? o : o[k]), record) ?? '');
  }

  // W3 executors — identical closed vocabulary as workflow_engine, own data/ only.
  function executeEffects(record, effects) {
    const applied = [];
    for (const fx of effects) {
      switch (fx.type) {
        case 'moveRow':  record.column = fx.toColumn; break;
        case 'setField': record.fields = { ...record.fields, [fx.field]: interpolate(fx.value, record) }; break;
        case 'createTab': {
          const p = path.join(DATA_DIR, 'tabs.json');
          const tabs = readJson(p, {});
          (tabs[fx.tab] ||= []).push({ recordId: record.id, wf: blockId, at: Date.now() });
          writeJson(p, tabs);
          break;
        }
        case 'notify': {
          const p = path.join(DATA_DIR, 'notifications.json');
          const feed = readJson(p, []);
          const message = interpolate(fx.message, record);
          feed.unshift({ wf: blockId, recordId: record.id, message, at: new Date().toISOString() });
          writeJson(p, feed.slice(0, 500));
          try { global.broadcastTerminalEvent?.('WORKFLOW', `[${blockId}] ${message}`); } catch {}
          break;
        }
        case 'copyTo': {
          const p = path.join(DATA_DIR, `collection_${fx.collection}.json`);
          const coll = readJson(p, []);
          coll.push({ ...record, copiedAt: Date.now() });
          writeJson(p, coll);
          break;
        }
      }
      applied.push(fx.type);
    }
    return applied;
  }

  router.get(`/crn/${blockId}`, (_req, res) => {
    const def = loadDef();
    if (!def) return res.status(404).json({ error: 'workflow definition missing or invalid' });
    res.json({ definition: def, records: readJson(recsPath(), []) });
  });

  router.post(`/crn/${blockId}/records`, (req, res) => {
    const def = loadDef();
    if (!def) return res.status(404).json({ error: 'workflow definition missing or invalid' });
    const records = readJson(recsPath(), []);
    const record = {
      id: `${def.id.toUpperCase()}-${Date.now()}`,
      state: def.initialState,
      column: def.initialState,
      color: def.ui?.colors?.[def.initialState] || null,
      owner: req.body?.owner || req.headers['x-aeon-operator'] || 'operator',
      domain: def.domain || 'general',
      fields: req.body?.fields || {},
      history: [{ at: new Date().toISOString(), event: 'created', state: def.initialState }],
    };
    records.push(record);
    writeJson(recsPath(), records);
    res.json({ ok: true, record, validTriggers: validTriggers(def, record.state) });
  });

  router.post(`/crn/${blockId}/records/:id/trigger`, (req, res) => {
    const def = loadDef();
    if (!def) return res.status(404).json({ error: 'workflow definition missing or invalid' });
    const { trigger } = req.body || {};
    if (!trigger) return res.status(400).json({ error: 'trigger required' });

    // S3 — foreign blocks need a declared workflowTransition output (Tier 2).
    const authz = authorizeTransitionCaller(req.headers['x-aeon-block'], blockId, blockId);
    if (!authz.ok) return res.status(403).json({ error: authz.error });

    const records = readJson(recsPath(), []);
    const record = records.find(r => r.id === req.params.id);
    if (!record) return res.status(404).json({ error: 'record not found' });

    const result = applyTrigger(def, record.state, trigger, { actor: actorFrom(req), owner: record.owner });
    if (!result.ok) return res.status(result.denied ? 403 : 409).json({ error: result.error, validTriggers: result.validTriggers || [] });

    record.state = result.newState;
    if (result.color) record.color = result.color;
    const applied = executeEffects(record, result.sideEffects);
    record.history.push({ at: new Date().toISOString(), event: trigger, state: result.newState, effects: applied });
    writeJson(recsPath(), records);
    res.json({ ok: true, record, terminal: result.terminal, effectsApplied: applied, validTriggers: validTriggers(def, record.state) });
  });

  router.get(`/crn/${blockId}/notifications`, (_req, res) => {
    res.json(readJson(path.join(DATA_DIR, 'notifications.json'), []));
  });

  return router;
}

module.exports = { createWorkflowHost, authorizeTransitionCaller };
