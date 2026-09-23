/**
 * Aeon Matrix no longer serves the old logistics block's routes, and the
 * layouts no longer redirect to the old Firebase signing page.
 *
 * Store builder B2 (2026-09-23): logistics is a store pack now (its own
 * storage, local-only). aeon_matrix/api/sync.cjs still carried the old
 * Supabase-mirrored /api/logistics/{entries,status,sign} routes — nothing in
 * AEON called them, and they took /api/logistics/status from the pack (its
 * first install was refused for the collision). The layouts sent any signed-out
 * visit with ?token= to /signflow, a route nothing serves since sign_flow
 * became a store pack at /sign_flow. Bible §21: gate first, then delete.
 * The operator's old logistics_ledger.json, if any, is left on disk untouched.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

describe('retired: the old logistics routes and the /signflow redirect', () => {
  it('aeon_matrix declares and serves no /api/logistics route', () => {
    const m = JSON.parse(read('src', 'blocks', 'aeon_matrix', 'block.manifest.json'));
    expect((m.routes || []).filter((r) => r.path.startsWith('/api/logistics'))).toEqual([]);
    expect(read('src', 'blocks', 'aeon_matrix', 'api', 'sync.cjs')).not.toMatch(/router\.\w+\(\s*['"]\/logistics/);
  });

  it('the sync table no longer mirrors the old logistics ledger', () => {
    expect(read('src', 'blocks', 'aeon_matrix', 'api', 'sync.cjs')).not.toMatch(/^\s*logistics:\s*\{/m);
  });

  it('no layout redirects to /signflow', () => {
    for (const f of ['DesktopLayout.jsx', 'MobileLayout.jsx']) {
      expect(read('src', 'components', f)).not.toMatch(/["'`]\/signflow/);
    }
  });
});
