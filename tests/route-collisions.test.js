// Two handlers on one (method, path) means one of them is dead code.
//
// POST /api/system/scan was registered by both src/kernel/routers/core.cjs and
// src/blocks/host_os/api/system.cjs. Express matches in registration order, so
// host_os always won and the kernel's richer handler — block readiness audit,
// matrix scan, Supabase two-way sync — had never executed. Nothing compared the
// two route tables, so it read as working code in every review.
//
// This scans registrations statically. It cannot see dynamically built paths,
// and says so rather than pretending to be exhaustive.
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (/\.(js|cjs)$/.test(e.name)) acc.push(full);
  }
  return acc;
}

/**
 * Registrations of the form router.post('/x', …) / app.get('/y', …).
 * Only string literals — a template literal is not statically knowable.
 */
function registrations(file) {
  const src = fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const out = [];
  const re = /\b(?:router|app)\.(get|post|put|patch|delete|all)\(\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src))) out.push({ method: m[1].toUpperCase(), route: m[2] });
  return out;
}

describe('no two handlers claim the same route', () => {
  // Collisions only exist between routers sharing a mount PREFIX. Kernel
  // routers are mounted at distinct prefixes (/api/system, /api/blocks,
  // /api/console …), so identical relative paths inside them are different
  // URLs. Block api/* files all mount at the bare /api prefix and are the real
  // collision surface; core.cjs is included because it also mounts at
  // /api/system, where host_os registers '/system/scan' under /api.
  const files = [
    ...walk(path.join(ROOT, 'src', 'blocks')).filter(f => f.includes(`${path.sep}api${path.sep}`)),
  ];

  // Prefix each kernel router's routes with its real mount point, read from
  // server.js rather than assumed.
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');
  const kernelPrefix = (routerVar) => {
    const m = new RegExp(`app\\.use\\('(/[^']*)'[^)]*\\b${routerVar}\\b`).exec(serverSrc);
    return m ? m[1] : null;
  };

  it('scans a meaningful number of route files', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('reports no duplicate (method, path) registrations', () => {
    const seen = new Map();
    const add = (method, fullPath, file) => {
      const key = `${method} ${fullPath.replace(/\/+$/, '') || '/'}`;
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key).push(file);
    };

    for (const f of files) {
      for (const { method, route } of registrations(f)) add(method, `/api${route}`, path.relative(ROOT, f));
    }
    // core.cjs shares the /api namespace via its /api/system mount.
    const corePrefix = kernelPrefix('coreRouter') || '/core';
    const coreFile = path.join(ROOT, 'src', 'kernel', 'routers', 'core.cjs');
    for (const { method, route } of registrations(coreFile)) {
      add(method, `${corePrefix}${route}`, path.relative(ROOT, coreFile));
    }

    const collisions = [...seen.entries()]
      .filter(([, owners]) => new Set(owners).size > 1)
      .map(([key, owners]) => `${key} → ${[...new Set(owners)].join(' vs ')}`);

    expect(collisions, `duplicate routes:\n${collisions.join('\n')}`).toEqual([]);
  });

  /**
   * BO-A2d — the manifest-based check, and why it had to be added.
   *
   * The source scan above prefixes EVERY block route with `/api`. That is only
   * correct for factory modules. A plugin module registers absolute paths on
   * the router it is handed, with no prefix — so `files/api/fs/read.js` doing
   * `app.post('/api/fs/read')` was compared as `/api/api/fs/read` and never
   * collided with host_os's `router.post('/fs/read')` → `/api/fs/read`.
   *
   * The gate had the same arity blind spot the route GENERATOR was fixed for
   * on 08-03. It reported green over a live collision for as long as it has
   * existed.
   *
   * Manifests are now generated from the code at build time and held current by
   * block-manifest-routes.test.js, so they are the authoritative route table:
   * public paths, already prefix-correct, with no arity guessing at all.
   */
  it('no two blocks declare the same public route', () => {
    const blocksDir = path.join(ROOT, 'src', 'blocks');
    const owners = new Map();

    for (const id of fs.readdirSync(blocksDir)) {
      if (id.startsWith('_')) continue;
      const mPath = path.join(blocksDir, id, 'block.manifest.json');
      if (!fs.existsSync(mPath)) continue;
      const manifest = JSON.parse(fs.readFileSync(mPath, 'utf8'));
      for (const r of manifest.routes || []) {
        const key = `${String(r.method).toUpperCase()} ${r.path}`;
        if (!owners.has(key)) owners.set(key, new Set());
        owners.get(key).add(id);
      }
    }

    const collisions = [...owners.entries()]
      .filter(([, who]) => who.size > 1)
      .map(([key, who]) => `${key} → ${[...who].sort().join(' vs ')}`);

    expect(
      collisions,
      `two blocks claim one route; one of them is dead code:\n${collisions.join('\n')}`,
    ).toEqual([]);
  });

  it('filesystem access is owned by exactly one block (host_os)', () => {
    // The ownership decision from BO-A2d, pinned so it cannot silently revert.
    // host_os is the block whose declared purpose is host access and which
    // enforces ALLOWED_ROOTS. The files block's duplicate pair were Vercel
    // proxies with wildcard CORS on a write route, mounted unconditionally in
    // local dev, with zero callers — their only documented consumer
    // (DataNotes.jsx) had already been deleted.
    const filesFs = path.join(ROOT, 'src', 'blocks', 'files', 'api', 'fs');
    expect(
      fs.existsSync(filesFs),
      'src/blocks/files/api/fs/ was removed in BO-A2d; host_os owns /api/fs/*',
    ).toBe(false);

    const hostOs = fs.readFileSync(
      path.join(ROOT, 'src', 'blocks', 'host_os', 'api', 'fs.cjs'), 'utf8');
    expect(hostOs).toMatch(/router\.post\('\/fs\/read'/);
    expect(hostOs).toMatch(/router\.post\('\/fs\/write'/);
  });

  it('the kernel audit route no longer shadows host_os /system/scan', () => {
    const core = fs.readFileSync(path.join(ROOT, 'src', 'kernel', 'routers', 'core.cjs'), 'utf8');
    const hostOs = fs.readFileSync(
      path.join(ROOT, 'src', 'blocks', 'host_os', 'api', 'system.cjs'), 'utf8');
    expect(hostOs).toMatch(/router\.post\('\/system\/scan'/);
    expect(core).not.toMatch(/router\.post\('\/scan'/);
    expect(core).toMatch(/router\.post\('\/audit'/);
  });
});
