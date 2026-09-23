/**
 * Settings → Blocks → FROM THE STORE: the page's store calls, driven without a
 * DOM against the REAL store router over a temp store folder (AEON_STORE) and
 * a stub pipeline. What must hold: the list shows what the store offers; an
 * install says it landed stopped and was verified against the store; a
 * tampered cartridge comes back as the kernel's own refusal, inline; every
 * call is self-reported (the page shows its own errors, no global banner).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const express = require('express');
const AdmZip = require('adm-zip');
const { sha256 } = require('../src/kernel/storeSource.cjs');
const lc = await import('../src/blocks/settings/blockLifecycle.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-settings-store-'));
const ID = 'zz_settings_probe';
const headers = [];
const built = [];
let server, base, saved;

function makeStore(dir, { tamper = false } = {}) {
  const zip = new AdmZip();
  zip.addFile(`${ID}/block.manifest.json`, Buffer.from(JSON.stringify({ id: ID, name: ID, label: 'Settings Probe', version: '1.0.0', route: `/${ID}` })));
  zip.addFile(`${ID}/index.jsx`, Buffer.from('export default () => null;\n'));
  const buf = zip.toBuffer();
  fs.mkdirSync(path.join(dir, 'cartridges'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'cartridges', `${ID}-1.0.0.aeon`), tamper ? Buffer.concat([buf, Buffer.from('!')]) : buf);
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify({ store: 'Probe Store', items: [
    { file: `${ID}-1.0.0.aeon`, id: ID, version: '1.0.0', label: 'Settings Probe', tier: 1, warnings: [], sha256: sha256(buf) },
  ] }));
}

beforeAll(async () => {
  saved = process.env.AEON_STORE;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { headers.push(req.headers['x-aeon-self-reported']); next(); });
  app.use('/api/store', require('../src/kernel/routers/store.cjs')({
    pipeline: { submitBuild: async (_k, b) => { built.push(b.meta); return { ok: true, stage: 'live' }; } },
  }));
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (saved === undefined) delete process.env.AEON_STORE; else process.env.AEON_STORE = saved;
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('Settings → Blocks → From the store', () => {
  it('with no store configured, the page gets the hint to show', async () => {
    delete process.env.AEON_STORE;
    const r = await lc.createLifecycleClient({ base }).storeList();
    expect(r.ok).toBe(true);
    expect(r.data.configured).toBe(false);
    expect(r.data.hint).toMatch(/AEON_STORE/);
  });

  it('lists the store and installs a pack, saying it landed stopped and was verified', async () => {
    const dir = path.join(TMP, 'good');
    makeStore(dir);
    process.env.AEON_STORE = dir;
    const client = lc.createLifecycleClient({ base });
    const list = await client.storeList();
    expect(list.data.items).toEqual([expect.objectContaining({ id: ID, installable: true, installedVersion: null })]);
    const r = await client.install(ID);
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/installed and stopped/);
    expect(r.message).toMatch(/Verified against the store \(SHA-256 [0-9a-f]{12}…\)/);
    expect(built.at(-1).cartridge).toBe(`store:${ID}-1.0.0.aeon`);
  });

  it('a tampered cartridge is the kernel\'s refusal, shown inline', async () => {
    const dir = path.join(TMP, 'bad');
    makeStore(dir, { tamper: true });
    process.env.AEON_STORE = dir;
    const n = built.length;
    const r = await lc.createLifecycleClient({ base }).install(ID);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/does not match the store's catalog/);
    expect(built.length).toBe(n);
  });

  it('every store call is self-reported', () => {
    expect(headers.length).toBeGreaterThan(0);
    expect(headers.every((h) => h === '1')).toBe(true);
  });
});
