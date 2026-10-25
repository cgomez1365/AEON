/**
 * a17: a CHANGED file whose windows fail to re-embed must not keep the window
 * record of its OLD text.
 *
 * The chunk sidecar stores offsets ({ s, e }) into the extracted text. When a
 * file changed and its windows then failed to embed, the old record stayed:
 * retrieval sliced the NEW text at the OLD offsets and handed the model a
 * passage that was never in the window the vector describes — or a passage
 * that no longer exists. The failure must also be counted (chunkFailed, from
 * the chunk-embed-failure work), whether the windows or the summary failed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const ingest = require('../src/blocks/aeon_matrix/api/ingest.cjs');

const para = (word, n) => Array.from({ length: n }, (_, i) =>
  `Paragraph ${i}. ` + `${word} on aisle four were out of spec and tagged for repair by the night crew. `.repeat(4)).join('\n\n');
const OLD = '# Dock audit\n\n' + para('Racks', 6);
const NEW = '# Dock audit, revised\n\nA short preface added at the top moves every window.\n\n' + para('Pallets', 9);

const healthy = async () => ({ vector: [0, 1, 0], model: 'stub' });
const LIMIT = 600; // the summary (280 chars) fits; every window (~1,200) does not
const windowsRefused = async (text) => {
  if (String(text).length > LIMIT) throw new Error('llama-server /v1/embeddings returned 500: input is too large to process');
  return { vector: [1, 0, 0], model: 'stub' };
};
const allRefused = async () => { throw new Error('llama-server /v1/embeddings returned 500: server crashed'); };

let root, vault, data, warn;
const file = () => path.join(vault, 'dock.md');
const sidecar = () => JSON.parse(fs.readFileSync(path.join(data, 'vault_chunks.json'), 'utf8'));

async function scan(embedFn) {
  ingest._resetStores();
  const router = ingest({ isVercel: false, VAULT_ROOT: vault, DATA_ROOT: data, embed: embedFn });
  return router.runSecondBrainScan(() => {});
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-stale-chunks-'));
  vault = path.join(root, 'Vault');
  data = path.join(root, 'data');
  fs.mkdirSync(vault, { recursive: true });
  fs.writeFileSync(file(), OLD);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  ingest._resetStores();
  fs.rmSync(root, { recursive: true, force: true });
});

async function indexOldThenChange() {
  const first = await scan(healthy);
  expect(first.chunkFailed).toBe(0);
  const old = sidecar()['dock.md'];
  expect(old && old.chunks.length).toBeGreaterThan(1);
  fs.writeFileSync(file(), NEW);
  return old.chunks.map((c) => `${c.s}-${c.e}`);
}

describe('a changed file whose windows fail to re-embed', () => {
  it('windows refused: no window record with the old offsets remains, and the failure is counted', async () => {
    const oldOffsets = await indexOldThenChange();
    const r = await scan(windowsRefused);

    const rec = sidecar()['dock.md'];
    const left = rec ? rec.chunks.map((c) => `${c.s}-${c.e}`) : [];
    expect(left.filter((o) => oldOffsets.includes(o)), 'window records of the OLD text survived the change').toEqual([]);
    expect(r.chunkFailed).toBe(1);
    expect(r.chunkErrors[0]).toEqual({ file: 'dock.md', error: expect.stringContaining('too large') });

    // The entry describes the new text and says its windows are owed, so the
    // next scan's chunk backfill embeds them.
    const idx = JSON.parse(fs.readFileSync(path.join(data, 'vault_index.json'), 'utf8'));
    expect(idx.documents['dock.md'].title).toBe('Dock audit, revised');
    expect(idx.documents['dock.md'].chunks).toBeUndefined();

    const healed = await scan(healthy);
    expect(healed.chunkFailed).toBe(0);
    const fresh = sidecar()['dock.md'];
    expect(fresh.chunks.length).toBeGreaterThan(1);
    expect(fresh.chunks.at(-1).e).toBe(NEW.length);
  });

  it('summary refused too: the old window record is still dropped, and the failure is counted', async () => {
    const oldOffsets = await indexOldThenChange();
    const r = await scan(allRefused);

    const rec = sidecar()['dock.md'];
    const left = rec ? rec.chunks.map((c) => `${c.s}-${c.e}`) : [];
    expect(left.filter((o) => oldOffsets.includes(o)), 'window records of the OLD text survived the change').toEqual([]);
    expect(r.chunkFailed).toBe(1);
    expect(r.chunkErrors[0].file).toBe('dock.md');
  });
});
