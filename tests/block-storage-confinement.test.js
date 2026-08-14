/**
 * A block's storage surface confines it to its own namespace.
 *
 * BO-SHIP P2.2. Audit P0-07 proved every shipped block could resolve a
 * sibling's data and Vault paths, and P1-14 proved a block declaring
 * filesystem:"none" could import fs and enumerate its siblings anyway.
 *
 * The sandbox scopes by DELETING injected deps, so it can only withhold what
 * it hands out. The reason every block reached for `require('fs')` is that the
 * sanctioned surface was six functions and blocks make 346 filesystem calls —
 * no existsSync, no readdirSync, no statSync, no unlink, no streams. A boundary
 * nobody can work behind is a boundary nobody uses.
 *
 * `storage.fs` is fs-shaped and routes every path through
 * getBlockDataFile(blockId, rel), inheriting the kernel's escape check. These
 * tests are the proof that the shape did not smuggle a hole in with it.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { createBlockStorage } = require('../src/kernel/blockStorage.cjs');

let root;

/** A getBlockDataFile with the same escape check the kernel enforces. */
function makeGetBlockDataFile(base) {
  return (blockId, rel = '') => {
    const blockRoot = path.join(base, 'data', blockId);
    const resolved = path.resolve(blockRoot, rel);
    if (resolved !== blockRoot && !resolved.startsWith(blockRoot + path.sep)) {
      throw new Error(`path escapes the ${blockId} namespace`);
    }
    return resolved;
  };
}

function storageFor(blockId, { write = true } = {}) {
  return createBlockStorage({
    blockId,
    contract: { permissions: { filesystem: write ? 'write' : 'read' }, storage: { access: 'scoped' } },
    getBlockDataFile: makeGetBlockDataFile(root),
    getBlockVaultFile: (id, rel = '') => path.join(root, 'Vault', 'blocks', id, rel),
    vaultSync: () => {},
    requestIndex: () => {},
  });
}

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-bs-')); });
afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

describe('the confined surface works for ordinary block code', () => {
  it('writes and reads inside its own namespace', () => {
    const s = storageFor('writer');
    s.fs.writeFileSync('notes/one.md', 'hello');
    expect(s.fs.existsSync('notes/one.md')).toBe(true);
    expect(s.fs.readFileSync('notes/one.md')).toBe('hello');
    expect(s.fs.readdirSync('notes')).toContain('one.md');
    expect(s.fs.statSync('notes/one.md').size).toBe(5);
  });

  it('supports the delete and rename shapes blocks actually use', () => {
    const s = storageFor('writer');
    s.fs.writeFileSync('a.md', 'x');
    s.fs.renameSync('a.md', 'b.md');
    expect(s.fs.existsSync('a.md')).toBe(false);
    expect(s.fs.existsSync('b.md')).toBe(true);
    s.fs.unlinkSync('b.md');
    expect(s.fs.existsSync('b.md')).toBe(false);
  });

  it('readJSON returns the fallback instead of throwing on a missing file', () => {
    const s = storageFor('writer');
    expect(s.readJSON('_index.json', [])).toEqual([]);
    s.writeJSON('_index.json', [{ id: 'doc-1' }]);
    expect(s.readJSON('_index.json', [])).toEqual([{ id: 'doc-1' }]);
  });

  it('existsSync answers false for an escaping path rather than throwing', () => {
    // Block code does `if (fs.existsSync(p))` constantly. Throwing there would
    // turn a boundary violation into a crash in unrelated code.
    const s = storageFor('writer');
    expect(s.fs.existsSync('../council/secret.json')).toBe(false);
  });
});

describe('the boundary holds — this is P0-07', () => {
  const escapes = [
    '../council/secret.json',
    '../../Vault/blocks/security/local_auth.json',
    'notes/../../council/secret.json',
  ];

  it.each(escapes)('refuses to read %s', (p) => {
    const s = storageFor('writer');
    expect(() => s.fs.readFileSync(p)).toThrow(/escapes/);
  });

  it.each(escapes)('refuses to write %s', (p) => {
    const s = storageFor('writer');
    expect(() => s.fs.writeFileSync(p, 'x')).toThrow(/escapes/);
  });

  it('refuses to list, stat, delete or rename outside the namespace', () => {
    const s = storageFor('writer');
    expect(() => s.fs.readdirSync('../council')).toThrow(/escapes/);
    expect(() => s.fs.statSync('../council/secret.json')).toThrow(/escapes/);
    expect(() => s.fs.unlinkSync('../council/secret.json')).toThrow(/escapes/);
    expect(() => s.fs.renameSync('a.md', '../council/stolen.md')).toThrow(/escapes/);
  });

  it("cannot reach a sibling's real file even when it exists", () => {
    const council = storageFor('council');
    council.fs.writeFileSync('secret.json', '{"key":"value"}');

    const writer = storageFor('writer');
    expect(() => writer.fs.readFileSync('../council/secret.json')).toThrow(/escapes/);
    expect(writer.fs.existsSync('../council/secret.json')).toBe(false);
  });
});

describe('write permission is enforced, not just declared', () => {
  it('a read-only block can read but not write', () => {
    const rw = storageFor('writer');
    rw.fs.writeFileSync('seed.md', 'seeded');

    const ro = storageFor('writer', { write: false });
    expect(ro.fs.readFileSync('seed.md')).toBe('seeded');

    for (const [op, run] of [
      ['writeFileSync', () => ro.fs.writeFileSync('x.md', 'x')],
      ['appendFileSync', () => ro.fs.appendFileSync('x.md', 'x')],
      ['mkdirSync', () => ro.fs.mkdirSync('sub')],
      ['unlinkSync', () => ro.fs.unlinkSync('seed.md')],
      ['rmSync', () => ro.fs.rmSync('seed.md')],
      ['renameSync', () => ro.fs.renameSync('seed.md', 'y.md')],
      ['createWriteStream', () => ro.fs.createWriteStream('x.md')],
    ]) {
      expect(run, `${op} was allowed without a write declaration`).toThrow(/does not declare/);
    }
  });

  it('names the manifest field it wants, so the fix is obvious', () => {
    const ro = storageFor('writer', { write: false });
    expect(() => ro.fs.writeFileSync('x', 'y')).toThrow(/permissions\.filesystem/);
  });
});
