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

  it('the kernel audit route no longer shadows host_os /system/scan', () => {
    const core = fs.readFileSync(path.join(ROOT, 'src', 'kernel', 'routers', 'core.cjs'), 'utf8');
    const hostOs = fs.readFileSync(
      path.join(ROOT, 'src', 'blocks', 'host_os', 'api', 'system.cjs'), 'utf8');
    expect(hostOs).toMatch(/router\.post\('\/system\/scan'/);
    expect(core).not.toMatch(/router\.post\('\/scan'/);
    expect(core).toMatch(/router\.post\('\/audit'/);
  });
});
