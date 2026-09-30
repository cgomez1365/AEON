/**
 * Writer's document list survives a damaged _index.json (sweep C14).
 *
 * _index.json is rewritten on every autosave. It was read with a bare
 * catch → [] and written with a plain writeFileSync (truncate, then write).
 * One save cut off on the exFAT drive left an index that read as "no
 * documents", and the next autosave wrote it back holding only the open
 * draft: every other draft dropped out of the list while its <id>.md stayed
 * on disk with nothing pointing at it.
 *
 * Run under both storage shapes Writer can get: the host's blockStorage
 * (built from the real manifest contract) and the rooted fallback.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-writer-index-'));
process.env.AEON_HOME = path.join(TMP, 'home');
process.env.AEON_SECRETS_DIR = path.join(TMP, 'secrets');
process.env.AEON_ENV_FILE = path.join(TMP, '.env');
delete process.env.VERCEL;

const mountWriter = require('../src/blocks/writer/api/writer.js');
const { createBlockStorage } = require('../src/kernel/blockStorage.cjs');
const manifest = require('../src/blocks/writer/block.manifest.json');

afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

const shapes = {
  'host blockStorage': (dataRoot) => {
    const getBlockDataFile = (blockId, rel = '') => path.resolve(dataRoot, blockId, rel || '.');
    return {
      supabase: null, kernelLLM: async () => '', getBlockDataFile,
      blockStorage: createBlockStorage({
        blockId: 'writer', contract: manifest.contract, getBlockDataFile,
        getBlockVaultFile: (blockId, rel = '') => path.resolve(dataRoot, 'vault', blockId, rel || '.'),
        vaultSync: () => {}, requestIndex: () => {},
      }),
    };
  },
  'rooted fallback': (dataRoot) => ({
    supabase: null, kernelLLM: async () => '',
    getBlockDataFile: (blockId, rel = '') => path.resolve(dataRoot, blockId, rel || '.'),
  }),
};

async function start(shape) {
  const dataRoot = fs.mkdtempSync(path.join(TMP, 'data-'));
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  mountWriter(app, shapes[shape](dataRoot));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  // A request the old code never answered comes back as status 0, not a hang.
  const call = async (method, url, body) => {
    try {
      const res = await fetch(base + url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(3000),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    } catch { return { status: 0, body: null }; }
  };
  const dir = path.join(dataRoot, 'writer');
  const indexFile = path.join(dir, '_index.json');
  const index = () => JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  const close = () => new Promise((r) => server.close(r));
  return { call, dir, indexFile, index, close };
}

async function threeDrafts(w) {
  for (const [id, title, content] of [
    ['doc-a', 'Alpha', '<h1>Alpha plan</h1><p>first</p>'],
    ['doc-b', 'Bravo', '<p>Bravo notes</p>'],
    ['doc-c', 'Charlie', '# Charlie legacy\n\nmarkdown body'],
  ]) {
    const r = await w.call('POST', '/api/writer/doc', { id, title, content });
    expect(r.status).toBe(200);
  }
  expect(w.index().map((d) => d.id).sort()).toEqual(['doc-a', 'doc-b', 'doc-c']);
}

// What a write cut off between truncate and the last byte leaves behind.
function tear(file) {
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.slice(0, Math.floor(text.length / 2)));
}

describe.each(Object.keys(shapes))('Writer index under %s', (shape) => {
  it('lists every draft when _index.json is cut off, and keeps the damaged file', async () => {
    const w = await start(shape);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await threeDrafts(w);
      fs.writeFileSync(path.join(w.dir, '._doc-a.md'), Buffer.from([0, 5, 22, 7])); // exFAT sidecar
      tear(w.indexFile);

      const list = await w.call('GET', '/api/writer/docs');
      expect(list.status).toBe(200);
      expect(list.body.map((d) => d.id).sort()).toEqual(['doc-a', 'doc-b', 'doc-c']);
      const byId = Object.fromEntries(list.body.map((d) => [d.id, d]));
      expect(byId['doc-a'].title).toBe('Alpha plan');
      expect(byId['doc-c'].title).toBe('Charlie legacy');

      expect(fs.readdirSync(w.dir).some((f) => f.startsWith('_index.json.unreadable-'))).toBe(true);
      // The rebuilt list is written back and said once, not re-scanned per list.
      expect(w.index().map((d) => d.id).sort()).toEqual(['doc-a', 'doc-b', 'doc-c']);
      expect(warn.mock.calls.some(([m]) => /\[WRITER\] document list rebuilt from 3/.test(String(m)))).toBe(true);
    } finally { warn.mockRestore(); await w.close(); }
  });

  it('the next autosave writes back every draft, not only the open one', async () => {
    const w = await start(shape);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await threeDrafts(w);
      tear(w.indexFile);

      const r = await w.call('POST', '/api/writer/doc', { id: 'doc-b', title: 'Bravo', content: '<p>Bravo notes, edited</p>' });
      expect(r.status).toBe(200);
      const idx = w.index();
      expect(idx.map((d) => d.id).sort()).toEqual(['doc-a', 'doc-b', 'doc-c']);
      expect(idx[0]).toMatchObject({ id: 'doc-b', title: 'Bravo' });
    } finally { warn.mockRestore(); await w.close(); }
  });

  it('a delete against a damaged index removes one draft, not all of them', async () => {
    const w = await start(shape);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await threeDrafts(w);
      tear(w.indexFile);

      expect((await w.call('DELETE', '/api/writer/doc/doc-a')).status).toBe(200);
      expect(w.index().map((d) => d.id).sort()).toEqual(['doc-b', 'doc-c']);
    } finally { warn.mockRestore(); await w.close(); }
  });

  it('a write that fails part-way leaves the previous index whole, and the save answers', async () => {
    const w = await start(shape);
    const realWrite = fs.writeFileSync;
    try {
      await threeDrafts(w);
      // Disk full part-way through any write aimed at the index, or beside it.
      vi.spyOn(fs, 'writeFileSync').mockImplementation(function (file, data, ...rest) {
        if (path.basename(String(file)).startsWith('_index.json')) {
          realWrite.call(fs, file, String(data).slice(0, 10), ...rest);
          throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
        }
        return realWrite.call(fs, file, data, ...rest);
      });
      const r = await w.call('POST', '/api/writer/doc', { id: 'doc-d', title: 'Delta', content: '<p>new</p>' });
      vi.restoreAllMocks();

      expect(r.status).toBe(500);
      expect(r.body.error).toMatch(/ENOSPC/);
      expect(w.index().map((d) => d.id).sort()).toEqual(['doc-a', 'doc-b', 'doc-c']);
      expect(fs.readdirSync(w.dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
    } finally { vi.restoreAllMocks(); await w.close(); }
  });
});
