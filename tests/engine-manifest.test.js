/**
 * contract.engine, end to end through the pieces that read a manifest:
 *
 *  - blockStandard.normalizeManifest must CARRY it. normalizeManifest rebuilds
 *    `contract` from a whitelist and the boot sync writes the result back over
 *    the manifest, so a field it does not name is silently erased. That is
 *    exactly how Voice Studio's declaration vanished (2026-10-04) and the block
 *    was handed no deps.engineInstall — caught by the end-to-end install run,
 *    not by any unit test, hence this one.
 *  - the complexity gate must never let an engine auto-build: it installs
 *    third-party npm code the scanner cannot read.
 *  - validateEngine refuses anything but plain registry names at exact versions.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-engine-manifest-'));
process.env.AEON_BLOCKS_DIR = path.join(T, 'blocks');           // before the kernel modules read it

const require = createRequire(import.meta.url);
const blockStandard = require('../src/kernel/blockStandard.cjs');
const { gate } = require('../src/kernel/complexityGate.cjs');
const { validateEngine } = require('../src/kernel/engineInstall.cjs');

afterAll(() => { fs.rmSync(T, { recursive: true, force: true }); });

const ENGINE = { dir: 'engine', packages: { 'kokoro-js': '1.2.1', '@scope/pkg-a': '2.0.0-beta.1' }, approxBytes: 1000, worker: 'api/_worker.cjs' };

const manifest = (engine) => ({
  manifestVersion: '1.1.0', id: 'zz_engine_probe', label: 'Engine Probe', route: '/zz_engine_probe', version: '1.0.0',
  description: 'probe', category: 'tools', tier: 'plugin',
  contract: {
    permissions: { filesystem: 'write', network: 'external', secrets: false, shell: false, ai: false },
    storage: { type: 'json', scope: 'block', access: 'scoped', local: { indexed: false, retention: 'operational' } },
    memory: { mode: 'none', indexed: false },
    ...(engine ? { engine } : {}),
  },
});
const writeBlock = (id, m) => {
  const dir = path.join(T, 'blocks', id);
  fs.mkdirSync(path.join(dir, 'api'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'block.manifest.json'), JSON.stringify(m));
  fs.writeFileSync(path.join(dir, 'index.jsx'), 'export default () => null;\n');
};

describe('blockStandard keeps contract.engine through normalisation', () => {
  it('carries a declared engine', () => {
    writeBlock('zz_engine_probe', manifest(ENGINE));
    const n = blockStandard.normalizeManifest('zz_engine_probe');
    expect(n.contract.engine).toEqual(ENGINE);
  });
  it('adds nothing to a block that declares none', () => {
    writeBlock('zz_plain_probe', { ...manifest(null), id: 'zz_plain_probe', route: '/zz_plain_probe' });
    const n = blockStandard.normalizeManifest('zz_plain_probe');
    expect('engine' in n.contract).toBe(false);
  });
});

describe('the complexity gate never auto-builds an engine', () => {
  const env = (engine) => ({ manifest: manifest(engine), files: [{ path: 'index.jsx', content: 'export default () => null;\n' }], trust: 'store' });

  it('a plain block is still LOW', () => {
    expect(gate(env(null)).score).toBe('LOW');
  });
  it('a valid engine is MEDIUM (one click), and the reason lists every package at its version', () => {
    const v = gate(env(ENGINE));
    expect(v.score).toBe('MEDIUM');
    expect(v.behavior).toBe('single-click');
    const why = v.reasons.find((r) => r.rule === 'engine').why;
    expect(why).toContain('kokoro-js@1.2.1');
    expect(why).toContain('@scope/pkg-a@2.0.0-beta.1');
    expect(why).toContain('api/_worker.cjs');
  });
  it('a sneaky engine is HIGH, not merely MEDIUM', () => {
    for (const packages of [{ evil: '^1.0.0' }, { evil: 'latest' }, { evil: 'github:someone/evil' }, { evil: 'https://example.com/x.tgz' }, { evil: 'file:../../x' }, { 'Bad Name': '1.0.0' }]) {
      const v = gate(env({ ...ENGINE, packages }));
      expect(v.score, JSON.stringify(packages)).toBe('HIGH');
    }
  });
});

describe('validateEngine', () => {
  it('accepts a normal declaration', () => { expect(validateEngine(ENGINE)).toEqual([]); });
  it('requires at least one package, and caps the count', () => {
    expect(validateEngine({ ...ENGINE, packages: {} }).join()).toMatch(/at least one/);
    const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`pkg-${i}`, '1.0.0']));
    expect(validateEngine({ ...ENGINE, packages: many }).join()).toMatch(/limit 16/);
  });
  it('refuses ranges, tags, URLs, git and file specifiers; only exact versions pass', () => {
    for (const bad of ['^1.0.0', '~1.0.0', '1.x', '>=1.0.0', 'latest', 'github:a/b', 'git+https://x/y.git', 'file:../x', 'https://x/y.tgz', '1.0', '']) {
      expect(validateEngine({ ...ENGINE, packages: { 'pkg-a': bad } }).length, bad).toBeGreaterThan(0);
    }
    for (const good of ['1.0.0', '10.20.30', '1.0.0-beta.1']) expect(validateEngine({ ...ENGINE, packages: { 'pkg-a': good } })).toEqual([]);
  });
  it('refuses odd folder names and a worker outside the block', () => {
    expect(validateEngine({ ...ENGINE, dir: '../x' }).length).toBeGreaterThan(0);
    expect(validateEngine({ ...ENGINE, worker: '../../evil.cjs' }).length).toBeGreaterThan(0);
    expect(validateEngine({ ...ENGINE, worker: '/etc/passwd' }).length).toBeGreaterThan(0);
    expect(validateEngine({ ...ENGINE, worker: 'api/' }).length).toBeGreaterThan(0);
    expect(validateEngine(null).length).toBeGreaterThan(0);
  });
});
