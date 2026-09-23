/**
 * Updating an installed pack from the store.
 *
 * Store builder B4 (2026-09-23): the pipeline refuses to install over a live
 * block ("bump version and use the update flow") and no update flow existed —
 * the operator had to remove the pack and install it again; the store listing
 * showed every catalog version as its own row with no Update. updateFromStore
 * is the flow: verify first, swap only what goes live on its own, keep the old
 * folder aside, put it back if the new one fails, restart it if it was running.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');
const { sha256 } = require('../src/kernel/storeSource.cjs');
const store = require('../src/kernel/store.cjs');

const ID = 'zz_update_probe';
let T, BLOCKS, STAGING, REMOVED, STORE, running, bufs;

function cartridge(version) {
  const zip = new AdmZip();
  zip.addFile(`${ID}/block.manifest.json`, Buffer.from(JSON.stringify({ id: ID, name: ID, label: 'Update Probe', version, route: `/${ID}` })));
  zip.addFile(`${ID}/index.jsx`, Buffer.from(`export default () => '${version}';\n`));
  return zip.toBuffer();
}
function writeStore({ tamperNewest = false } = {}) {
  fs.mkdirSync(path.join(STORE, 'cartridges'), { recursive: true });
  const items = [];
  for (const v of ['1.0.0', '1.1.0']) {
    const buf = bufs[v];
    const file = `${ID}-${v}.aeon`;
    fs.writeFileSync(path.join(STORE, 'cartridges', file), tamperNewest && v === '1.1.0' ? Buffer.concat([buf, Buffer.from('!')]) : buf);
    items.push({ file, id: ID, version: v, label: 'Update Probe', sha256: sha256(buf) });
  }
  fs.writeFileSync(path.join(STORE, 'catalog.json'), JSON.stringify({ store: 'Probe', items }));
}
function install(version) {
  fs.mkdirSync(path.join(BLOCKS, ID), { recursive: true });
  fs.writeFileSync(path.join(BLOCKS, ID, 'block.manifest.json'), JSON.stringify({ id: ID, version }));
}
const installedVersion = () => JSON.parse(fs.readFileSync(path.join(BLOCKS, ID, 'block.manifest.json'), 'utf8')).version;
const runState = { isRunning: (id) => running.has(id), setRunning: (id, on) => { if (on) running.add(id); else running.delete(id); return { ok: true }; } };

// A stub airlock: validateBuild reports a score; submitBuild "promotes" by
// writing the block into BLOCKS the way the real pipeline does, or fails at boot
// leaving the attempt in staging.
function pipeline({ score = 'LOW', outcome = 'live' } = {}) {
  const calls = [];
  return {
    calls,
    validateBuild: async () => ({ ok: true, errors: [], score, verdict: { score } }),
    submitBuild: async (_src, build) => {
      calls.push(build.meta);
      events.push('submit');
      if (outcome === 'live') {
        fs.mkdirSync(path.join(BLOCKS, ID), { recursive: true });
        fs.writeFileSync(path.join(BLOCKS, ID, 'block.manifest.json'), JSON.stringify(build.manifest));
        running.delete(ID);               // every promoted block lands stopped
        return { ok: true, stage: 'live' };
      }
      fs.mkdirSync(path.join(STAGING, ID), { recursive: true });
      fs.writeFileSync(path.join(STAGING, ID, 'block.manifest.json'), JSON.stringify(build.manifest));
      return { ok: false, stage: 'boot', error: 'staged block did not boot' };
    },
  };
}
let events;
const opts = () => ({ env: { AEON_STORE: STORE }, blocksDir: BLOCKS, stagingDir: STAGING, removedDir: REMOVED, runState,
  rescan: (reason) => events.push(`rescan:${reason}`) });

beforeEach(() => {
  T = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-update-'));
  [BLOCKS, STAGING, REMOVED, STORE] = ['blocks', 'staging', 'removed', 'store'].map((d) => path.join(T, d));
  fs.mkdirSync(BLOCKS); fs.mkdirSync(STAGING);
  running = new Set();
  events = [];
  bufs = { '1.0.0': cartridge('1.0.0'), '1.1.0': cartridge('1.1.0') };
});
afterEach(() => fs.rmSync(T, { recursive: true, force: true }));

describe('updateFromStore', () => {
  it('replaces the installed version, keeps the old folder aside, and restarts a running pack', async () => {
    writeStore(); install('1.0.0'); running.add(ID);
    const p = pipeline();
    const r = await store.updateFromStore(p, ID, opts());
    expect(r).toMatchObject({ ok: true, updated: true, from: '1.0.0', to: '1.1.0', sha: sha256(bufs['1.1.0']), running: true });
    expect(installedVersion()).toBe('1.1.0');
    expect(fs.readdirSync(REMOVED)).toEqual([expect.stringMatching(new RegExp(`^${ID}@`))]);
    expect(p.calls[0]).toMatchObject({ cartridge: `store:${ID}-1.1.0.aeon`, update: { from: '1.0.0' } });
    // The old version's routes are unmounted before the new one is proofed —
    // otherwise the proof sees them as a live collision (measured, 2026-09-23).
    expect(events.slice(0, 2)).toEqual([`rescan:update-aside:${ID}`, 'submit']);
  });

  it('nothing to do when the newest version is installed', async () => {
    writeStore(); install('1.1.0');
    const r = await store.updateFromStore(pipeline(), ID, opts());
    expect(r).toMatchObject({ ok: true, upToDate: true, latest: '1.1.0' });
    expect(fs.existsSync(REMOVED)).toBe(false);
  });

  it('a new version that fails to go live is rolled back: the old one is back and running', async () => {
    writeStore(); install('1.0.0'); running.add(ID);
    const r = await store.updateFromStore(pipeline({ outcome: 'boot' }), ID, opts());
    expect(r).toMatchObject({ ok: false, rolledBack: true });
    expect(r.error).toMatch(/1\.0\.0 is back in place and running/);
    expect(installedVersion()).toBe('1.0.0');
    expect(running.has(ID)).toBe(true);
    expect(fs.existsSync(path.join(STAGING, ID))).toBe(false);                 // the failed attempt is kept aside…
    expect(fs.readdirSync(REMOVED).some((f) => f.startsWith(`${ID}-failed-update@`))).toBe(true);
  });

  it('an update that needs approval is refused before anything moves', async () => {
    writeStore(); install('1.0.0');
    const r = await store.updateFromStore(pipeline({ score: 'MEDIUM' }), ID, opts());
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(r.error).toMatch(/needs your review .*approval queue/);
    expect(installedVersion()).toBe('1.0.0');
    expect(fs.existsSync(REMOVED)).toBe(false);
  });

  it('a cartridge that does not match the catalog is refused before anything moves', async () => {
    writeStore({ tamperNewest: true }); install('1.0.0');
    await expect(store.updateFromStore(pipeline(), ID, opts())).rejects.toThrow(/does not match the store's catalog/);
    expect(installedVersion()).toBe('1.0.0');
    expect(fs.existsSync(REMOVED)).toBe(false);
  });

  it('a pack that is not installed is sent to install', async () => {
    writeStore();
    const r = await store.updateFromStore(pipeline(), ID, opts());
    expect(r).toMatchObject({ ok: false, status: 404 });
    expect(r.error).toMatch(/not installed — install it/);
  });
});

describe('the store listing shows one row per pack, with an update when there is one', () => {
  it('newest version only; updateAvailable against what is installed', async () => {
    writeStore();
    const saved = { store: process.env.AEON_STORE, blocks: process.env.AEON_BLOCKS_DIR };
    process.env.AEON_STORE = STORE;
    try {
      const app = express();
      app.use('/api/store', require('../src/kernel/routers/store.cjs')({ pipeline: {} }));
      const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
      const d = await fetch(`http://127.0.0.1:${server.address().port}/api/store/source`).then((r) => r.json());
      server.close();
      expect(d.items.filter((i) => i.id === ID)).toEqual([expect.objectContaining({ version: '1.1.0', updateAvailable: false, installedVersion: null })]);
    } finally {
      if (saved.store === undefined) delete process.env.AEON_STORE; else process.env.AEON_STORE = saved.store;
    }
  });
});
