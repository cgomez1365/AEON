/**
 * Quick Links persist across a reload, with no Firebase and no Supabase.
 *
 * Found live, 2026-09-20 (operator: added 2 links, refreshed, both gone).
 * AeonContext.jsx's Firestore effect ran `setLinks([])` whenever `!user || !db`
 * — which is EVERY default install (Firebase env vars ship empty, `db` is
 * null). The add path did write localStorage['aeon_links'], but the very next
 * mount hydrated from it and that effect immediately wiped state back to [].
 * Firestore writes were a caught console.error no-op. The server already had
 * a real store for this block (GET/POST /api/sync/quick_links ->
 * quick-links.json) that nothing in the client ever called.
 *
 * There is no DOM environment here, so the client logic lives in the pure
 * helper src/kernel/contexts/linksStore.js (injected fetch + storage) and the
 * wiring is pinned with a comment-stripped source check.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { loadLinks, saveLinks, readLocalLinks } from '../src/kernel/contexts/linksStore.js';

const require = createRequire(import.meta.url);
const syncFactory = require('../src/blocks/aeon_matrix/api/sync.cjs');

const memStorage = (init = {}) => {
  const m = { ...init };
  return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, _m: m };
};
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const L = (n) => ({ id: n, name: n, url: `https://${n}.test`, category: 'General' });

describe('linksStore (client logic)', () => {
  it('loads from the server and refreshes the local cache', async () => {
    const storage = memStorage();
    const fetcher = async () => res(200, { source: 'local', data: [L('a'), L('b')] });
    const r = await loadLinks({ fetcher, storage });
    expect(r.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(r.error).toBeNull();
    expect(readLocalLinks(storage)).toHaveLength(2);
  });

  it('migrates legacy localStorage links to an empty server store', async () => {
    const storage = memStorage({ aeon_links: JSON.stringify([L('x')]) });
    const posted = [];
    const fetcher = async (url, opts) => {
      if (opts && opts.method === 'POST') { posted.push(JSON.parse(opts.body)); return res(200, { success: true }); }
      return res(200, { source: 'local', data: [] });
    };
    const r = await loadLinks({ fetcher, storage });
    expect(r.items.map((i) => i.id)).toEqual(['x']);
    expect(posted).toEqual([{ data: [L('x')] }]);
  });

  it('falls back to local links AND reports it when the server is unreachable', async () => {
    const storage = memStorage({ aeon_links: JSON.stringify([L('x')]) });
    const fetcher = async () => { throw new Error('ECONNREFUSED'); };
    const r = await loadLinks({ fetcher, storage });
    expect(r.items).toHaveLength(1);
    expect(r.error).toMatch(/ECONNREFUSED/);
  });

  it('tolerates corrupt localStorage instead of throwing', () => {
    expect(readLocalLinks(memStorage({ aeon_links: '{not json' }))).toEqual([]);
  });

  it('saveLinks reports a server failure instead of swallowing it', async () => {
    const storage = memStorage();
    const bad = await saveLinks([L('a')], { fetcher: async () => res(500, { error: 'disk full' }), storage });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/disk full/);
    const thrown = await saveLinks([L('a')], { fetcher: async () => { throw new Error('offline'); }, storage });
    expect(thrown.ok).toBe(false);
    expect(thrown.error).toMatch(/offline/);
    expect(readLocalLinks(storage)).toHaveLength(1); // cache still written
  });

  it('saveLinks POSTs the whole list to /api/sync/quick_links', async () => {
    let seen;
    const fetcher = async (url, opts) => { seen = { url, opts }; return res(200, { success: true }); };
    const r = await saveLinks([L('a')], { fetcher, storage: memStorage() });
    expect(r.ok).toBe(true);
    expect(seen.url).toBe('/api/sync/quick_links');
    expect(seen.opts.method).toBe('POST');
    expect(JSON.parse(seen.opts.body)).toEqual({ data: [L('a')] });
  });
});

describe('server store survives a restart (local-only, no Supabase)', () => {
  let root; const servers = [];
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-ql-')); });
  afterEach(() => { servers.splice(0).forEach((s) => s.close()); fs.rmSync(root, { recursive: true, force: true }); });
  const boot = () => new Promise((resolve) => {
    const app = express(); app.use(express.json());
    app.use('/api', syncFactory({
      supabase: null, isVercel: false,
      getLocalFile: (n) => path.join(root, 'db', n), getDataFile: (r) => path.join(root, 'data', r),
      validateSDI: () => ({ valid: true }), writeOSAudit: () => {},
    }));
    const s = app.listen(0, '127.0.0.1', () => { servers.push(s); resolve(`http://127.0.0.1:${s.address().port}`); });
  });

  it('two links written through saveLinks are read back by a fresh server', async () => {
    const a = await boot();
    const r = await saveLinks([L('one'), L('two')], { fetcher: (u, o) => fetch(a + u, o), storage: memStorage() });
    expect(r.ok).toBe(true);
    servers.splice(0).forEach((s) => s.close());
    const b = await boot();
    const back = await loadLinks({ fetcher: (u, o) => fetch(b + u, o), storage: memStorage() });
    expect(back.items.map((i) => i.id)).toEqual(['one', 'two']);
  });
});

describe('AeonContext wiring', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../src/kernel/contexts/AeonContext.jsx', import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  it('does not wipe links when Firebase is absent', () => {
    const branch = src.slice(src.indexOf('if (!user || !db)'), src.indexOf('const unsubClients'));
    expect(branch).not.toMatch(/setLinks\(/);
  });
  it('hydrates and saves links through linksStore', () => {
    expect(src).toMatch(/from '\.\/linksStore'/);
    expect(src).toMatch(/loadLinks\(/);
    expect(src).toMatch(/saveLinks\(/);
  });
});
