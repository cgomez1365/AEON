/**
 * BO-A3a — Vercel stages 1 and 2.
 *
 * Stage 3 (deleting the branches) is deliberately NOT in this build order: a
 * large diff across many files, days before a release, to remove code that is
 * currently inert. What stages 1 and 2 buy is that stage 3 becomes an afternoon
 * rather than a gamble.
 *
 *   Stage 1 — the collision gate no longer depends on the deploy artifact.
 *   Stage 2 — every runtime read goes through one shim, and the surface is
 *             counted by a scanner that only lets the number fall.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const runtime = require('../src/kernel/runtime.cjs');

describe('stage 2 — the runtime shim', () => {
  it('isCloud() is exactly the environment check it replaced — no behaviour change', () => {
    const saved = process.env.VERCEL;
    try {
      process.env.VERCEL = '1';
      expect(runtime.isCloud()).toBe(true);
      expect(runtime.isLocal()).toBe(false);
      expect(runtime.runtimeName()).toBe('cloud');

      delete process.env.VERCEL;
      expect(runtime.isCloud()).toBe(false);
      expect(runtime.isLocal()).toBe(true);
      expect(runtime.runtimeName()).toBe('local');
    } finally {
      if (saved === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = saved;
    }
  });

  it('does not snapshot at require-time — the value must stay live', () => {
    // A module-level constant would freeze whichever value happened to be set
    // when the shim first loaded, and every test that toggles VERCEL would
    // silently exercise one branch forever.
    const saved = process.env.VERCEL;
    try {
      delete process.env.VERCEL;
      const before = runtime.isCloud();
      process.env.VERCEL = '1';
      expect(runtime.isCloud()).not.toBe(before);
    } finally {
      if (saved === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = saved;
    }
  });
});

describe('stage 2 — the ratchet', () => {
  it('production code reads the environment ONLY through the shim', () => {
    const out = execFileSync(
      process.execPath, [path.join(ROOT, 'scripts', 'scan-cloud-surface.cjs')],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(out).toMatch(/PASS/);
    expect(out).toMatch(/0 raw env reads/);
  });

  it('the baseline exists and the count may only fall', () => {
    const baseline = JSON.parse(fs.readFileSync(
      path.join(ROOT, 'scripts', 'cloud-surface-baseline.json'), 'utf8'));
    expect(baseline.total).toBeGreaterThan(0);
    expect(baseline.envReads).toBe(0);
    // The gate's whole value is that adding a branch fails CI.
    expect(baseline.note).toMatch(/never rise/i);
  });

  it('the ratchet is wired into the release gate, not merely available', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['scan:cloud-surface']).toBeTruthy();
    expect(pkg.scripts['scan:release-gate']).toMatch(/scan:cloud-surface/);
  });
});

describe('stage 1 — collision detection is independent of the deploy artifact', () => {
  it('the collision gate reads manifests, not api/index.js', () => {
    // api/index.js generation was ALSO what caught two blocks claiming one
    // route. That coupling is why deleting Vercel felt risky: it would have
    // taken a real gate with it. The gate now reads the generated manifests,
    // which exist regardless of whether AEON ever deploys to a cloud again.
    const gate = fs.readFileSync(path.join(ROOT, 'tests', 'route-collisions.test.js'), 'utf8');
    expect(gate).toMatch(/block\.manifest\.json/);
    expect(gate).not.toMatch(/api\/index\.js/);
  });

  it('the manifest route table is non-trivial, so the gate has something to check', () => {
    const blocksDir = path.join(ROOT, 'src', 'blocks');
    let routes = 0;
    for (const id of fs.readdirSync(blocksDir)) {
      if (id.startsWith('_')) continue;
      const p = path.join(blocksDir, id, 'block.manifest.json');
      if (!fs.existsSync(p)) continue;
      routes += (JSON.parse(fs.readFileSync(p, 'utf8')).routes || []).length;
    }
    expect(routes).toBeGreaterThan(100);
  });
});
