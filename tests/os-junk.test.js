/**
 * Files the operating system drops beside real ones are never content.
 *
 * 2026-09-22 (USB drive test): macOS writes an AppleDouble sidecar "._<name>"
 * for every file that carries an extended attribute, on any volume that cannot
 * store attributes natively — exFAT, FAT, SMB. Copying AEON to an exFAT drive
 * produced 50,806 of them, and they keep appearing at runtime (drag a file into
 * the Vault with Finder). Every scan that filtered a directory by extension
 * took them for the real thing:
 *
 *   - the block host tried to mount "._chat.cjs" (39 NOT MOUNTED errors that
 *     buried any real mount failure);
 *   - the Second Brain indexed "._note.md" — binary metadata — as a document;
 *   - the cartridge reader refused any zip made by Finder's Compress, whose
 *     "__MACOSX/" folder counted as a second block;
 *   - `aeon pack` shipped the sidecars inside store cartridges.
 *
 * These drive the real modules with real AppleDouble-shaped bytes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-osjunk-'));
process.env.AEON_DB_DIR = process.env.AEON_DB_DIR || path.join(TMP, 'db');

const EXPRESS_PATH = require.resolve('express');

/** What macOS actually writes: AppleDouble magic, "Mac OS X" filler, an attribute name, binary. */
function appleDouble() {
  return Buffer.concat([
    Buffer.from([0x00, 0x05, 0x16, 0x07, 0x00, 0x02, 0x00, 0x00]),
    Buffer.from('Mac OS X        '),
    Buffer.from([0x00, 0x02, 0x00, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00, 0x32]),
    Buffer.from('ATTR\u0000\u0000\u0000\u0000com.apple.provenance\u0000com.apple.quarantine\u0000'),
    Buffer.from([0x01, 0x02, 0x00, 0xff, 0xfe, 0x00, 0x7f]),
  ]);
}

afterEach(() => { /* per-test dirs are under TMP */ });

describe('kernel/osJunk', () => {
  it('names AppleDouble sidecars and OS droppings, and nothing a person would name', () => {
    const { isOsJunk } = require('../src/kernel/osJunk.cjs');
    for (const n of ['._chat.cjs', '._note.md', '.DS_Store', '__MACOSX', 'Thumbs.db', 'desktop.ini',
      '.Spotlight-V100', '.fseventsd', '.Trashes', '$RECYCLE.BIN', 'System Volume Information']) {
      expect(isOsJunk(n)).toBe(true);
    }
    for (const n of ['chat.cjs', 'note.md', '_template', '.env', 'Desktop.md', 'thumbs.md']) {
      expect(isOsJunk(n)).toBe(false);
    }
  });
});

describe('block host', () => {
  it('mounts the real module and never tries the sidecar beside it', () => {
    const { createBlockHost } = require('../src/kernel/blockHost.cjs');
    const blocks = fs.mkdtempSync(path.join(TMP, 'blocks-'));
    const dir = path.join(blocks, 'junkprobe');
    fs.mkdirSync(path.join(dir, 'api'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'block.manifest.json'), JSON.stringify({
      manifestVersion: '1.1.0', id: 'junkprobe', label: 'Junkprobe', icon: '🧩', route: '/junkprobe',
      description: 'fixture', category: 'tools', tier: 'experimental', version: '0.0.1', api_routes: true,
      provides: { routes: true, api: true, models: [] },
      contract: { permissions: { filesystem: 'none', network: 'none', secrets: false, shell: false, ai: false },
        storage: { type: 'none', scope: 'block', access: 'scoped' } },
    }));
    fs.writeFileSync(path.join(dir, 'api', 'junkprobe.cjs'),
      `const express = require(${JSON.stringify(EXPRESS_PATH)});\n` +
      `module.exports = (_deps) => { const r = express.Router(); r.get('/junkprobe/ok', (_q, s) => s.json({ ok: true })); return r; };\n`);
    fs.writeFileSync(path.join(dir, 'api', '._junkprobe.cjs'), appleDouble());
    fs.writeFileSync(path.join(dir, 'api', '.DS_Store'), appleDouble());

    const host = createBlockHost({
      blocksDir: blocks,
      baseDeps: {},
      createScopedDeps: (b) => ({ ...b }),
      registry: [], readiness: {},
      getSyncCtx: () => ({ apiBase: '/api', runtime: 'local', models: {}, writeRuntime: false }),
      log: { log() {}, warn() {}, error() {} },
    });
    const scan = host.rescan('test');
    const mine = (scan.skipped || []).filter((s) => s.block === 'junkprobe');
    expect(mine.map((s) => s.file)).toEqual([]);
  });
});

