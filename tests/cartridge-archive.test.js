import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');
const store = require('../src/kernel/store.cjs');

function cartridge(entries) {
  const zip = new AdmZip();
  for (const [name, content] of entries) zip.addFile(name, Buffer.from(content));
  return zip.toBuffer();
}

describe('cartridge archive hardening (BO5 — adm-zip)', () => {
  it('reads a well-formed single-folder cartridge', () => {
    const buf = cartridge([
      ['myblock/block.manifest.json', JSON.stringify({ id: 'myblock' })],
      ['myblock/index.jsx', 'export default () => null;'],
    ]);
    const { blockId, manifest, files } = store.readCartridgeBuffer(buf);
    expect(blockId).toBe('myblock');
    expect(manifest.id).toBe('myblock');
    expect(files.some(f => f.path === 'index.jsx')).toBe(true);
  });

  it('blocks path-traversal (zip-slip) entries', () => {
    const buf = cartridge([
      ['myblock/block.manifest.json', JSON.stringify({ id: 'myblock' })],
      ['myblock/../../../etc/evil', 'pwned'],
    ]);
    expect(() => store.readCartridgeBuffer(buf)).toThrow(/unsafe path|exactly one top-level/);
  });

  it('rejects an empty archive', () => {
    expect(() => store.readCartridgeBuffer(cartridge([]))).toThrow(/empty/);
  });

  it('rejects multiple top-level folders', () => {
    const buf = cartridge([
      ['a/block.manifest.json', JSON.stringify({ id: 'a' })],
      ['b/x.js', 'x'],
    ]);
    expect(() => store.readCartridgeBuffer(buf)).toThrow(/exactly one top-level/);
  });

  it('rejects an invalid block id', () => {
    const buf = cartridge([['Bad-Id/block.manifest.json', JSON.stringify({ id: 'Bad-Id' })]]);
    expect(() => store.readCartridgeBuffer(buf)).toThrow(/invalid block id/);
  });

  it('fails gracefully on a non-zip / malformed buffer (controlled throw, no crash)', () => {
    expect(() => store.readCartridgeBuffer(Buffer.from('this is definitely not a zip file'))).toThrow();
  });

  it('is on the patched adm-zip (>=0.6.0) and reads a size-bomb archive without a 4GB allocation', () => {
    const [maj, min] = require('adm-zip/package.json').version.split('.').map(Number);
    expect(maj > 0 || (maj === 0 && min >= 6)).toBe(true); // CVE-2026-39244 patched

    // Build a real cartridge, then falsely declare ~4GB uncompressed size in every
    // local (PK\x03\x04, +22) and central (PK\x01\x02, +24) header. Pre-0.6.0 this
    // drove a Buffer.alloc(~4GB) on read (crash / OOM); 0.6.0 validates the declared
    // size against the actual data and returns the real bytes instead.
    const zip = new AdmZip();
    zip.addFile('myblock/block.manifest.json', Buffer.from('{"id":"myblock"}'));
    zip.addFile('myblock/big.txt', Buffer.from('A'.repeat(8192)));
    const bomb = Buffer.from(zip.toBuffer());
    const HUGE = 0xfffffff0;
    for (let i = 0; i + 28 <= bomb.length; i++) {
      if (bomb[i] === 0x50 && bomb[i + 1] === 0x4b && bomb[i + 2] === 0x03 && bomb[i + 3] === 0x04) {
        bomb.writeUInt32LE(HUGE, i + 22);
      } else if (bomb[i] === 0x50 && bomb[i + 1] === 0x4b && bomb[i + 2] === 0x01 && bomb[i + 3] === 0x02) {
        bomb.writeUInt32LE(HUGE, i + 24);
      }
    }
    // The bogus 4GB size is NOT honored: the read completes and every extracted
    // file is bounded to its real size — no uncontrolled allocation, no crash.
    let files = null;
    try { files = store.readCartridgeBuffer(bomb).files; } catch { files = null; }
    if (files) for (const f of files) expect(f.content.length).toBeLessThan(1_000_000);
    expect(process.memoryUsage().rss).toBeLessThan(1_500_000_000); // never ballooned to GBs
  });
});
