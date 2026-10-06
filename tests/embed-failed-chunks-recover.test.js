/**
 * Chunks that could not be embedded while the local embed server refused any
 * input over 512 tokens (cac4868) come back on a later index pass.
 *
 * What the bug left behind: buildEntry embeds the 280-character summary first,
 * then every window of the document. A window the server refused threw out of
 * buildChunks, buildEntry swallowed it, and the entry was written WITH its
 * summary vector, WITHOUT `chunks`, and with no sidecar record. The manifest
 * already knew the file, so nothing re-reads it as changed — the only thing
 * that can repair it is the "chunk backfill" branch of the scan, which keys on
 * `existing.chunks === undefined`. This drives that path end to end, over the
 * index a previous run left on disk, the way a restart does.
 *
 * Also pins what the index status does NOT say: it counts document vectors, so
 * it reads clean while windows are missing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const ingest = require('../src/blocks/aeon_matrix/api/ingest.cjs');

// A stand-in for the refusing server: the summary (<= 280 chars) fits, a
// 1,200-character window does not. The real limit is in tokens; the real
// binary is measured separately, this only has to be "short ok, long refused".
const LIMIT = 600;
const refusing = async (text) => {
  if (String(text).length > LIMIT) throw new Error('llama-server /v1/embeddings returned 500: input is too large to process');
  return { vector: [1, 0, 0], model: 'stub' };
};
const healthy = async () => ({ vector: [0, 1, 0], model: 'stub' });
const dead = async () => { throw new Error('no model'); };

const BODY = '# Dock audit\n\n' + Array.from({ length: 6 }, (_, i) =>
  `Paragraph ${i}. ` + 'Racks on aisle four were out of spec and tagged for repair by the night crew. '.repeat(4)).join('\n\n');

let root, vault, data;
const servers = [];

/** A fresh process over whatever a previous run left in `data` (a restart). */
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
  };
}
const readIndex = () => JSON.parse(fs.readFileSync(path.join(data, 'vault_index.json'), 'utf8')).documents['dock.md'];
const readChunks = () => {
  const f = path.join(data, 'vault_chunks.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-failed-chunks-'));
  vault = path.join(root, 'Vault');
  data = path.join(root, 'data');
  fs.mkdirSync(vault, { recursive: true });
  fs.writeFileSync(path.join(vault, 'dock.md'), BODY);
});
afterEach(() => { while (servers.length) servers.pop().close(); fs.rmSync(root, { recursive: true, force: true }); });

describe('windows that failed to embed are rebuilt by the next index pass', () => {
  it('the failed pass leaves a document with a summary vector and no windows', async () => {
    const h = await boot(refusing);
    const events = await h.scan();
    const done = events.find((e) => e.done);
    expect(done.errors).toEqual([]);                 // the failure was swallowed, not reported
    expect(done.embedded).toBe(1);                   // counted as embedded: the summary vector is there
    const doc = readIndex();
    expect(Array.isArray(doc.embedding)).toBe(true);
    expect(doc.chunks).toBeUndefined();              // the marker the backfill keys on
    expect(readChunks()['dock.md']).toBeUndefined();
  });

  it('index-status reads clean while the windows are missing', async () => {
    const h = await boot(refusing);
    await h.scan();
    const s = await h.status();
    expect(s.embedding.documents).toBe(1);
    expect(s.embedding.embedded).toBe(1);
    expect(s.embedding.missing).toBe(0);             // counts document vectors only
    expect(readChunks()['dock.md']).toBeUndefined(); // and the windows are not there
  });

  it('after a restart, a normal pass writes the windows and says it did', async () => {
    await (await boot(refusing)).scan();
    expect(readChunks()['dock.md']).toBeUndefined();

    const events = await (await boot(healthy)).scan();   // restart, embedder now accepts the windows
    const backfill = events.filter((e) => e.action === 'chunk-backfill');
    expect(backfill).toHaveLength(1);
    expect(backfill[0].chunks).toBeGreaterThan(1);

    const rec = readChunks()['dock.md'];
    expect(rec.chunks).toHaveLength(backfill[0].chunks);
    expect(rec.chunks.every((c) => Array.isArray(c.v) || typeof c.v === 'string')).toBe(true);
    expect(readIndex().chunks).toBe(rec.chunks.length);
    // The file was not re-ingested as new: it is the same entry, repaired in place.
    expect(events.find((e) => e.done).skipped).toBe(0);
    expect(events.some((e) => e.file === 'dock.md' && !e.action)).toBe(false);
  });

  it('a pass that still cannot embed the windows leaves them recoverable', async () => {
    await (await boot(refusing)).scan();
    await (await boot(refusing)).scan();             // still refused
    expect(readIndex().chunks).toBeUndefined();
    const events = await (await boot(healthy)).scan();
    expect(events.filter((e) => e.action === 'chunk-backfill')).toHaveLength(1);
    expect(readChunks()['dock.md'].chunks.length).toBeGreaterThan(1);
  });

  it('a document whose summary vector failed too needs two passes: vector first, then windows', async () => {
    await (await boot(dead)).scan();                 // nothing embedded at all
    expect(readIndex().embedding).toBeUndefined();

    const first = await (await boot(healthy)).scan();
    expect(first.filter((e) => e.action === 'embed-backfill')).toHaveLength(1);
    expect(first.filter((e) => e.action === 'chunk-backfill')).toHaveLength(0);
    expect(readChunks()['dock.md']).toBeUndefined();

    const second = await (await boot(healthy)).scan();
    expect(second.filter((e) => e.action === 'chunk-backfill')).toHaveLength(1);
    expect(readChunks()['dock.md'].chunks.length).toBeGreaterThan(1);
  });
});
