/**
 * Kernel engine primitive (BO-TIER15): a block declares an on-demand engine in
 * its manifest (contract.engine) and the KERNEL installs its npm packages and
 * starts its worker, so the block never needs child_process (stays out of Tier 3).
 *
 * Covered here with real processes, no network: a stub npm-cli.js stands in for
 * npm (AEON_NPM_CLI), and a tiny worker proves the fork round-trip, the
 * minimal-environment rule (no provider keys reach a block's worker) and the
 * refusal of anything outside the manifest's declaration.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { forBlock, findNpm } = require('../src/kernel/engineInstall.cjs');

let T; let blockDir; let dataRoot; let savedEnv;

const engine = (extra = {}) => ({ dir: 'engine', packages: { 'zz-pkg-a': '1.0.0', 'zz-pkg-b': '2.0.0' }, approxBytes: 1000, worker: 'api/_worker.cjs', ...extra });
const make = (declared = engine()) => forBlock({
  blockId: 'zz_engine_probe',
  declaredEngine: declared,
  getBlockDataFile: (id) => path.join(dataRoot, id),
  blockDir,
});

beforeEach(() => {
  T = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-engine-install-'));
  blockDir = path.join(T, 'blocks', 'zz_engine_probe');
  dataRoot = path.join(T, 'data');
  fs.mkdirSync(path.join(blockDir, 'api'), { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  savedEnv = { npm: process.env.AEON_NPM_CLI, secret: process.env.AEON_TEST_PROVIDER_KEY };
});
afterEach(() => {
  for (const [k, v] of [['AEON_NPM_CLI', savedEnv.npm], ['AEON_TEST_PROVIDER_KEY', savedEnv.secret]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  fs.rmSync(T, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('findNpm', () => {
  it('prefers AEON_NPM_CLI, run through the same node that runs AEON', () => {
    const cli = path.join(T, 'npm-cli.js');
    fs.writeFileSync(cli, '');
    const r = findNpm({ env: { AEON_NPM_CLI: cli }, execPath: '/opt/node/bin/node', exists: (p) => p === cli });
    expect(r).toEqual({ command: '/opt/node/bin/node', args: [cli], via: cli });
  });
  it('falls back to npm on PATH, but never on Windows (npm.cmd would need a shell)', () => {
    expect(findNpm({ env: {}, execPath: '/x/node', exists: () => false, platform: 'linux' }).via).toBe('npm on PATH');
    expect(findNpm({ env: {}, execPath: 'C:\\node\\node.exe', exists: () => false, platform: 'win32' })).toBeNull();
  });
});

describe('installed()', () => {
  it('is true only when every declared package is present in the engine folder', () => {
    const e = make();
    expect(e.installed()).toBe(false);
    fs.mkdirSync(path.join(e.dir(), 'node_modules', 'zz-pkg-a'), { recursive: true });
    fs.writeFileSync(path.join(e.dir(), 'node_modules', 'zz-pkg-a', 'package.json'), '{}');
    expect(e.installed()).toBe(false);
    fs.mkdirSync(path.join(e.dir(), 'node_modules', 'zz-pkg-b'), { recursive: true });
    fs.writeFileSync(path.join(e.dir(), 'node_modules', 'zz-pkg-b', 'package.json'), '{}');
    expect(e.installed()).toBe(true);
  });
  it('an engine that declares no packages is refused outright', () => {
    expect(() => make(engine({ packages: {} }))).toThrow(/at least one package/);
  });
});

describe('install()', () => {
  // A stand-in for npm-cli.js: reads the dependencies from the package.json in
  // its cwd and "installs" each one. Records its argv so the flags can be checked.
  const stubNpm = () => {
    const cli = path.join(T, 'npm-cli.js');
    fs.writeFileSync(cli, `
      const fs = require('fs'); const path = require('path');
      const deps = Object.keys(JSON.parse(fs.readFileSync('package.json', 'utf8')).dependencies || {});
      fs.writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));
      for (const d of deps) { fs.mkdirSync(path.join('node_modules', d), { recursive: true }); fs.writeFileSync(path.join('node_modules', d, 'package.json'), '{}'); }
    `);
    process.env.AEON_NPM_CLI = cli;
  };

  it('installs exactly the manifest-declared packages, with scripts off, inside the block data dir', async () => {
    stubNpm();
    const e = make();
    const r = await e.install();
    expect(r.ok).toBe(true);
    expect(e.installed()).toBe(true);
    expect(e.dir().startsWith(path.join(dataRoot, 'zz_engine_probe'))).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(path.join(e.dir(), 'package.json'), 'utf8'));
    expect(pkg.dependencies).toEqual({ 'zz-pkg-a': '1.0.0', 'zz-pkg-b': '2.0.0' });
    const argv = JSON.parse(fs.readFileSync(path.join(e.dir(), 'argv.json'), 'utf8'));
    expect(argv).toContain('--ignore-scripts');
    expect(argv).toContain('--omit=dev');
  });

  it('says so when npm finishes but a declared package is missing', async () => {
    const cli = path.join(T, 'npm-cli.js');
    fs.writeFileSync(cli, '/* installs nothing */');
    process.env.AEON_NPM_CLI = cli;
    await expect(make().install()).rejects.toThrow(/not present/);
  });

  it('reports npm failing, with its last words', async () => {
    const cli = path.join(T, 'npm-cli.js');
    fs.writeFileSync(cli, "console.error('E404 not found'); process.exit(1);");
    process.env.AEON_NPM_CLI = cli;
    await expect(make().install()).rejects.toThrow(/exit 1.*E404/);
  });
});