describe('Second Brain scan', () => {
  let root, vault, dataRoot;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(TMP, 'brain-'));
    vault = path.join(root, 'Vault');
    dataRoot = path.join(root, 'data');
    fs.mkdirSync(vault, { recursive: true });
  });

  it('indexes the note, not its sidecar, and not an app folder hidden in the Vault', async () => {
    const ingestMod = require('../src/blocks/aeon_matrix/api/ingest.cjs');
    ingestMod._resetStores();
    fs.writeFileSync(path.join(vault, 'note.md'), '# Field notes\n\nThe warehouse audit found three pallet racks out of spec.\n');
    fs.writeFileSync(path.join(vault, '._note.md'), appleDouble());
    fs.writeFileSync(path.join(vault, '.DS_Store'), appleDouble());
    fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
    fs.writeFileSync(path.join(vault, '.obsidian', 'workspace.md'), '# workspace layout state for the editor, not a note\n');

    const embed = async () => ({ vector: [1, 0, 0], model: 'stub' });
    await ingestMod({ isVercel: false, VAULT_ROOT: vault, DATA_ROOT: dataRoot, embed }).runSecondBrainScan();

    const index = JSON.parse(fs.readFileSync(path.join(dataRoot, 'vault_index.json'), 'utf8'));
    expect(Object.keys(index.documents).sort()).toEqual(['note.md']);
  });
});

describe('cartridge reader', () => {
  it('reads a block zipped by Finder: ignores __MACOSX and sidecars inside the block', () => {
    const AdmZip = require('adm-zip');
    const { readCartridgeBuffer } = require('../src/kernel/store.cjs');
    const z = new AdmZip();
    z.addFile('blk/block.manifest.json', Buffer.from(JSON.stringify({ id: 'blk', version: '1.0.0' })));
    z.addFile('blk/index.jsx', Buffer.from('export default function B() { return null; }\n'));
    z.addFile('blk/._index.jsx', appleDouble());
    z.addFile('blk/.DS_Store', appleDouble());
    z.addFile('__MACOSX/blk/._index.jsx', appleDouble());
    z.addFile('__MACOSX/._blk', appleDouble());

    const r = readCartridgeBuffer(z.toBuffer());
    expect(r.blockId).toBe('blk');
    expect(r.files.map((f) => f.path).sort()).toEqual(['index.jsx']);
  });
});

describe('Writer version history', () => {
  it('lists real versions when a sidecar sits in the versions folder (it used to show none)', async () => {
    const express = require('express');
    const factory = require('../src/blocks/writer/api/writer2.cjs');
    const dataDir = fs.mkdtempSync(path.join(TMP, 'writer-'));
    const vdir = path.join(dataDir, 'versions', 'doc1');
    fs.mkdirSync(vdir, { recursive: true });
    fs.writeFileSync(path.join(vdir, '1789950852000.md'), 'first draft');
    fs.writeFileSync(path.join(vdir, '1789950999000.md'), 'second draft');
    fs.writeFileSync(path.join(vdir, '._1789950999000.md'), appleDouble());

    // No blockStorage injected: writer2 builds its own rooted storage over
    // getBlockDataFile('writer') — the real resolution path.
    const app = express();
    factory(app, { getBlockDataFile: () => dataDir });
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/writer/versions/doc1`);
      const body = await res.json();
      expect(body.versions.map((v) => v.ts)).toEqual([1789950999000, 1789950852000]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
