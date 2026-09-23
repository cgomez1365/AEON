/**
 * The home and ops blocks declare what they really need — no more, no less.
 *
 * Measured 2026-09-23 on a fresh local install (agent C3, isolated home):
 * GET /blocks/registry reported
 *   dashboard  ready:false  missingApis ["supabase","groq","gemini"]
 *   activity   ready:false  missingApis ["supabase"]
 * while both served every route they own with neither configured — Supabase
 * is an optional mirror, and the terminal chat runs on whatever provider the
 * chat role resolves to (a local stub worked). A block the operator installs
 * and uses must not read "not ready" for credentials it does not need.
 *
 * And the other direction — real dependencies nobody declared:
 *   quick_links persists through GET/POST /api/sync/quick_links, served by
 *   aeon_matrix/api/sync.cjs (via src/kernel/contexts/linksStore.js). Without
 *   aeon_matrix every save fails.
 *   dashboard's heatmap, analytics tabs and live feed read activity's
 *   /api/token-analytics/* and /api/audit.
 *
 * `dependencies` is written as well as `requires.blocks`: normalizeManifest
 * computes `m.dependencies || m.requires.blocks`, so an existing empty
 * `dependencies: []` silently hides the declaration (cookbook shows it:
 * requires.blocks ["fleet_control"], dependencies []).
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BLOCKS = path.join(ROOT, 'src', 'blocks');
const std = require('../src/kernel/blockStandard.cjs');

const read = (id) => JSON.parse(fs.readFileSync(path.join(BLOCKS, id, 'block.manifest.json'), 'utf8'));

describe('no phantom hard requirements', () => {
  for (const id of ['dashboard', 'activity', 'fleet_control', 'quick_links']) {
    it(`${id} is ready on a bare local install`, () => {
      const r = std.checkReadiness(read(id), {});
      expect(r.missingApis).toEqual([]);
      expect(r.ready).toBe(true);
    });
  }

  it('declared env vars are ones the block\'s own code reads', () => {
    for (const id of ['dashboard', 'activity', 'fleet_control', 'quick_links']) {
      const m = read(id);
      const envs = [...new Set([...(m.env || []), ...(m.requires?.env || [])])];
      const code = [];
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (/\.(c?js|jsx)$/.test(e.name)) code.push(fs.readFileSync(p, 'utf8'));
        }
      };
      walk(path.join(BLOCKS, id));
      const src = code.join('\n');
      for (const v of envs) expect(src, `${id} declares ${v} but never reads it`).toContain(v);
    }
  });

  it('the dashboard declares the chat role, so readiness can say whether the terminal can answer', () => {
    expect(read('dashboard').contract.ai.roles).toContain('chat');
  });
});

describe('real dependencies are declared, and survive normalization', () => {
  const EXPECTED = { quick_links: ['aeon_matrix'], dashboard: ['activity'] };

  for (const [id, deps] of Object.entries(EXPECTED)) {
    it(`${id} requires ${deps.join(', ')}`, () => {
      const m = read(id);
      for (const d of deps) {
        expect(m.requires.blocks).toContain(d);
        expect(m.dependencies).toContain(d);
        expect(fs.existsSync(path.join(BLOCKS, d, 'block.manifest.json')), `${d} is a real block`).toBe(true);
      }
      // syncAllBlocks() rewrites every manifest through normalizeManifest on
      // each rescan — a declaration it drops is a declaration that never was.
      const n = std.normalizeManifest(id);
      for (const d of deps) {
        expect(n.requires.blocks).toContain(d);
        expect(n.dependencies).toContain(d);
      }
      expect(n.requires.apis).toEqual([]);
    });
  }
});
