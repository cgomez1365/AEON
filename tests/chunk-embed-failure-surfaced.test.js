/**
 * R-05: a window (chunk) that fails to embed is a failure, and failures are
 * logged, counted and shown — never swallowed.
 *
 * Before this, buildEntry embedded the summary, then every window; a window the
 * embedder refused threw out of buildChunks, buildEntry caught it, printed (at
 * most once per process) a warning that blamed a missing embed model, and the
 * scan counted the document as embedded. The chunk-backfill branch swallowed the
 * same failure with an empty catch. The scan result, the saved status, the
 * /index-brain sentence and index-status all read clean while /ask had no
 * windows to cite. embed-failed-chunks-recover.test.js proves the windows come
 * back later; this proves the operator is TOLD they are missing meanwhile.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const ingest = require('../src/blocks/aeon_matrix/api/ingest.cjs');

const LIMIT = 600;
const refusing = async (text) => {
  if (String(text).length > LIMIT) throw new Error('llama-server /v1/embeddings returned 500: input is too large to process');
  return { vector: [1, 0, 0], model: 'stub' };
};
const healthy = async () => ({ vector: [0, 1, 0], model: 'stub' });

const BODY = '# Dock audit\n\n' + Array.from({ length: 6 }, (_, i) =>
  `Paragraph ${i}. ` + 'Racks on aisle four were out of spec and tagged for repair by the night crew. '.repeat(4)).join('\n\n');

let root, vault, data, warn;
const servers = [];

async function boot(embedFn) {
  ingest._resetStores();
  const app = express();
  app.use(express.json());
  app.use('/api', ingest({ isVercel: false, VAULT_ROOT: vault, DATA_ROOT: data, embed: embedFn }));
  const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  servers.push(s);
  const base = `http://127.0.0.1:${s.address().port}/api`;
  return {
    status: async () => (await fetch(`${base}/crn/second-brain/index-status`)).json(),
    scan: async () => {
      const r = await fetch(`${base}/crn/second-brain/ingest/scan-docs`, { method: 'POST' });
      return (await r.text()).split('\n\n').filter(Boolean)
        .map((f) => { try { return JSON.parse(f.replace(/^data: /, '')); } catch { return null; } }).filter(Boolean);
    },
    summary: async () => JSON.parse(await (await fetch(`${base}/crn/second-brain/ingest/scan-docs?format=summary`, { method: 'POST' })).text()),
  };
}
const warned = () => warn.mock.calls.map((c) => c.join(' ')).join('\n');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-chunk-surfaced-'));
  vault = path.join(root, 'Vault');
  data = path.join(root, 'data');
  fs.mkdirSync(vault, { recursive: true });
  fs.writeFileSync(path.join(vault, 'dock.md'), BODY);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  while (servers.length) servers.pop().close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('a window that fails to embed is logged, counted and reported', () => {
  it('first ingest: the scan result counts it, names the file and the cause, and the log says so', async () => {
    const events = await (await boot(refusing)).scan();
    const done = events.find((e) => e.done);
    expect(done.chunkFailed).toBe(1);
    expect(done.chunkErrors).toEqual([{ file: 'dock.md', error: expect.stringContaining('too large') }]);
    const ev = events.find((e) => e.file === 'dock.md' && !e.done);
    expect(ev.chunkError).toMatch(/too large/);
    expect(warned()).toMatch(/dock\.md/);
    expect(warned()).toMatch(/too large/);
  });

  it('the saved status (lastResult) carries the count, and index-status counts documents missing windows', async () => {
    const h = await boot(refusing);
    await h.scan();
    const s = await h.status();
    expect(s.lastResult.chunkFailed).toBe(1);
    expect(s.embedding.chunksMissing).toBe(1);

    const h2 = await boot(healthy);
    await h2.scan();
    const s2 = await h2.status();
    expect(s2.lastResult.chunkFailed).toBe(0);
    expect(s2.embedding.chunksMissing).toBe(0);
  });

  it('chunk backfill that still fails is counted and logged on every pass, not swallowed', async () => {
    await (await boot(refusing)).scan();
    warn.mockClear();
    const events = await (await boot(refusing)).scan();
    const done = events.find((e) => e.done);
    expect(done.chunkFailed).toBe(1);
    expect(events.some((e) => e.file === 'dock.md' && e.action === 'chunk-backfill-failed')).toBe(true);
    expect(warned()).toMatch(/dock\.md/);
  });

  it('the /index-brain sentence says windows could not be embedded', async () => {
    const body = await (await boot(refusing)).summary();
    expect(body.chunkFailed).toBe(1);
    expect(body.text).toMatch(/could not be embedded/i);
    expect(body.text).toMatch(/dock\.md/);
  });

  it('a clean run reports zero and says nothing about windows', async () => {
    const body = await (await boot(healthy)).summary();
    expect(body.chunkFailed).toBe(0);
    expect(body.chunkErrors).toEqual([]);
    expect(body.text).not.toMatch(/could not be embedded/i);
  });
});
