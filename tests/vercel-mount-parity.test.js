// Cloud must mount the same way local does, and api/index.js must not drift.
//
// Two separate defects, one seam:
//
// 1. The Vercel path passed a hardcoded 13-key dependency object to every block
//    and never called createScopedDeps. Manifest permissions — the Bible's
//    "executable governance" — were a LOCAL-ONLY guarantee. Blocks expecting a
//    dep outside those 13 got undefined: dashboard/chat destructured
//    getDailyCost, called it on every AI message, threw, and answered HTTP 500.
//    The primary chat feature was broken in production.
//
// 2. api/index.js is generated, but nothing ran the generator. Its own header
//    claimed it was "wired into vercel-build in package.json" — there was no
//    such script. It was correct only when someone remembered. That is exactly
//    how the 2026-07-29 drift happened (five deleted files still mounted, one
//    live file missing) and nothing caught it.
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const GENERATED = path.join(ROOT, 'api', 'index.js');

describe('api/index.js is generated and current', () => {
  it('regenerating produces no diff against the committed file', () => {
    const committed = fs.readFileSync(GENERATED, 'utf8');

    // Generate into a scratch copy so the test never mutates the repo.
    const backup = path.join(os.tmpdir(), `aeon-mounts-${process.pid}.bak`);
    fs.writeFileSync(backup, committed, 'utf8');
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'gen-vercel-mounts.cjs')], {
        cwd: ROOT, stdio: 'pipe',
      });
      const fresh = fs.readFileSync(GENERATED, 'utf8');
      expect(
        fresh,
        'api/index.js is stale — run `npm run prep:mounts` and commit the result',
      ).toBe(committed);
    } finally {
      fs.writeFileSync(GENERATED, committed, 'utf8');
      fs.unlinkSync(backup);
    }
  });

  it('the build regenerates it, so it cannot silently go stale', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.build).toMatch(/gen-vercel-mounts/);
  });

  it('every mounted file exists on disk', () => {
    const src = fs.readFileSync(GENERATED, 'utf8');
    const missing = [];
    for (const m of src.matchAll(/file:\s*'([^']+)'/g)) {
      const full = path.resolve(path.join(ROOT, 'api'), m[1]);
      if (!fs.existsSync(full)) missing.push(m[1]);
    }
    expect(missing, `mounted but absent: ${missing.join(', ')}`).toEqual([]);
  });

  it('every cloud-targeted block API file is mounted', () => {
    const src = fs.readFileSync(GENERATED, 'utf8');
    const mounted = new Set(
      [...src.matchAll(/file:\s*'([^']+)'/g)]
        .map(m => path.resolve(path.join(ROOT, 'api'), m[1])));

    const blocksDir = path.join(ROOT, 'src', 'blocks');
    const missing = [];
    for (const folder of fs.readdirSync(blocksDir)) {
      if (folder.startsWith('_')) continue;
      const manifestPath = path.join(blocksDir, folder, 'block.manifest.json');
      if (!fs.existsSync(manifestPath)) continue;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      // A block may legitimately opt out of cloud.
      if (manifest?.contract?.targets?.vercel === false) continue;

      const apiDir = path.join(blocksDir, folder, 'api');
      if (!fs.existsSync(apiDir)) continue;

      const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.name.startsWith('_')) continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else if (/\.(js|cjs)$/.test(e.name) && !mounted.has(full)) {
            missing.push(path.relative(ROOT, full));
          }
        }
      };
      walk(apiDir);
    }
    expect(missing, `exists but never mounted in cloud: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('cloud scopes dependencies through the same contract as local', () => {
  const loader = fs.readFileSync(path.join(ROOT, 'server', 'block-loader.js'), 'utf8');

  it('the Vercel branch calls createScopedDeps', () => {
    const branch = /if \(isVercel && typeof global\.mountStaticBlocks[\s\S]*?\n  \} else \{/.exec(loader);
    expect(branch, 'Vercel mount branch not found').toBeTruthy();
    expect(
      branch[0],
      'cloud mounts must scope deps per manifest, as local does',
    ).toMatch(/createScopedDeps/);
  });

  it('the Vercel branch no longer passes a hardcoded dependency subset', () => {
    const branch = /if \(isVercel && typeof global\.mountStaticBlocks[\s\S]*?\n  \} else \{/.exec(loader)[0];
    // The old shape enumerated a fixed list of baseDeps keys inline.
    const inlineKeys = (branch.match(/baseDeps\.\w+/g) || []).length;
    expect(inlineKeys, 'cloud deps are being hand-enumerated again').toBeLessThan(3);
  });

  it('the mounter accepts a per-block deps resolver', () => {
    const generated = fs.readFileSync(GENERATED, 'utf8');
    expect(generated).toMatch(/function\(app, deps, depsFor\)/);
    expect(generated).toMatch(/resolve\(m\.block\)/);
  });
});
