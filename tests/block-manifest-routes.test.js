/**
 * Gate — every manifest's routes[] matches the block's real code.
 *
 * 15 of 17 manifests carried `[{ method: 'ALL', path: '/<id>/*', auth: true }]`
 * — a placeholder aeon-cli stamped at scaffold time. Nothing routed traffic by
 * it and the auth gate never read it, so it was inert rather than dangerous,
 * but a manifest is the block's declaration of itself and this one was fiction.
 *
 * The generator mirrors blockHost's mount rule by module ARITY, never by
 * parameter name. That distinction is not academic: fleet_control's
 * local-status.js is `(router, _deps) => router.get('/api/local-status')` —
 * arity 2, a plugin, mounted with no prefix, whose parameter merely happens to
 * be called `router`. Reading the name produced `/api/api/local-status`.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const blocksDir = path.join(ROOT, 'src', 'blocks');
// Scaffolds: any folder starting with '_' — the one rule every skip site uses
// (tests/scaffold-invariant.test.js).

const blockIds = fs.readdirSync(blocksDir)
  .filter(id => !id.startsWith('_') && fs.existsSync(path.join(blocksDir, id, 'block.manifest.json')));

const manifestOf = (id) => require(path.join(blocksDir, id, 'block.manifest.json'));

describe('manifest routes are generated, not guessed', () => {
  it('every manifest matches what the generator extracts from the code', () => {
    // The real gate. Editing a route without rebuilding fails here.
    const run = () => execFileSync(
      process.execPath,
      [path.join(ROOT, 'scripts', 'gen-block-routes.cjs'), '--check'],
      { encoding: 'utf8', stdio: 'pipe' }
    );
    expect(run).not.toThrow();
  });

  it('no manifest still carries the scaffold placeholder', () => {
    const offenders = blockIds.filter(id =>
      (manifestOf(id).routes || []).some(r => r.method === 'ALL' && r.path.endsWith('/*'))
    );
    expect(offenders).toEqual([]);
  });

  it('the scaffolder no longer writes a placeholder', () => {
    const cli = fs.readFileSync(path.join(ROOT, 'tools', 'aeon-cli.cjs'), 'utf8');
    expect(cli).not.toMatch(/m\.routes\s*=\s*\[\{\s*method:\s*'ALL'/);
  });
});

describe('declared paths are the paths that are actually served', () => {
  it('no route carries a doubled /api prefix', () => {
    for (const id of blockIds) {
      for (const r of manifestOf(id).routes || []) {
        expect(`${id}: ${r.path}`).not.toMatch(/\/api\/api\//);
      }
    }
  });

  it('every declared path is absolute and starts at /api', () => {
    for (const id of blockIds) {
      for (const r of manifestOf(id).routes || []) {
        expect(r.path.startsWith('/api/'), `${id}: ${r.path}`).toBe(true);
      }
    }
  });

  it('blocks with an api/ directory declare at least one route', () => {
    for (const id of blockIds) {
      if (!fs.existsSync(path.join(blocksDir, id, 'api'))) continue;
      expect((manifestOf(id).routes || []).length, `${id} has api/ but declares nothing`)
        .toBeGreaterThan(0);
    }
  });

  it('UI-only blocks declare nothing rather than something false', () => {
    for (const id of blockIds) {
      if (fs.existsSync(path.join(blocksDir, id, 'api'))) continue;
      expect(manifestOf(id).routes || []).toEqual([]);
    }
  });
});

describe('the auth flag is derived from the gate, not stamped', () => {
  // isPreAuthRoute is what the gate asks per request. The frozen regex list
  // alone missed /api/health and GET /api/security/policy, which the gate
  // opens by name — so their manifests said auth:true while the gate said open,
  // and the manifest guard (which believed the manifest) refused /api/health.
  const { isPreAuthRoute } = require('../src/kernel/server-utils/sessionValidator.cjs');

  it('agrees with the auth gate for every declared route', () => {
    for (const id of blockIds) {
      for (const r of manifestOf(id).routes || []) {
        const expected = !isPreAuthRoute(r.method, r.path);
        expect(r.auth, `${id}: ${r.method} ${r.path}`).toBe(expected);
      }
    }
  });

  it('the gate-opened routes are declared open', () => {
    const find = (id, method, p) => (manifestOf(id).routes || []).find(r => r.method === method && r.path === p);
    expect(find('host_os', 'GET', '/api/health')?.auth).toBe(false);
    expect(find('security', 'GET', '/api/security/policy')?.auth).toBe(false);
    expect(find('security', 'POST', '/api/security/policy')?.auth).toBe(true);
  });

  it('login, status and recovery are declared pre-auth — not everything is guarded', () => {
    const open = (manifestOf('security').routes || []).filter(r => !r.auth).map(r => r.path);
    expect(open).toContain('/api/auth/login');
    expect(open).toContain('/api/auth/status');
    expect(open.some(p => p.startsWith('/api/security/recovery/'))).toBe(true);
    // The placeholder claimed auth:true for all 22. If this ever returns to
    // "everything guarded", the flag has stopped being derived.
    expect(open.length).toBeGreaterThan(0);
    expect(open.length).toBeLessThan((manifestOf('security').routes || []).length);
  });
});
