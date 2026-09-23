/**
 * Installing a pack "from the store": by id, from the store AEON_STORE names,
 * and only if the bytes hash to what the store's catalog lists.
 *
 * Before (2026-09-23): `install { name }` looked only in this install's own
 * dist-blocks/, a URL install checked nothing, and every install recorded
 * `sha: null`. The CEO's gate is "every block can be installed from the store".
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const AdmZip = require('adm-zip');
const storeSource = require('../src/kernel/storeSource.cjs');
const store = require('../src/kernel/store.cjs');

const ID = 'zz_store_probe';
const tmp = [];
const mkdtemp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmp.push(d); return d; };
afterAll(() => { while (tmp.length) fs.rmSync(tmp.pop(), { recursive: true, force: true }); });

function cartridge(version = '1.0.0') {
  const zip = new AdmZip();
  zip.addFile(`${ID}/block.manifest.json`, Buffer.from(JSON.stringify({
    id: ID, name: ID, label: 'Store Probe', version, route: `/${ID}`, description: 'fixture',
    contract: { permissions: { filesystem: 'write', network: 'internal', secrets: false, shell: false, ai: false } },
  })));
  zip.addFile(`${ID}/index.jsx`, Buffer.from('export default () => null;\n'));
  return zip.toBuffer();
}

function localStore({ tamper = false } = {}) {
  const dir = mkdtemp('aeon-store-src-');
  fs.mkdirSync(path.join(dir, 'cartridges'));
  fs.mkdirSync(path.join(dir, 'site', 'store'), { recursive: true });
  const buf = cartridge();
  const file = `${ID}-1.0.0.aeon`;
  fs.writeFileSync(path.join(dir, 'cartridges', file), tamper ? Buffer.concat([buf, Buffer.from('x')]) : buf);
  fs.writeFileSync(path.join(dir, 'site', 'store', 'catalog.json'), JSON.stringify({
    store: 'Test Store', items: [{ file, id: ID, version: '1.0.0', label: 'Store Probe', sha256: storeSource.sha256(buf) }],
  }));
  return { dir, sha: storeSource.sha256(buf) };
}

describe('the store source', () => {
  it('is named by AEON_STORE: an https catalog, or a folder; plain http is refused', () => {
    expect(storeSource.resolveSource({})).toBeNull();
    expect(storeSource.resolveSource({ AEON_STORE: 'https://example.com/store/catalog.json' }))
      .toEqual({ kind: 'url', catalogUrl: 'https://example.com/store/catalog.json' });
    expect(storeSource.resolveSource({ AEON_STORE: 'http://example.com/catalog.json' }).kind).toBe('invalid');
    // path.resolve, not the literal: on Windows a drive-less absolute path borrows the cwd drive (as in 875b8af).
    expect(storeSource.resolveSource({ AEON_STORE: '/srv/aeon-store' })).toEqual({ kind: 'dir', dir: path.resolve('/srv/aeon-store') });
    // .env is not shell-expanded: "~" and relative paths are refused with the fix named.
    expect(storeSource.resolveSource({ AEON_STORE: '~/aeon-store' })).toMatchObject({ kind: 'invalid', error: expect.stringMatching(/full path/) });
    expect(storeSource.resolveSource({ AEON_STORE: 'aeon-store' }).kind).toBe('invalid');
  });

  it('picks the newest version of an id, compared as numbers', () => {
    const items = [{ id: 'a', version: '1.9.0' }, { id: 'a', version: '1.10.0' }, { id: 'b', version: '9.0.0' }];
    expect(storeSource.pickItem(items, 'a').version).toBe('1.10.0');
    expect(storeSource.pickItem(items, 'zzz')).toBeNull();
  });

  it('a local store: the cartridge is read and proven by its hash', async () => {
    const { dir, sha } = localStore();
    const src = storeSource.resolveSource({ AEON_STORE: dir });
    const { items } = await storeSource.loadCatalog(src);
    const got = await storeSource.fetchCartridge(src, items[0]);
    expect(got.sha).toBe(sha);
  });

  it('a catalog entry naming a path, not a cartridge, is refused', async () => {
    const { dir } = localStore();
    const src = storeSource.resolveSource({ AEON_STORE: dir });
    await expect(storeSource.fetchCartridge(src, { id: ID, file: '../../site/store/catalog.json', sha256: 'x' })).rejects.toThrow(/not a cartridge name/);
    await expect(storeSource.fetchCartridge(src, { id: '../x', file: 'x-1.0.0.aeon', sha256: 'x' })).rejects.toThrow(/not a cartridge name/);
  });

  it('a cartridge that does not hash to the catalog is refused', async () => {
    const { dir } = localStore({ tamper: true });
    const src = storeSource.resolveSource({ AEON_STORE: dir });
    const { items } = await storeSource.loadCatalog(src);
    await expect(storeSource.fetchCartridge(src, items[0])).rejects.toThrow(/does not match the store's catalog/);
  });

  describe('an https store', () => {
    afterEach(() => vi.restoreAllMocks());
    it('a paid pack (no download link) says where to buy it', async () => {
      const src = storeSource.resolveSource({ AEON_STORE: 'https://shop.example.com/store/catalog.json' });
      await expect(storeSource.fetchCartridge(src, { id: 'clients', label: 'Clients', file: 'clients-1.0.0.aeon', sha256: 'x' }))
        .rejects.toThrow(/sold, not downloadable.*https:\/\/shop\.example\.com\/store\//);
    });
    it('a free pack downloads relative to the catalog and is hash-checked', async () => {
      const buf = cartridge();
      const seen = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        seen.push(String(url));
        return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) };
      });
      const src = storeSource.resolveSource({ AEON_STORE: 'https://shop.example.com/store/catalog.json' });
      const item = { id: ID, file: `${ID}-1.0.0.aeon`, download: `cartridges/${ID}-1.0.0.aeon`, sha256: storeSource.sha256(buf) };
      expect((await storeSource.fetchCartridge(src, item)).sha).toBe(item.sha256);
      expect(seen).toEqual([`https://shop.example.com/store/cartridges/${ID}-1.0.0.aeon`]);
    });
  });
});

describe('install { name } falls through to the store', () => {
  const pipeline = () => {
    const calls = [];
    return { calls, submitBuild: async (kind, build) => { calls.push({ kind, build }); return { ok: true, stage: 'live' }; } };
  };

  it('installs from the store with the catalog hash recorded', async () => {
    expect(store.findCartridgeFile(ID)).toBeNull();
    const { dir, sha } = localStore();
    const p = pipeline();
    const r = await store.installCartridge(p, { name: ID }, { env: { AEON_STORE: dir } });
    expect(r.ok).toBe(true);
    expect(r.sha).toBe(sha);
    expect(r.from).toBe(`store:${ID}-1.0.0.aeon`);
    expect(p.calls[0].build.meta).toEqual({ cartridge: `store:${ID}-1.0.0.aeon`, sha });
  });

  it('a tampered store cartridge never reaches the pipeline', async () => {
    const { dir } = localStore({ tamper: true });
    const p = pipeline();
    await expect(store.installCartridge(p, { name: ID }, { env: { AEON_STORE: dir } })).rejects.toThrow(/does not match/);
    expect(p.calls).toHaveLength(0);
  });

  it('with no store configured, the error says how to configure one', async () => {
    await expect(store.installCartridge(pipeline(), { name: ID }, { env: {} })).rejects.toThrow(/set AEON_STORE/);
  });

  it('an id the store does not list is named', async () => {
    const { dir } = localStore();
    await expect(store.installCartridge(pipeline(), { name: 'zz_absent' }, { env: { AEON_STORE: dir } })).rejects.toThrow(/not in the store's catalog \(1 pack listed\)/);
  });
});

describe('GET /api/store/source and the CLI', () => {
  let server, url, saved;
  beforeAll(async () => {
    saved = process.env.AEON_STORE;
    process.env.AEON_STORE = localStore().dir;
    const app = express();
    app.use(express.json());
    app.use('/api/store', require('../src/kernel/routers/store.cjs')({ pipeline: {} }));
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    url = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => { server?.close(); if (saved === undefined) delete process.env.AEON_STORE; else process.env.AEON_STORE = saved; });

  it('lists what the store offers and what is installed', async () => {
    const d = await fetch(`${url}/api/store/source`).then((r) => r.json());
    expect(d.configured).toBe(true);
    expect(d.store).toBe('Test Store');
    expect(d.items).toEqual([expect.objectContaining({ id: ID, version: '1.0.0', installable: true, installedVersion: null })]);
  });

  it('`aeon install <file.aeon>` sends the cartridge bytes, not a name', async () => {
    const got = [];
    const app = express();
    app.use(express.json({ limit: '5mb' }));
    app.get('/api/ping', (_q, r) => r.json({ ok: true }));
    app.post('/api/commands/dispatch', (q, r) => { got.push(q.body); r.json({ ok: true, text: 'installed', data: { ok: true } }); });
    const s2 = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const home = mkdtemp('aeon-cli-home-');
    const file = path.join(home, `${ID}-1.0.0.aeon`);
    const bytes = cartridge();
    fs.writeFileSync(file, bytes);
    const status = await new Promise((resolve) => {
      const c = spawn(process.execPath, [path.join(ROOT, 'tools', 'aeon-cli.cjs'), 'install', file, '--yes'], {
        env: { ...process.env, AEON_URL: `http://127.0.0.1:${s2.address().port}`, AEON_HOME: home, DATA_PATH: '' },
      });
      const t = setTimeout(() => c.kill('SIGKILL'), 20000);
      c.on('close', (code) => { clearTimeout(t); resolve(code); });
    });
    s2.close();
    expect(status).toBe(0);
    expect(JSON.stringify(got)).toContain(bytes.toString('base64').slice(0, 60));
  });
});