describe('fork() — the block never touches child_process', () => {
  const worker = (src) => fs.writeFileSync(path.join(blockDir, 'api', '_worker.cjs'), src);

  it('starts the declared worker and talks to it over IPC', async () => {
    worker("process.on('message', (m) => process.send({ echo: m.n * 2, cwd: process.cwd() }));");
    const e = make();
    fs.mkdirSync(e.dir(), { recursive: true });
    const child = e.fork();
    const reply = await new Promise((resolve, reject) => {
      child.once('message', resolve); child.once('error', reject);
      child.send({ n: 21 });
    });
    child.kill();
    expect(reply.echo).toBe(42);
    expect(fs.realpathSync(reply.cwd)).toBe(fs.realpathSync(e.dir()));
  });

  it('gives the worker a minimal environment: no provider keys', async () => {
    process.env.AEON_TEST_PROVIDER_KEY = 'sk-should-not-leak';
    worker("process.send({ secret: process.env.AEON_TEST_PROVIDER_KEY || null, hasPath: !!process.env.PATH });");
    const e = make();
    fs.mkdirSync(e.dir(), { recursive: true });
    const child = e.fork();
    const reply = await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });
    // Wait for the worker to exit before the afterEach removes its folder: on
    // Windows an exiting process still holds its cwd and the delete fails (EPERM).
    await new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
    expect(reply.secret).toBeNull();
    expect(reply.hasPath).toBe(true);
  });

  it('refuses when no worker is declared, when it escapes the block folder, or when it is missing', () => {
    expect(() => make(engine({ worker: undefined })).fork()).toThrow(/declares no engine worker/);
    // a traversal path is now refused already when the engine is bound (validateEngine);
    // fork() keeps its own inside-the-block check as a second layer
    expect(() => make(engine({ worker: '../../outside.cjs' }))).toThrow(/not allowed.*inside the block/);
    expect(() => make(engine({ worker: 'api/nope.cjs' })).fork()).toThrow(/missing/);
  });
});

describe('forBlock enforces the declaration rules itself (defense in depth)', () => {
  it('refuses to bind an engine the gate would have refused', () => {
    expect(() => make(engine({ packages: { evil: '^1.0.0' } }))).toThrow(/not allowed.*exact version/);
    expect(() => make(engine({ packages: { evil: 'github:someone/evil' } }))).toThrow(/not allowed/);
    expect(() => make(engine({ worker: '../../outside.cjs' }))).toThrow(/not allowed/);
  });
});
