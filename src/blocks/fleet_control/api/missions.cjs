/**
 * Fleet Control — VP mission history from the Vault (read-only).
 * The agent_core block that owned /api/agent/missions was removed; mission
 * records live on as files in Aeon Matrix (Vault/Agents/Aeon/missions). Fleet
 * reads them directly so the ops view never depends on a block that's gone.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { isInside } = require('../../../kernel/pathContainment.cjs');

module.exports = (deps) => {
  const router = express.Router();
  const MISSIONS_DIR = path.join(deps?.VAULT_ROOT || path.join(__dirname, '..', '..', 'aeon_matrix', 'data', 'Vault'), 'Agents', 'Aeon', 'missions');

  router.get('/fleet/missions', (req, res) => {
    if (!fs.existsSync(MISSIONS_DIR)) return res.json({ missions: [], dir: MISSIONS_DIR });
    try {
      const limit = Math.min(Number(req.query.limit) || 20, 100);
      const files = fs.readdirSync(MISSIONS_DIR)
        .filter(f => f.endsWith('.md'))
        .map(f => {
          const full = path.join(MISSIONS_DIR, f);
          const stat = fs.statSync(full);
          return { f, full, mtime: stat.mtime };
        })
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, limit);

      const missions = files.map(({ f, full, mtime }) => {
        let title = f.replace(/\.md$/, '');
        let done = 0, pending = 0, failed = 0;
        try {
          const text = fs.readFileSync(full, 'utf8');
          const h1 = text.match(/^#\s+(.{1,120})/m);
          if (h1) title = h1[1].trim();
          done    = (text.match(/\[done\]/gi)    || []).length;
          pending = (text.match(/\[pending\]/gi) || []).length;
          failed  = (text.match(/\[(failed|error)\]/gi) || []).length;
        } catch {}
        return { id: f.replace(/\.md$/, ''), title, modified: mtime, done, pending, failed,
                 status: failed ? 'failed' : pending ? 'pending' : 'done' };
      });
      res.json({ missions, count: missions.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // One mission's full markdown — for the expandable row in the UI.
  router.get('/fleet/mission/:id', (req, res) => {
    const id = req.params.id.replace(/[^a-z0-9_-]/gi, '');
    const full = path.join(MISSIONS_DIR, `${id}.md`);
    if (!isInside(MISSIONS_DIR, full) || !fs.existsSync(full)) return res.status(404).json({ error: 'Mission not found' });
    res.json({ id, content: fs.readFileSync(full, 'utf8') });
  });

  return router;
};
