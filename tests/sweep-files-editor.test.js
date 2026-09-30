/**
 * The Files editor saves the file it opened — never the /read preview.
 *
 * Sweep finding C00 (P0, data loss), reproduced on b6fd6b3: the File Manager
 * opened an editable file through POST /api/fs/read, whose answer is for a
 * person or an agent to READ — the first 8,000 characters plus a marker line
 * ("[… N more characters — ask about it, or open the file]"), HTML with its
 * tags stripped, after a model summary. Save posted the textarea to
 * /api/fs/write, which replaced the real file: a 20 KB notes.md lost its tail
 * and gained the marker, an .html file lost its markup, a .bat file (on the
 * editor's list) could not open at all (415), and every open waited on the
 * model.
 *
 * Now the editor asks for {raw:true}: the file's own bytes, whole or refused
 * (413 above the cap, 415 when not UTF-8 text). The default /read answer is
 * unchanged for chat and agents, and /fs/write refuses to write a preview over
 * an existing file — the backstop for a screen built before this server.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const iso = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-sweep-files-iso-'));
const savedEnv = { AEON_HOME: process.env.AEON_HOME, AEON_SECRETS_DIR: process.env.AEON_SECRETS_DIR, AEON_ENV_FILE: process.env.AEON_ENV_FILE };
process.env.AEON_HOME = path.join(iso, 'home');
process.env.AEON_SECRETS_DIR = path.join(iso, 'secrets');
process.env.AEON_ENV_FILE = path.join(iso, '.env');
const createFsRouter = require('../src/blocks/host_os/api/fs.cjs');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// The Files screen reads window.location at module scope; the helpers under
// test do not touch the DOM.
let ui;
const hadWindow = 'window' in globalThis;
beforeAll(async () => {
  if (!hadWindow) globalThis.window = { location: { hostname: 'localhost' } };
  ui = await import('../src/blocks/files/index.jsx');
});
afterAll(() => {
  if (!hadWindow) delete globalThis.window;
  fs.rmSync(iso, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

let root, server, base, llm;
beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-sweep-files-')));
  llm = vi.fn(async () => 'SUMMARY');
  const router = createFsRouter({
    isVercel: false, WORKSPACE: root, HOME_ROOT: root, VAULT_ROOT: path.join(root, 'Vault'),
    kernelLLM: llm, getDataFile: (n) => path.join(root, 'data', n), writeOSAudit: () => {},
  });
  const app = express(); app.use(express.json({ limit: '10mb' })); app.use('/api', router);
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}/api/fs`;
});
afterEach(() => { try { server.close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); });

const post = async (route, body) => {
  const r = await fetch(`${base}/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const unlock = () => post('lock', { locked: false });

// ~22,000 characters, every line numbered, so a lost tail is visible.
const LONG = Array.from({ length: 1000 }, (_, i) => `line ${String(i).padStart(4, '0')} of notes.md`).join('\n');

describe('the editor opens the whole file (raw read)', () => {
  it('a 22 KB notes.md comes back byte-for-byte, with no summary spent', async () => {
    const file = path.join(root, 'notes.md');
    fs.writeFileSync(file, LONG);
    const r = await post('read', { filePath: file, raw: true });
    expect(r.status).toBe(200);
    expect(r.body.raw).toBe(true);
    expect(r.body.truncated).toBe(false);
    expect(r.body.content).toBe(LONG);
    expect(r.body.content).not.toMatch(/more characters — ask about it/);
    expect(r.body.bytes).toBe(Buffer.byteLength(LONG));
    expect(llm).not.toHaveBeenCalled();
  });

  it('an .html file keeps its markup', async () => {
    const html = '<html><body><h1>Title</h1><p>The vault needs <b>both</b> halves.</p></body></html>\n';
    fs.writeFileSync(path.join(root, 'page.html'), html);
    const r = await post('read', { filePath: 'page.html', raw: true });
    expect(r.status).toBe(200);
    expect(r.body.content).toBe(html);
  });

  it('a .bat file (on the editor\'s list) opens, and says it is CRLF', async () => {
    const bat = '@echo off\r\necho AEON\r\n';
    fs.writeFileSync(path.join(root, 'start.bat'), bat);
    const r = await post('read', { filePath: 'start.bat', raw: true });
    expect(r.status).toBe(200);
    expect(r.body.content).toBe(bat);
    expect(r.body.eol).toBe('\r\n');
  });

  it('a file over the cap is refused whole — no part of it is handed to the editor', async () => {
    fs.writeFileSync(path.join(root, 'big.log.txt'), 'x'.repeat(1024 * 1024 + 1));
    const r = await post('read', { filePath: 'big.log.txt', raw: true });
    expect(r.status).toBe(413);
    expect(r.body.content).toBeUndefined();
    expect(r.body.error).toMatch(/will not open part of a file/);
    expect(r.body.error).toMatch(/is 1,048,577 bytes \(1\.0 MB\) — over the 1,048,576 bytes/);
    expect(r.body.remedy).toBeTruthy();
    expect(llm).not.toHaveBeenCalled();
  });

  it('bytes that are not UTF-8 text are refused, not decoded into something a save would change', async () => {
    fs.writeFileSync(path.join(root, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])); // "café" in Latin-1
    const r = await post('read', { filePath: 'latin1.txt', raw: true });
    expect(r.status).toBe(415);
    expect(r.body.content).toBeUndefined();
    expect(r.body.error).toMatch(/not UTF-8 text/);
  });

  it('the credential refusal list still applies', async () => {
    fs.mkdirSync(path.join(root, '.ssh'));
    fs.writeFileSync(path.join(root, '.ssh', 'id_rsa'), 'KEY');
    const r = await post('read', { filePath: path.join(root, '.ssh', 'id_rsa'), raw: true });
    expect(r.status).toBe(403);
  });
});

describe('open → edit → save keeps everything that was not edited', () => {
  it('the saved file is the original with only the edit applied', async () => {
    const file = path.join(root, 'notes.md');
    fs.writeFileSync(file, LONG);
    await unlock();
    const opened = ui.editableFrom((await post('read', { filePath: file, raw: true })).body);
    expect(opened.ok).toBe(true);
    const edited = opened.content.replace('line 0000 of notes.md', 'line 0000 of notes.md (typo fixed)');
    const w = await post('write', { filePath: file, content: ui.toDiskText(edited, opened.eol) });
    expect(w.status).toBe(200);
    const onDisk = fs.readFileSync(file, 'utf8');
    expect(onDisk).toBe(LONG.replace('line 0000 of notes.md', 'line 0000 of notes.md (typo fixed)'));
    expect(onDisk).toMatch(/line 0999 of notes\.md$/); // the tail survived
  });

  it('a CRLF file edited in a textarea (which yields \\n) is saved back as CRLF', async () => {
    const file = path.join(root, 'start.bat');
    fs.writeFileSync(file, '@echo off\r\necho AEON\r\n');
    await unlock();
    const opened = ui.editableFrom((await post('read', { filePath: file, raw: true })).body);
    const fromTextarea = opened.content.replace(/\r\n/g, '\n').replace('AEON', 'AEON ready');
    await post('write', { filePath: file, content: ui.toDiskText(fromTextarea, opened.eol) });
    expect(fs.readFileSync(file, 'utf8')).toBe('@echo off\r\necho AEON ready\r\n');
  });

  it('the editor refuses the /read preview answer (an older server that ignores raw)', async () => {
    const file = path.join(root, 'notes.md');
    fs.writeFileSync(file, LONG);
    const preview = (await post('read', { filePath: file })).body; // no raw: what the old editor opened
    expect(ui.editableFrom(preview).ok).toBe(false);
    expect(ui.editableFrom({ ...preview, raw: true }).ok).toBe(false); // truncated is not whole
    expect(ui.editableFrom(null).ok).toBe(false);
  });

  it('toDiskText never doubles a CR and leaves LF files alone', () => {
    expect(ui.toDiskText('a\nb', '\r\n')).toBe('a\r\nb');
    expect(ui.toDiskText('a\r\nb', '\r\n')).toBe('a\r\nb');
    expect(ui.toDiskText('a\nb', '\n')).toBe('a\nb');
  });

  it('the Files screen asks /read for the raw file', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/blocks/files/index.jsx'), 'utf8');
    expect(src).toMatch(/JSON\.stringify\(\{ filePath: entry\.storagePath, raw: true \}\)/);
    expect(src).toMatch(/editableFrom\(data\)/);
    expect(src).toMatch(/toDiskText\(editContent, editEol\)/);
  });
});

describe('/fs/write will not put a preview over a real file', () => {
  it('writing the /read preview back over the file is refused and the file is untouched', async () => {
    const file = path.join(root, 'notes.md');
    fs.writeFileSync(file, LONG);
    await unlock();
    const preview = (await post('read', { filePath: file, summarize: false })).body.content;
    const w = await post('write', { filePath: file, content: preview.replace('line 0000', 'line 0000!') });
    expect(w.status).toBe(409);
    expect(w.body.error).toMatch(/preview/);
    expect(fs.readFileSync(file, 'utf8')).toBe(LONG);
  });

  // A file the old bug already cut short ends in the marker, and the raw
  // editor opens it whole. The refusal must not tell the operator repairing it
  // that they opened a preview — and must name the way through.
  it('a file an earlier save cut short opens whole, and the refusal says so and how to save', async () => {
    const file = path.join(root, 'damaged.md');
    const damaged = (await post('read', { filePath: (fs.writeFileSync(file, LONG), file), summarize: false })).body.content;
    fs.writeFileSync(file, damaged); // what the old Save left behind
    await unlock();
    const opened = await post('read', { filePath: file, raw: true });
    expect(opened.status).toBe(200);
    expect(opened.body.content).toBe(damaged);
    const w = await post('write', { filePath: file, content: opened.body.content });
    expect(w.status).toBe(409);
    expect(w.body.error).toMatch(/a file an earlier save already cut short/);
    expect(w.body.remedy).toMatch(/^Remove the marker line to save/);
    const repaired = damaged.replace(/\r?\n\r?\n\[… \d+ more characters — ask about it, or open the file\]\s*$/, '\n');
    expect((await post('write', { filePath: file, content: repaired })).status).toBe(200);
  });

  it('a preview may still be saved as a NEW file', async () => {
    const file = path.join(root, 'notes.md');
    fs.writeFileSync(file, LONG);
    const preview = (await post('read', { filePath: file, summarize: false })).body.content;
    const w = await post('write', { filePath: path.join(root, 'notes-preview.md'), content: preview });
    expect(w.status).toBe(200);
  });
});

describe('chat and agents keep the /read preview', () => {
  it('without raw, a long file is still the summary plus an 8,000-character preview', async () => {
    const file = path.join(root, 'notes.md');
    fs.writeFileSync(file, LONG);
    const r = await post('read', { filePath: file });
    expect(r.status).toBe(200);
    expect(r.body.truncated).toBe(true);
    expect(r.body.content.startsWith(LONG.slice(0, 8000))).toBe(true);
    expect(r.body.content.endsWith(`\n\n[… ${LONG.length - 8000} more characters — ask about it, or open the file]`)).toBe(true);
    expect(r.body.summary).toBe('SUMMARY');
    expect(r.body.raw).toBeUndefined();
  });
});
