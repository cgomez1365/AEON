/**
 * One Vault, many machines: the Second Brain must not re-index (or lose
 * vectors) just because the drive moved.
 *
 * Found 2026-09-22 carrying AEON on an exFAT drive:
 *
 *   1. The change manifest was keyed by path.relative() — "a/b.md" on macOS,
 *      "a\\b.md" on Windows — while the index itself was keyed "a/b.md". On
 *      the next machine every lookup missed, every document was rebuilt, and
 *      on a host with no embedder the rebuild REPLACED each vectored entry
 *      with a vector-less one.
 *   2. The change hash is size + mtime in ms. exFAT keeps mtime to 10 ms
 *      (HFS+ to 1 s, FAT to 2 s), so a plain copy onto the drive changed every
 *      hash and re-indexed the whole Vault on first boot. Measured: APFS
 *      …852778.44 → exFAT …852770.
 *
 * A timestamp that only LOST precision is the same file. A real edit — even
 * a same-size one — still re-indexes.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const ingestMod = require('../src/blocks/aeon_matrix/api/ingest.cjs');

let root, vault, dataRoot, embedCalls;
const embed = async () => { embedCalls++; return { vector: [1, 0, 0], model: 'stub' }; };
const scan = () => ingestMod({ isVercel: false, VAULT_ROOT: vault, DATA_ROOT: dataRoot, embed }).runSecondBrainScan();
const manifestPath = () => path.join(dataRoot, 'index_manifest.json');
const readManifest = () => JSON.parse(fs.readFileSync(manifestPath(), 'utf8'));
const DOC = '# Pallet audit\n\nThree racks on aisle four were out of spec and were tagged for repair.\n';

/** Set mtime to an exact millisecond and return what the filesystem reports back. */
function setMtimeMs(p, ms) {
  fs.utimesSync(p, new Date(ms), new Date(ms));
  return fs.statSync(p).mtimeMs;
}

beforeEach(() => {
  ingestMod._resetStores();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-crossfs-'));
  vault = path.join(root, 'Vault');
  dataRoot = path.join(root, 'data');
  fs.mkdirSync(path.join(vault, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'notes', 'audit.md'), DOC);
  embedCalls = 0;
});

describe('manifest keys are the same on every OS', () => {
  it('a manifest written on Windows ("notes\\audit.md") is recognised, not re-indexed', async () => {
    await scan();
    const m = readManifest();
    expect(Object.keys(m)).toEqual(['notes/audit.md']);

    // The same Vault, as Windows would have recorded it.
    fs.writeFileSync(manifestPath(), JSON.stringify({ 'notes\\audit.md': m['notes/audit.md'] }, null, 2));
    ingestMod._resetStores();
    embedCalls = 0;

    const r = await scan();
    expect(r.ingested).toBe(0);
    expect(embedCalls).toBeLessThanOrEqual(1); // the scan's one space probe, never a rebuild
    expect(Object.keys(readManifest())).toEqual(['notes/audit.md']);
  });
});

describe('a timestamp that only lost precision is the same file', () => {
  const file = () => path.join(vault, 'notes', 'audit.md');

  for (const [fs_, g] of [['exFAT', 10], ['HFS+', 1000], ['FAT', 2000]]) {
    it(`a copy onto ${fs_} (${g} ms mtime) is not re-indexed`, async () => {
      const precise = setMtimeMs(file(), 1789950852778);
      await scan();
      ingestMod._resetStores();
      embedCalls = 0;

      setMtimeMs(file(), Math.floor(Math.round(precise) / g) * g);
      const r = await scan();
      expect(r.ingested).toBe(0);
      expect(r.skipped).toBe(1);
    });
  }

  it('a same-size edit is still re-indexed', async () => {
    setMtimeMs(file(), 1789950852778);
    await scan();
    ingestMod._resetStores();

    fs.writeFileSync(file(), DOC.replace('four', 'nine')); // same length
    setMtimeMs(file(), 1789950857123);
    const r = await scan();
    expect(r.ingested).toBe(1);
  });

  it('a same-size edit that lands on a round timestamp is still re-indexed', async () => {
    setMtimeMs(file(), 1789950852778);
    await scan();
    ingestMod._resetStores();

    fs.writeFileSync(file(), DOC.replace('four', 'nine'));
    setMtimeMs(file(), 1789950860000); // a multiple of every granularity, but 7 s later
    const r = await scan();
    expect(r.ingested).toBe(1);
  });
});
