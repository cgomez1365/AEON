/**
 * Master builder — scaffold + dry-run validation.
 *
 * These import the real modules. A test that re-implements scaffolding or
 * validation inline would stay green while the feature was broken, which is
 * the failure this suite has been burned by before.
 *
 * The point of most of these is that the gate can REFUSE. A validator that
 * only ever returns "fine" is the check-that-cannot-fail from 2026-08-01,
 * rebuilt with a nicer interface.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { scaffold, labelFromId } = require('../src/kernel/blockScaffold.cjs');
const { createBuildPipeline } = require('../src/kernel/buildPipeline.cjs');
const { validateManifest } = require('../src/kernel/staging.cjs');

const pipeline = createBuildPipeline({});
const check = (payload) => pipeline.validateBuild('local', payload);

describe('scaffold', () => {
  it('derives folder/id/route from one id so they cannot drift', () => {
    const { ok, payload } = scaffold({ id: 'my_block' });
    expect(ok).toBe(true);
    expect(payload.manifest.id).toBe('my_block');
    expect(payload.manifest.route).toBe('/my_block');
    expect(payload.manifest.label).toBe('My Block');
    expect(labelFromId('my_block')).toBe('My Block');
  });

  it('refuses an invalid id and states the rule instead of "invalid"', () => {
    const r = scaffold({ id: 'My-Block' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/lowercase letters, digits and underscores/);
  });

  it('starts permissions at the floor and never scaffolds shell', () => {
    const { payload } = scaffold({ id: 'floor_block' });
    const p = payload.manifest.contract.permissions;
    expect(p).toMatchObject({ filesystem: 'none', network: 'internal', secrets: false, shell: false, ai: false });
  });

  it('emits access=scoped — the value new v1.1 blocks require', () => {
    const { payload } = scaffold({ id: 'scoped_block' });
    expect(payload.manifest.contract.storage.access).toBe('scoped');
  });

  it('derives filesystem=write from storage, rather than trusting the caller', () => {
    const { payload } = scaffold({ id: 'store_block', storage: 'json' });
    expect(payload.manifest.contract.permissions.filesystem).toBe('write');
    expect(validateManifest(payload.manifest)).toEqual([]);
  });

  it('derives filesystem=write from memory too', () => {
    const { payload } = scaffold({ id: 'mem_block', memory: 'document' });
    expect(payload.manifest.contract.permissions.filesystem).toBe('write');
    expect(payload.manifest.contract.memory.indexed).toBe(true);
    expect(validateManifest(payload.manifest)).toEqual([]);
  });

  it('only emits a widget when there is an api to serve it', () => {
    const withApi = scaffold({ id: 'w_yes', api: true, widget: true }).payload;
    const noApi = scaffold({ id: 'w_no', api: false, widget: true }).payload;
    expect(withApi.manifest.widget?.endpoint).toBe('/api/w_yes/widget');
    expect(noApi.manifest.widget).toBeUndefined();
  });

  it('produces a manifest the real validator accepts', () => {
    for (const opts of [
      { id: 'a_block' },
      { id: 'b_block', api: true, widget: true },
      { id: 'c_block', storage: 'json', memory: 'summary', ai: true },
    ]) {
      expect(validateManifest(scaffold(opts).payload.manifest)).toEqual([]);
    }
  });
});

describe('validateBuild — every gate, no disk', () => {
  it('passes a clean scaffold and writes nothing', async () => {
    const { payload } = scaffold({ id: 'clean_block', api: true, widget: true });
    const before = fs.existsSync(path.join(__dirname, '..', 'staging', 'clean_block'));
    const r = await check(payload);
    expect(r.ok).toBe(true);
    expect(r.wouldPass).toBe(true);
    expect(r.errors).toEqual([]);
    expect(fs.existsSync(path.join(__dirname, '..', 'staging', 'clean_block'))).toBe(before);
  });

  it('refuses a child_process require', async () => {
    const { payload } = scaffold({ id: 'shell_block', api: true });
    payload.files.push({ path: 'x.cjs', content: "const cp = require('child_process');" });
    const r = await check(payload);
    expect(r.wouldPass).toBe(false);
    expect(r.findings.some((f) => f.check === 'child-process' && f.sev === 'HIGH')).toBe(true);
  });

  it('refuses a hardcoded secret', async () => {
    const { payload } = scaffold({ id: 'secret_block', api: true });
    payload.files.push({ path: 'x.cjs', content: 'const api_key = "abcdefghijklmnopqrstuvwxyz0123";' });
    const r = await check(payload);
    expect(r.wouldPass).toBe(false);
    expect(r.findings.some((f) => f.check === 'hardcoded-secret')).toBe(true);
  });

  it('refuses a read of .env or secrets/', async () => {
    const { payload } = scaffold({ id: 'env_block', api: true });
    payload.files.push({ path: 'x.cjs', content: "fs.readFileSync('/secrets/aeon-keyslots.json');" });
    const r = await check(payload);
    expect(r.wouldPass).toBe(false);
    expect(r.findings.some((f) => f.check === 'secret-file-read')).toBe(true);
  });

  it('refuses eval', async () => {
    const { payload } = scaffold({ id: 'eval_block', api: true });
    payload.files.push({ path: 'x.cjs', content: "eval('2+2');" });
    const r = await check(payload);
    expect(r.wouldPass).toBe(false);
    expect(r.findings.some((f) => f.check === 'eval')).toBe(true);
  });

  it('refuses a circular import', async () => {
    const { payload } = scaffold({ id: 'circ_block', api: true });
    payload.files.push({ path: 'a.cjs', content: "require('./b.cjs');" });
    payload.files.push({ path: 'b.cjs', content: "require('./a.cjs');" });
    const r = await check(payload);
    expect(r.findings.some((f) => f.check === 'circular-import')).toBe(true);
    expect(r.wouldPass).toBe(false);
  });

  it('refuses a manifest missing a required field', async () => {
    const { payload } = scaffold({ id: 'noroute_block' });
    delete payload.manifest.route;
    const r = await check(payload);
    expect(r.wouldPass).toBe(false);
    expect(r.errors).toContain('missing required field: route');
  });

  it('reports a collision with a live block before anything is written', async () => {
    const { payload } = scaffold({ id: 'settings' });
    const r = await check(payload);
    expect(r.wouldPass).toBe(false);
    expect(r.collisions.join(' ')).toMatch(/already live/);
  });

  it('catches api_routes declared with no api/ file', async () => {
    const { payload } = scaffold({ id: 'noapi_block', api: true });
    payload.files = payload.files.filter((f) => !f.path.startsWith('api/'));
    const r = await check(payload);
    expect(r.errors).toContain('api_routes is true but no api/ file is present');
  });

  it('names what it could not check rather than implying full coverage', async () => {
    const { payload } = scaffold({ id: 'honest_block' });
    const r = await check(payload);
    expect(r.notChecked).toContain('staged boot');
  });

  it('returns a structured error for a malformed envelope, not a throw', async () => {
    const r = await pipeline.validateBuild('local', { manifest: null, files: [] });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('envelope');
  });
});

describe('one schema', () => {
  it('the stale db/block.schema.json is gone', () => {
    expect(fs.existsSync(path.join(__dirname, '..', 'db', 'block.schema.json'))).toBe(false);
  });

  it('the enforced schema is the one the docs point at', () => {
    expect(fs.existsSync(path.join(__dirname, '..', 'src', 'kernel', 'schema.json'))).toBe(true);
    const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'BLOCK_STANDARD.md'), 'utf8');
    expect(doc).toMatch(/src\/kernel\/schema\.json/);
  });
});
