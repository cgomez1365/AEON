/**
 * The pipeline's check (validateBuild), the staged lint and the install gate
 * judge the same files: code, not prose.
 *
 * Found 2026-09-23 by the store update flow's live test: inventory 1.0.0's
 * README tells the operator to add AEON_STORE to ~/AEON/.env. validateBuild
 * scanned every file, matched the .env rule in the README, and scored the pack
 * HIGH — while the real install (lint + gate scan code only since e79be34)
 * scored the same cartridge LOW and installed it. The update, which asks
 * validateBuild whether a pack will go live on its own, refused it.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = require('path').dirname(fileURLToPath(import.meta.url));
const { createBuildPipeline } = require('../src/kernel/buildPipeline.cjs');
const { isCodeFile } = require('../src/kernel/staging.cjs');
const { gate } = require('../src/kernel/complexityGate.cjs');

const ID = 'zz_prose_probe';
// The shipped scaffold's manifest, renamed — valid by construction.
const fs = require('fs');
const path = require('path');
const manifest = {
  ...JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'blocks', '_template', 'block.manifest.json'), 'utf8')),
  id: ID, name: ID, label: 'Prose Probe', route: `/${ID}`, api_routes: false,
};
const files = [
  { path: 'index.jsx', content: 'export default () => null;\n' },
  // inventory 1.0.0's README, verbatim in shape: Markdown code spans are backticks.
  { path: 'README.md', content: 'Point AEON at the store (`AEON_STORE=…` in AEON\'s `.env`, then restart AEON).\n' },
];

describe('code, not prose', () => {
  it('isCodeFile is the one rule', () => {
    expect(['a.js', 'a.cjs', 'a.mjs', 'a.jsx', 'a.ts', 'a.tsx'].every(isCodeFile)).toBe(true);
    expect(['README.md', 'block.manifest.json', 'notes.txt'].some(isCodeFile)).toBe(false);
  });

  it('a README that mentions .env does not make the check HIGH', async () => {
    const p = createBuildPipeline({ approvals: { enqueue() {} }, rescan() {}, getLiveRoutes: () => [] });
    const r = await p.validateBuild('store', { manifest, files });
    expect(r.findings.filter((f) => f.file === 'README.md')).toEqual([]);
    expect(r.score).toBe('LOW');
  });

  it('the install gate agrees', () => {
    expect(gate({ manifest, files, source: 'store', trust: 'untrusted' }).score).toBe('LOW');
  });

  it('the same line in code is still caught', async () => {
    const p = createBuildPipeline({ approvals: { enqueue() {} }, rescan() {}, getLiveRoutes: () => [] });
    const r = await p.validateBuild('store', { manifest, files: [...files, { path: 'api/x.cjs', content: "require('fs').readFileSync(require('os').homedir() + '/AEON/.env');\n" }] });
    expect(r.findings.some((f) => f.file === 'api/x.cjs')).toBe(true);
  });
});
