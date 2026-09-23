/**
 * Block storage never loses what it cannot read, and never leaves half a file.
 *
 * Store builder B1 (2026-09-23): readJSON swallowed a parse error and returned
 * the fallback, so a block doing read → change → write replaced a damaged file
 * with near-empty data; and writeJSON wrote in place, so a crash mid-write left
 * a truncated file. Both are kernel behaviour every block inherits.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createRootedStorage } = require('../src/kernel/blockStorage.cjs');

const tmp = [];
const mkroot = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-bs-')); tmp.push(d); return d; };
afterEach(() => { vi.restoreAllMocks(); while (tmp.length) fs.rmSync(tmp.pop(), { recursive: true, force: true }); });

describe('an unreadable JSON file', () => {
  it('is moved aside, not overwritten by the block\'s next write', () => {
    const root = mkroot();
    fs.writeFileSync(path.join(root, 'items.json'), '[{"name":"kept by the operator"');   // truncated
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = createRootedStorage(root);
    expect(s.readJSON('items.json', [])).toEqual([]);
    s.writeJSON('items.json', [{ name: 'new' }]);
    const aside = fs.readdirSync(root).filter((f) => f.startsWith('items.json.unreadable-'));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, aside[0]), 'utf8')).toBe('[{"name":"kept by the operator"');
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/could not be read .*kept as items\.json\.unreadable-/));
  });

  it('a missing file is just the fallback, with nothing moved or said', () => {
    const root = mkroot();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(createRootedStorage(root).readJSON('absent.json', { a: 1 })).toEqual({ a: 1 });
    expect(fs.readdirSync(root)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a read-only block leaves the file where it is', () => {
    const root = mkroot();
    fs.writeFileSync(path.join(root, 'x.json'), '{bad');
    expect(createRootedStorage(root, { write: false }).readJSON('x.json', null)).toBeNull();
    expect(fs.readdirSync(root)).toEqual(['x.json']);
  });
});

describe('writes', () => {
  it('replace the file whole and leave no temp files behind', () => {
    const root = mkroot();
    const s = createRootedStorage(root);
    const big = Array.from({ length: 5000 }, (_, i) => ({ i, text: 'x'.repeat(40) }));
    s.writeJSON('big.json', big);
    s.writeJSON('big.json', big.slice(0, 10));
    expect(JSON.parse(fs.readFileSync(path.join(root, 'big.json'), 'utf8'))).toHaveLength(10);
    expect(fs.readdirSync(root)).toEqual(['big.json']);
  });

  it('a failed write keeps the previous file intact', () => {
    const root = mkroot();
    const s = createRootedStorage(root);
    s.writeJSON('keep.json', { v: 1 });
    const real = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('ENOSPC: no space left on device'); });
    expect(() => s.writeJSON('keep.json', { v: 2 })).toThrow(/ENOSPC/);
    fs.renameSync = real;
    expect(JSON.parse(fs.readFileSync(path.join(root, 'keep.json'), 'utf8'))).toEqual({ v: 1 });
    expect(fs.readdirSync(root)).toEqual(['keep.json']);
  });
});
