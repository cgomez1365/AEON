/**
 * Master M3 — the staged boot proof.
 *
 * These run the REAL block host against the REAL staging directory, because
 * that is the whole point: every gate before this one reads a document or
 * scans text, and the thing being asserted here is that the block executes.
 *
 * Most of these assert the gate can REFUSE. The first version of it passed a
 * block whose api threw at require time — the routes 404'd, and a rule that
 * treated every 4xx as "booted and enforcing" read that as success. A gate
 * that cannot fail is the defect this codebase has paid for repeatedly.
 *
 * Staging lives inside the repo on purpose (src/kernel/staging.cjs), so a
 * staged block resolves node_modules the way a promoted one will.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { scaffold } = require('../src/kernel/blockScaffold.cjs');
const { bootProof, declaredRoutes } = require('../src/kernel/bootProof.cjs');
const { STAGING_DIR, ensureStagingDir } = require('../src/kernel/staging.cjs');

const ID = 'bootproof_fixture';
const dir = () => path.join(STAGING_DIR, ID);

function stage(payload) {
  const d = dir();
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'block.manifest.json'), JSON.stringify(payload.manifest, null, 2));
  for (const f of payload.files) {
    const p = path.join(d, f.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.content);
  }
}

const withRoutes = (payload, routes) => {
  payload.manifest.routes = routes;
  return payload;
};

beforeEach(() => { ensureStagingDir(); });
afterEach(() => { fs.rmSync(dir(), { recursive: true, force: true }); });

describe('declaredRoutes', () => {
  it('includes the widget endpoint even when routes omit it', () => {
    const r = declaredRoutes({ routes: [], widget: { endpoint: '/api/x/widget' } });
    expect(r).toEqual([{ method: 'GET', path: '/api/x/widget', wildcard: false, widget: true }]);
  });

  it('marks wildcards, which cannot be called literally', () => {
    const r = declaredRoutes({ routes: [{ method: 'ALL', path: '/api/x/*' }] });
    expect(r[0].wildcard).toBe(true);
  });
});

describe('a block that boots', () => {
  it('passes, mounts, and every declared route answers', async () => {
    stage(withRoutes(scaffold({ id: ID, api: true, widget: true }).payload, [
      { method: 'GET', path: `/api/${ID}/status` },
      { method: 'GET', path: `/api/${ID}/widget` },
    ]));
    const r = await bootProof(STAGING_DIR, ID);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.mounted).toBe(1);
    expect(r.probes.map((p) => p.status)).toEqual([200, 200]);
  });

  it('does not probe wildcards but still reports them', async () => {
    stage(withRoutes(scaffold({ id: ID, api: true }).payload, [
      { method: 'GET', path: `/api/${ID}/status` },
      { method: 'ALL', path: `/api/${ID}/*` },
    ]));
    const r = await bootProof(STAGING_DIR, ID);
    expect(r.probes.find((p) => p.path.endsWith('/*')).skipped).toMatch(/wildcard/);
    expect(r.ok).toBe(true);
  });
});

describe('a block that does not boot is refused', () => {
  it('refuses an api module that throws at require time', async () => {
    const p = scaffold({ id: ID, api: true }).payload;
    p.files = p.files.map((f) => (f.path.startsWith('api/') ? { ...f, content: 'throw new Error("kaboom");' } : f));
    stage(withRoutes(p, [{ method: 'GET', path: `/api/${ID}/status` }]));
    const r = await bootProof(STAGING_DIR, ID);
    expect(r.ok).toBe(false);
    expect(r.mounted).toBe(0);
    expect(r.skipped[0].why).toMatch(/threw during mount/);
  });

  it('treats a 404 on a DECLARED route as a failure, not as enforcement', async () => {
    // The regression that matters: this block mounts fine, but declares a
    // route it does not serve. A rule counting all 4xx as success passes it.
    stage(withRoutes(scaffold({ id: ID, api: true }).payload, [
      { method: 'GET', path: `/api/${ID}/status` },
      { method: 'GET', path: `/api/${ID}/does_not_exist` },
    ]));
    const r = await bootProof(STAGING_DIR, ID);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/declared in the manifest but no route answered/);
  });

  it('refuses a route that throws at request time (5xx)', async () => {
    const p = scaffold({ id: ID, api: true }).payload;
    p.files = p.files.map((f) => (f.path.startsWith('api/')
      ? { ...f, content: `const e=require('express');module.exports=function(d){const r=e.Router();r.get('/${ID}/status',()=>{throw new Error('boom')});return r;};` }
      : f));
    stage(withRoutes(p, [{ method: 'GET', path: `/api/${ID}/status` }]));
    const r = await bootProof(STAGING_DIR, ID);
    expect(r.ok).toBe(false);
    expect(r.probes[0].status).toBe(500);
  });

  it('refuses an invalid manifest without needing to mount anything', async () => {
    const p = scaffold({ id: ID, api: true }).payload;
    delete p.manifest.route;
    stage(withRoutes(p, [{ method: 'GET', path: `/api/${ID}/status` }]));
    const r = await bootProof(STAGING_DIR, ID);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('missing required field: route');
  });

  it('refuses a collision with a live route before promotion', async () => {
    stage(withRoutes(scaffold({ id: ID, api: true }).payload, [
      { method: 'GET', path: `/api/${ID}/status` },
    ]));
    const r = await bootProof(STAGING_DIR, ID, { liveRoutes: [`/api/${ID}/status`] });
    expect(r.ok).toBe(false);
    expect(r.collisions[0]).toMatch(/already served by a live block/);
  });

  it('reports a missing manifest rather than throwing', async () => {
    fs.rmSync(dir(), { recursive: true, force: true });
    fs.mkdirSync(dir(), { recursive: true });
    const r = await bootProof(STAGING_DIR, ID);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('no block.manifest.json');
  });
});

describe('the proof leaves the canonical tree alone', () => {
  it('mounting from staging does not sync or rewrite src/blocks', async () => {
    // createBlockHost.rescan() calls blockStandard.syncAllBlocks(), which
    // writes manifests to its OWN module-level BLOCKS_DIR regardless of the
    // host's blocksDir. Before this was fixed, every boot proof rewrote the
    // canonical tree as a side effect, and parallel proofs raced each other
    // into a torn read — that is how the settings manifest was corrupted on
    // 2026-08-10 (description '', category 'system', permissions downgraded).
    const { execFileSync } = require('child_process');
    const before = execFileSync('git', ['status', '--porcelain', 'src/blocks'], { encoding: 'utf8' });

    stage(withRoutes(scaffold({ id: ID, api: true, widget: true }).payload, [
      { method: 'GET', path: `/api/${ID}/status` },
    ]));
    await bootProof(STAGING_DIR, ID);

    const after = execFileSync('git', ['status', '--porcelain', 'src/blocks'], { encoding: 'utf8' });
    expect(after).toBe(before);
  });
});

describe('the proof does not lie about its own failures', () => {
  it('names an unresolvable staging root as an ENVIRONMENT error, not a block defect', async () => {
    // A staging dir outside the repo cannot resolve node_modules, so every
    // module fails identically. Blaming the block would be a false negative.
    const os = require('os');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-outside-'));
    try {
      const d = path.join(outside, ID);
      fs.mkdirSync(path.join(d, 'api'), { recursive: true });
      const p = scaffold({ id: ID, api: true }).payload;
      fs.writeFileSync(path.join(d, 'block.manifest.json'), JSON.stringify(p.manifest, null, 2));
      for (const f of p.files) {
        const fp = path.join(d, f.path);
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, f.content);
      }
      const r = await bootProof(outside, ID);
      expect(r.ok).toBe(false);
      expect(r.environmentError).toMatch(/cannot resolve node_modules/);
      expect(r.environmentError).toMatch(/was not judged/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('attributes mounts per block, not across the whole staging dir', async () => {
    // A second staged block mounting successfully must not make this one pass.
    const other = path.join(STAGING_DIR, 'bootproof_neighbour');
    try {
      const good = scaffold({ id: 'bootproof_neighbour', api: true }).payload;
      fs.rmSync(other, { recursive: true, force: true });
      fs.mkdirSync(other, { recursive: true });
      fs.writeFileSync(path.join(other, 'block.manifest.json'), JSON.stringify(good.manifest, null, 2));
      for (const f of good.files) {
        const fp = path.join(other, f.path);
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, f.content);
      }

      const bad = scaffold({ id: ID, api: true }).payload;
      bad.files = bad.files.map((f) => (f.path.startsWith('api/') ? { ...f, content: 'throw new Error("nope");' } : f));
      stage(withRoutes(bad, [{ method: 'GET', path: `/api/${ID}/status` }]));

      const r = await bootProof(STAGING_DIR, ID);
      expect(r.mounted).toBe(0);
      expect(r.ok).toBe(false);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});
