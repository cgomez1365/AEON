const express = require('express');
const fs = require('fs');
const path = require('path');

module.exports = function createSyncRouter(deps) {
  const router = express.Router();
  const { supabase, isVercel, getLocalFile, getDataFile, validateSDI, writeOSAudit } = deps;

  // Found live, 2026-09-20 (CEO: "check supabase to matrix sync... triple
  // checked"). Four entries below never had a reader or writer ANYWHERE else
  // in the repo — confirmed by grepping the whole tree for their filenames —
  // leftovers from a retired business-operations block set (inventory,
  // scheduler, staff, HR were never rebuilt onto the current 17-block set).
  // Syncing an orphaned file both ways was a no-op dressed as a feature.
  // Removed per §21 (gate first, prove dead — the grep above is the proof;
  // this file's own suite is the gate: tests/sync-block-config.test.js).
  //
  //   inventory: { file: getLocalFile('inventory.json'), ... }
  //   scheduler: { file: getLocalFile('scheduler.json'), ... }
  //   staff:     { file: getLocalFile('staff.json'), ... }
  //   hr_arsenal:{ file: getLocalFile('hr_arsenal.json'), ... }
  //
  // `compare` computed `path.join(__dirname, '../src/blocks/compare/data/…')`
  // — __dirname is already inside aeon_matrix/api, so this resolved to
  // aeon_matrix/src/blocks/compare/…, which has never existed. Even fixed,
  // it would point at a block that is itself gone: council absorbed compare
  // and keeps its OWN history at getDataFile('council/compare') — a local,
  // per-install comparison scratchpad, never a declared cloud-sync target.
  // Repointing this entry at council's path would be a NEW decision to sync
  // that data (§08); removing a broken pointer to a dead block is not.
  //
  // `cookbook` had the same double-`src/blocks` bug AND the wrong root —
  // cookbook's real state lives at getDataFile('cookbook'), not inside the
  // install tree. That one WAS a decision already made (cookbook install
  // state syncing for mobile visibility, same as activity/quick_links/
  // logistics) — only the path was wrong, so it is fixed below, not removed.
  const BLOCK_CONFIG = {
    clients:          { file: getLocalFile('clients.json'),              table: 'aeon_blocks', tag: 'clients' },
    logistics:        { file: getLocalFile('logistics_ledger.json'),     table: 'aeon_blocks', tag: 'logistics' },
    cookbook:         { file: path.join(getDataFile('cookbook'), 'cookbook_state.json'), table: 'aeon_blocks', tag: 'cookbook' },
    activity:         { file: getLocalFile('activity_heatmap.json'),     table: 'aeon_blocks', tag: 'activity' },
    quick_links:      { file: getLocalFile('quick-links.json'),          table: 'aeon_blocks', tag: 'quick_links' },
  };

  // ── Generic helpers ─────────────────────────────────────────────────
  const readLocal = (filePath) => {
    if (!fs.existsSync(filePath)) return null;
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
  };

  // Used to swallow every write failure into console.error and report
  // success regardless (R-05). bulk-pull, POST /:block and /:block/patch all
  // called this and then unconditionally answered {pulled:true}/
  // {success:true} — a write that actually failed (a missing directory for a
  // path that was wrong, a full disk, a permissions error) read to the
  // operator exactly like one that landed. Now it says which.
  const writeLocal = (filePath, data) => {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      return { ok: true };
    } catch (e) {
      console.error('[SYNC] Local write failed:', filePath, e.message);
      return { ok: false, error: e.message };
    }
  };

  const readFromSupabase = async (tag) => {
    if (!supabase) return null;
    try {
      const { data, error } = await supabase
        .from('aeon_blocks')
        .select('payload, updated_at')
        .eq('block_tag', tag)
        .single();
      if (error && error.code !== 'PGRST116') throw error;
      return data ? data.payload : null;
    } catch (e) {
      console.error(`[SYNC] Supabase read failed (${tag}):`, e.message);
      return null;
    }
  };

  const writeToSupabase = async (tag, payload) => {
    if (!supabase) return;
    try {
      await supabase
        .from('aeon_blocks')
        .upsert({
          block_tag: tag,
          payload,
          updated_at: new Date().toISOString()
        }, { onConflict: 'block_tag' });
    } catch (e) {
      console.error(`[SYNC] Supabase write failed (${tag}):`, e.message);
    }
  };

  // ═══════════════════════════════════════════════════════════════════
  //  BULK SYNC — must be before :block wildcard routes
  // ═══════════════════════════════════════════════════════════════════

  router.post('/sync/bulk-push', async (req, res) => {
    if (!supabase) return res.json({ success: false, reason: 'no supabase' });
    if (isVercel) return res.json({ success: false, reason: 'cloud env — nothing to push' });
    const results = {};
    for (const [block, cfg] of Object.entries(BLOCK_CONFIG)) {
      const local = readLocal(cfg.file);
      if (local) {
        await writeToSupabase(cfg.tag, local);
        results[block] = { pushed: true, records: Array.isArray(local) ? local.length : 1 };
      } else {
        results[block] = { pushed: false, reason: 'no local file' };
      }
    }
    res.json({ success: true, results });
  });

  router.post('/sync/bulk-pull', async (req, res) => {
    if (!supabase) return res.json({ success: false, reason: 'no supabase' });
    if (isVercel) return res.json({ success: false, reason: 'cloud env — no local files' });
    const results = {};
    let anyWriteFailed = false;
    for (const [block, cfg] of Object.entries(BLOCK_CONFIG)) {
      const cloud = await readFromSupabase(cfg.tag);
      if (cloud) {
        const w = writeLocal(cfg.file, cloud);
        if (w.ok) {
          results[block] = { pulled: true, records: Array.isArray(cloud) ? cloud.length : 1 };
        } else {
          anyWriteFailed = true;
          results[block] = { pulled: false, reason: `write failed: ${w.error}` };
        }
      } else {
        results[block] = { pulled: false, reason: 'no cloud data' };
      }
    }
    // `success: true` used to mean only "the loop finished", true even when
    // every write inside it failed. It now means what an operator reads it
    // to mean: nothing in `results` silently lied about landing.
    res.json({ success: !anyWriteFailed, results });
  });

  // ═══════════════════════════════════════════════════════════════════
  //  GENERIC BLOCK SYNC — GET / POST / PATCH
  // ═══════════════════════════════════════════════════════════════════

  router.get('/sync/:block', async (req, res) => {
    const block = req.params.block;
    const cfg = BLOCK_CONFIG[block];
    if (!cfg) return res.status(404).json({ error: `Unknown block: ${block}` });

    if (isVercel) {
      const cloud = await readFromSupabase(cfg.tag);
      return res.json({ source: 'cloud', data: cloud || [] });
    }

    const local = readLocal(cfg.file);
    res.json({ source: 'local', data: local || [] });

    if (supabase) {
      readFromSupabase(cfg.tag).then(cloud => {
        if (cloud) writeLocal(cfg.file, cloud);
      });
    }
  });

  router.post('/sync/:block', async (req, res) => {
    const block = req.params.block;
    const cfg = BLOCK_CONFIG[block];
    if (!cfg) return res.status(404).json({ error: `Unknown block: ${block}` });

    const payload = req.body.data;
    if (payload === undefined) return res.status(400).json({ error: 'data field required' });

    if (isVercel) {
      await writeToSupabase(cfg.tag, payload);
      return res.json({ success: true, target: 'cloud' });
    }

    const w = writeLocal(cfg.file, payload);
    if (!w.ok) return res.status(500).json({ success: false, target: 'local', error: w.error });
    res.json({ success: true, target: 'local' });

    if (supabase) {
      writeToSupabase(cfg.tag, payload);
    }
  });

  router.post('/sync/:block/patch', async (req, res) => {
    const block = req.params.block;
    const cfg = BLOCK_CONFIG[block];
    if (!cfg) return res.status(404).json({ error: `Unknown block: ${block}` });

    const { id, record, action } = req.body;
    if (!action) return res.status(400).json({ error: 'action required (add/update/delete)' });

    const load = async () => {
      if (isVercel) return (await readFromSupabase(cfg.tag)) || [];
      return readLocal(cfg.file) || [];
    };

    let items = await load();

    if (action === 'add') {
      const newRecord = { id: id || `${block.toUpperCase()}-${Date.now()}`, ...record };
      items = Array.isArray(items) ? [...items, newRecord] : [newRecord];
    } else if (action === 'update') {
      if (!id) return res.status(400).json({ error: 'id required for update' });
      items = items.map(i => (i.id === id ? { ...i, ...record } : i));
    } else if (action === 'delete') {
      if (!id) return res.status(400).json({ error: 'id required for delete' });
      items = items.filter(i => i.id !== id);
    } else {
      return res.status(400).json({ error: `Unknown action: ${action}` });
    }

    if (isVercel) {
      await writeToSupabase(cfg.tag, items);
      return res.json({ success: true, target: 'cloud', count: items.length });
    }

    const w = writeLocal(cfg.file, items);
    if (!w.ok) return res.status(500).json({ success: false, target: 'local', error: w.error });
    res.json({ success: true, target: 'local', count: items.length });

    if (supabase) {
      writeToSupabase(cfg.tag, items);
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  //  ATS ENGINE — Extracted from src/blocks/ats_engine/module.js
  //  Uses dedicated aeon_candidates table in Supabase
  // ═══════════════════════════════════════════════════════════════════

  const ATS_FILE = getLocalFile('aeon_ats.json');

  const loadCandidates = () => {
    if (!fs.existsSync(ATS_FILE)) return [];
    try { return JSON.parse(fs.readFileSync(ATS_FILE, 'utf8')); } catch { return []; }
  };

  const saveCandidates = (data) => fs.writeFileSync(ATS_FILE, JSON.stringify(data, null, 2));

  const mapSupabaseCandidates = (data) => data.map(c => ({
    id: c.id, name: c.name, email: c.email, phone: c.phone,
    role: c.role, resumeText: c.resume_text, source: c.source,
    status: c.status, grade: c.grade, score: c.score,
    gradeRationale: c.grade_rationale, topStrengths: c.top_strengths,
    redFlags: c.red_flags, interviewRecommendation: c.interview_recommendation,
    submittedAt: c.submitted_at, gradedAt: c.graded_at
  }));

  // ── /ats/* routes removed 2026-07-17: they duplicated the ats_engine block
  //    with a hardcoded geminiRequest and won the route by mount order, so ATS
  //    grading hard-failed to Gemini. The real handlers live in resume_grader/api/
  //    (kernel-routed). Do NOT re-add ATS routes here.

  // ═══════════════════════════════════════════════════════════════════
  //  LOGISTICS — Extracted from src/blocks/logistics/module.js
  //  Uses aeon_blocks table with tag 'logistics'
  // ═══════════════════════════════════════════════════════════════════

  const LOGISTICS_FILE = getLocalFile('logistics_ledger.json');

  const loadLogistics = () => {
    if (!fs.existsSync(LOGISTICS_FILE)) return [];
    try { return JSON.parse(fs.readFileSync(LOGISTICS_FILE, 'utf8')); } catch { return []; }
  };
  const saveLogistics = (data) => fs.writeFileSync(LOGISTICS_FILE, JSON.stringify(data, null, 2));

  const syncLogisticsToSupabase = (entries) => {
    writeToSupabase('logistics', entries);
  };

  const loadLogisticsFromSupabase = async () => {
    return readFromSupabase('logistics');
  };

  router.post('/logistics/entries', async (req, res) => {
    const sdiCheck = validateSDI('logistics', req.body);
    if (!sdiCheck.valid) return res.status(400).json({ error: 'SDI Validation Failed', errors: sdiCheck.errors });
    const { itemName, barcode, quantity, unit, truck, driver, destination, notes } = req.body;

    const entry = {
      id: `LOG-${Date.now()}`,
      itemName,
      barcode: barcode || '',
      quantity: quantity || 1,
      unit: unit || 'each',
      truck: truck || 'UNASSIGNED',
      driver: driver || '',
      destination: destination || '',
      notes: notes || '',
      status: 'PENDING',
      signatureData: null,
      signedAt: null,
      createdAt: new Date().toISOString()
    };

    if (isVercel) {
      const cloud = (await loadLogisticsFromSupabase()) || [];
      cloud.unshift(entry);
      await writeToSupabase('logistics', cloud);
      return res.json({ success: true, entry });
    }
    const entries = loadLogistics();
    entries.unshift(entry);
    saveLogistics(entries);
    syncLogisticsToSupabase(entries);
    if (typeof writeOSAudit === 'function') {
      writeOSAudit('LOGISTICS_ADD', `${itemName} x${quantity} -> ${truck}`, 0, 0, req.correlationId || 'AEON-SYS');
    }
    res.json({ success: true, entry });
  });

  router.get('/logistics/entries', async (req, res) => {
    if (isVercel) {
      const cloud = await loadLogisticsFromSupabase();
      return res.json(cloud || []);
    }
    const local = loadLogistics();
    res.json(local);
    if (supabase) {
      loadLogisticsFromSupabase().then(cloud => {
        if (cloud) saveLogistics(cloud);
      });
    }
  });

  router.post('/logistics/status', async (req, res) => {
    const { entryId, status } = req.body;
    if (!entryId || !status) return res.status(400).json({ error: 'entryId and status required.' });

    if (isVercel) {
      const cloud = (await loadLogisticsFromSupabase()) || [];
      const idx = cloud.findIndex(e => e.id === entryId);
      if (idx === -1) return res.status(404).json({ error: 'Entry not found.' });
      cloud[idx].status = status;
      await writeToSupabase('logistics', cloud);
      return res.json({ success: true, entry: cloud[idx] });
    }

    const entries = loadLogistics();
    const idx = entries.findIndex(e => e.id === entryId);
    if (idx === -1) return res.status(404).json({ error: 'Entry not found.' });
    entries[idx].status = status;
    saveLogistics(entries);
    syncLogisticsToSupabase(entries);
    if (typeof writeOSAudit === 'function') {
      writeOSAudit('LOGISTICS_STATUS', `${entries[idx].itemName}: ${status}`, 0, 0, req.correlationId || 'AEON-SYS');
    }
    res.json({ success: true, entry: entries[idx] });
  });

  router.post('/logistics/sign', async (req, res) => {
    const { entryId, signatureData } = req.body;
    if (!entryId || !signatureData) return res.status(400).json({ error: 'entryId and signatureData required.' });

    if (isVercel) {
      const cloud = (await loadLogisticsFromSupabase()) || [];
      const idx = cloud.findIndex(e => e.id === entryId);
      if (idx === -1) return res.status(404).json({ error: 'Entry not found.' });
      cloud[idx].signatureData = signatureData;
      cloud[idx].signedAt = new Date().toISOString();
      cloud[idx].status = 'DELIVERED';
      await writeToSupabase('logistics', cloud);
      return res.json({ success: true, entry: cloud[idx] });
    }

    const entries = loadLogistics();
    const idx = entries.findIndex(e => e.id === entryId);
    if (idx === -1) return res.status(404).json({ error: 'Entry not found.' });
    entries[idx].signatureData = signatureData;
    entries[idx].signedAt = new Date().toISOString();
    entries[idx].status = 'DELIVERED';
    saveLogistics(entries);
    syncLogisticsToSupabase(entries);
    if (typeof writeOSAudit === 'function') {
      writeOSAudit('LOGISTICS_SIGN', `Delivery signed for ${entries[idx].itemName}`, 0, 0, req.correlationId || 'AEON-SYS');
    }
    res.json({ success: true, entry: entries[idx] });
  });

  router.delete('/logistics/entries/:id', async (req, res) => {
    if (isVercel) {
      const cloud = (await loadLogisticsFromSupabase()) || [];
      const filtered = cloud.filter(e => e.id !== req.params.id);
      await writeToSupabase('logistics', filtered);
      return res.json({ success: true });
    }
    const entries = loadLogistics().filter(e => e.id !== req.params.id);
    saveLogistics(entries);
    syncLogisticsToSupabase(entries);
    res.json({ success: true });
  });

  return router;
};
