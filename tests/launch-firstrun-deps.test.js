/**
 * A098 — an interrupted first install was treated as ready forever.
 *
 * launch.js ran `npm install` only when node_modules did not exist. Measured
 * 2026-09-30 on a GitHub-style zip: a cold first run stalled mid-download with
 * node_modules holding 574 entries and no node_modules/.package-lock.json.
 * Every relaunch then printed "[OK] Dependencies ready." and failed in the
 * build ("Cannot find module 'multer'"), while the failure text said to run
 * LAUNCH again — which skipped the install that had failed.
 *
 * npm writes node_modules/.package-lock.json only after the whole tree is on
 * disk and its install scripts have run, so it marks a finished install; the
 * launcher also writes its own marker after npm exits 0.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const launcher = require(path.join(ROOT, 'launch.js'));

const dirs = [];
const app = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-deps-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

// node_modules the way a cut-off install leaves it: packages, no marker.
function halfInstalled(root) {
  for (const name of ['express', 'react', 'vite']) {
    fs.mkdirSync(path.join(root, 'node_modules', name), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name }));
  }
}

describe('dependenciesReady', () => {
  it('no node_modules: a first run', () => {
    expect(launcher.dependenciesReady(app())).toEqual({ ready: false, reason: 'missing' });
  });

  it('packages but no completion marker: the install did not finish', () => {
    const root = app();
    halfInstalled(root);
    expect(launcher.dependenciesReady(root)).toEqual({ ready: false, reason: 'incomplete' });
  });

  it('npm\'s hidden lockfile marks a finished install', () => {
    const root = app();
    halfInstalled(root);
    fs.writeFileSync(path.join(root, 'node_modules', '.package-lock.json'), '{}');
    expect(launcher.dependenciesReady(root)).toEqual({ ready: true, reason: null });
  });

  it('so does the launcher\'s own marker, written after npm succeeds', () => {
    const root = app();
    halfInstalled(root);
    expect(launcher.markDependenciesInstalled(root)).toBe(true);
    expect(fs.existsSync(path.join(root, 'node_modules', launcher.INSTALL_MARKER))).toBe(true);
    expect(launcher.dependenciesReady(root)).toEqual({ ready: true, reason: null });
  });
});

describe('the launcher acts on it', () => {
  const src = fs.readFileSync(path.join(ROOT, 'launch.js'), 'utf8');

  it('asks dependenciesReady, not whether the folder exists', () => {
    expect(src).toMatch(/const deps = dependenciesReady\(ROOT\);/);
    expect(src).not.toMatch(/if \(!fs\.existsSync\(path\.join\(ROOT, 'node_modules'\)\)\)/);
  });

  it('reinstalls a half-finished tree from the lockfile and records success', () => {
    expect(src).toMatch(/deps\.reason === 'incomplete'[\s\S]{0,400}npm ci --prefer-offline/);
    expect(src).toMatch(/markDependenciesInstalled\(ROOT\);\s*\}\s*ok\('Dependencies ready\.'\);/);
  });
});
