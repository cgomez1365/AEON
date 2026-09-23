/**
 * The cartridge lint and the install gate judge a block by the same rules.
 *
 * Measured 2026-09-23 (removability run):
 *   - `aeon lint` failed ALL 17 shipped blocks on `storage.access`. They use
 *     the grandfathered 'compatibility' mode, which validateManifest accepts
 *     only for something already live — and lintBlock never said it was.
 *   - 14 were also flagged HIGH path-traversal, partly for ESM imports of the
 *     kernel: `import { login } from '../../kernel/auth'`. The kernel is the
 *     sanctioned block API; the exemption only recognised require().
 *   - The same block scored LOW in `aeon lint` and HIGH in the install gate,
 *     because the gate scanned README.md ("touches .env or secrets/" in prose).
 *     Documentation is not executed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { lintBlock, scanSources } = require('../src/kernel/staging.cjs');
const gate = require('../src/kernel/complexityGate.cjs');

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-lint-')); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const block = (id, manifestExtra = {}, files = {}) => {
  const dir = path.join(tmp, id);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    id, name: id, version: '1.0.0', manifestVersion: '1.1.0', route: `/${id}`, tier: 'core',
    contract: {
      permissions: { filesystem: 'write', network: 'none', ai: false, shell: false, secrets: false },
      storage: { access: 'compatibility', local: { indexed: false, retention: 'operational' } },
      memory: { mode: 'none' },
    },
    ...manifestExtra,
  };
  fs.writeFileSync(path.join(dir, 'block.manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'index.jsx'), files['index.jsx'] || 'export default () => null;\n');
  for (const [f, c] of Object.entries(files)) if (f !== 'index.jsx') {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  return dir;
};
const scopedErr = (r) => r.errors.some((e) => /storage\.access=scoped/.test(e));

describe('a live block is linted as live', () => {
  it('grandfathered storage passes when the block is existing, and still fails for a new one', () => {
    const dir = block('legacy_block');
    expect(scopedErr(lintBlock(dir))).toBe(true);
    expect(scopedErr(lintBlock(dir, { existing: true }))).toBe(false);
  });
});

describe('importing the kernel is the block API, in either module syntax', () => {
  const traversal = (src) => scanSources([{ path: 'index.jsx', content: src }]).filter((f) => f.check === 'path-traversal');
  it('ESM imports of kernel modules are not traversal', () => {
    expect(traversal("import { login } from '../../kernel/auth';\n")).toEqual([]);
    expect(traversal("const m = await import('../../kernel/contexts/AeonContext');\n")).toEqual([]);
  });
  it('the require form still passes, and a real escape is still caught', () => {
    expect(traversal("const p = require('../../../kernel/pacing.cjs');\n")).toEqual([]);
    expect(traversal("import x from '../../../../etc/passwd';\n").length).toBe(1);
    expect(traversal("const p = path.join(__dirname, '..', '..', '..', 'secrets');\n").length).toBe(1);
  });
});

describe('the install gate reads code, not prose', () => {
  const envelope = (files) => ({
    source: 'store', trust: 'first-party',
    manifest: { id: 'doc_block', contract: { permissions: { filesystem: 'none', network: 'none', shell: false, secrets: false } } },
    files,
  });
  it('a README that mentions .env does not make the block HIGH', () => {
    const r = gate.gate(envelope([
      // resume_grader's real README line — the one that sent it to the approval queue.
      { path: 'README.md', content: '- **Local/dev** (`process.env.VERCEL` unset): source of truth is the local file.' },
      { path: 'index.jsx', content: 'export default () => null;\n' },
    ]));
    expect(r.reasons.filter((x) => /README/.test(x.why))).toEqual([]);
  });
  it('code that reads .env still does', () => {
    const r = gate.gate(envelope([
      { path: 'api/x.cjs', content: "const k = require('fs').readFileSync('.env');\n" },
    ]));
    expect(r.reasons.some((x) => x.rule === 'secret-file-read')).toBe(true);
  });
});
