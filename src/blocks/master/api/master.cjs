/**
 * Master block API — the reference router-pattern cartridge.
 * Copy this file when starting a new block: it shows the factory signature,
 * the widget contract, and how to read scoped deps without crashing when a
 * permission strips one away.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');

module.exports = (deps) => {
  const router = express.Router();

  // ── Widget contract ─────────────────────────────────────────────
  // Every block MAY expose GET /api/<id>/widget returning this shape.
  // The dashboard renders one card per installed block that declares a
  // `widget` section in its manifest — the weather-app-widget model.
  //   { label, kind: 'stat'|'list'|'sparkline', value, sub, items?, series? }
  router.get('/master/widget', (req, res) => {
    // _blockRegistry is a kernel-router dep, not a block dep — count folders.
    let count = 0;
    try {
      const blocksDir = path.join(__dirname, '..', '..');
      count = fs.readdirSync(blocksDir).filter(f => {
        if (f.startsWith('_')) return false;
        try { return fs.existsSync(path.join(blocksDir, f, 'block.manifest.json')); } catch { return false; }
      }).length;
    } catch {}
    res.json({
      label: 'Blocks',
      kind: 'stat',
      value: count,
      sub: 'installed cartridges',
    });
  });

  // ── Registry snapshot (also backs the /blocks terminal command) ──
  router.get('/master/registry', (req, res) => {
    const registry = deps._blockRegistry || [];
    const readiness = deps._blockReadiness || {};
    const lines = registry.map(b => {
      const id = b.id || b.folder || 'unknown';
      const ready = readiness[id]?.ready ?? b.ready ?? '?';
      return `${ready === true ? '●' : ready === false ? '○' : '◌'} ${id}`;
    });
    res.json({ ok: true, count: registry.length, blocks: registry, text: lines.join('\n') || 'no blocks registered' });
  });

  // Health ping — cheapest possible readiness probe.
  router.get('/master/ping', (req, res) => res.json({ ok: true, block: 'master', ts: Date.now() }));

  return router;
};
