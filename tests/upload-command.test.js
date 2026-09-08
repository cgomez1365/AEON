/**
 * /upload puts a document into the Second Brain.
 *
 * It was an Auto-Pilot cloud push that did nothing locally (removed 2026-09-07,
 * CEO: "appears to do nothing"). Now: copy a file from under the operator's
 * home into the vault, index it, summarize it — the intake counterpart of /read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ingestFactory = require('../src/blocks/aeon_matrix/api/ingest.cjs');

let home, vault, servers, llm;
beforeEach(() => {
  ingestFactory._resetStores();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-upload-'));
  vault = path.join(home, 'AEON', 'Vault'); fs.mkdirSync(vault, { recursive: true });
  servers = []; llm = vi.fn(async () => 'SUMMARY: a memo about the keyslot bridge.');
});
afterEach(() => { for (const s of servers) { try { s.close(); } catch {} } try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });

async function mount() {
  const router = ingestFactory({ isVercel: false, VAULT_ROOT: vault, DATA_ROOT: path.join(home, 'AEON', 'data'), HOME_ROOT: home, WORKSPACE: path.join(home, 'AEON'), kernelLLM: llm, embed: async (t) => ({ vector: [0.1, 0.2], model: 'stub' }) });
  const app = express(); app.use(express.json()); app.use('/api', router);
  const s = await new Promise(r => { const x = app.listen(0, '127.0.0.1', () => r(x)); }); servers.push(s);
  return async (body) => { const r = await fetch(`http://127.0.0.1:${s.address().port}/api/crn/second-brain/upload`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
}

describe('/upload', () => {
  it('copies a document into the vault, indexes it, and summarizes it', async () => {
    const src = path.join(home, 'Documents', 'memo.md'); fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, '# Memo\nThe keyslot bridge ships first, before the store.');
    const upload = await mount();
    const r = await upload({ filePath: src });
    expect(r.status).toBe(200);
    expect(r.body.file).toBe('Reading_Library/Uploads/memo.md');
    expect(fs.existsSync(path.join(vault, 'Reading_Library', 'Uploads', 'memo.md'))).toBe(true);
    const idx = JSON.parse(fs.readFileSync(path.join(home, 'AEON', 'data', 'vault_index.json'), 'utf8'));
    expect(idx.documents['Reading_Library/Uploads/memo.md']).toBeTruthy();
    expect(r.body.summary).toMatch(/^SUMMARY/);
    expect(r.body.text).toMatch(/Added memo\.md to the Second Brain/);
    expect(llm.mock.calls[0][0]).toMatch(/keyslot bridge ships first/);
  });

  it('never overwrites an earlier upload with the same name', async () => {
    const src = path.join(home, 'a.md'); fs.writeFileSync(src, 'first version of a note, long enough to index');
    const upload = await mount();
    await upload({ filePath: src });
    fs.writeFileSync(src, 'second version of a note, long enough to index');
    const r = await upload({ filePath: src });
    expect(r.body.file).toBe('Reading_Library/Uploads/a-2.md');
  });

  it('refuses a file outside the home folder', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'elsewhere-')); fs.writeFileSync(path.join(outside, 'x.md'), 'twenty characters or more here');
    const upload = await mount();
    const r = await upload({ filePath: path.join(outside, 'x.md') });
    expect(r.status).toBe(403);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('refuses a binary and a missing file, each with a reason', async () => {
    fs.writeFileSync(path.join(home, 'pic.png'), Buffer.from([0x89, 0x50]));
    const upload = await mount();
    expect((await upload({ filePath: path.join(home, 'pic.png') })).status).toBe(415);
    expect((await upload({ filePath: path.join(home, 'nope.md') })).status).toBe(404);
    expect(fs.existsSync(path.join(vault, 'Reading_Library', 'Uploads'))).toBe(false);
  });
});

// ── /upload from the terminal: the browser sends bytes and a destination ──────
//
// "get rid of upload — unless you can work a popup / file picker and upload
// destination so the user doesn't have to switch out to Files" (CEO,
// 2026-09-07). The terminal opens the OS picker, reads the file, and posts
// { name, contentBase64, dest }. The route writes it into the chosen vault
// folder, indexes it, summarises it — same outcome as the path form.
describe('/upload from the picker (bytes + destination)', () => {
  const b64 = (s) => Buffer.from(s).toString('base64');

  it('writes into the chosen folder, indexes, summarizes', async () => {
    const upload = await mount();
    const r = await upload({ name: 'phish-01.md', contentBase64: b64('# Phish 01\nSpoofed invoice from a lookalike domain, reported by finance.'), dest: 'Reference/Phishing' });
    expect(r.status).toBe(200);
    expect(r.body.file).toBe('Reference/Phishing/phish-01.md');
    expect(fs.existsSync(path.join(vault, 'Reference', 'Phishing', 'phish-01.md'))).toBe(true);
    const idx = JSON.parse(fs.readFileSync(path.join(home, 'AEON', 'data', 'vault_index.json'), 'utf8'));
    expect(idx.documents['Reference/Phishing/phish-01.md']).toBeTruthy();
    expect(r.body.text).toMatch(/Added phish-01\.md to the Second Brain as Reference\/Phishing\/phish-01\.md/);
    expect(llm.mock.calls[0][0]).toMatch(/lookalike domain/);
  });

  it('defaults to Reading_Library/Uploads when no destination is given', async () => {
    const upload = await mount();
    const r = await upload({ name: 'note.txt', contentBase64: b64('a note long enough to be indexed by the brain') });
    expect(r.body.file).toBe('Reading_Library/Uploads/note.txt');
  });

  it('a destination outside the vault is refused; so is a path-shaped name', async () => {
    const upload = await mount();
    expect((await upload({ name: 'x.md', contentBase64: b64('twenty characters or more here'), dest: '../escape' })).status).toBe(400);
    expect((await upload({ name: 'x.md', contentBase64: b64('twenty characters or more here'), dest: '/etc' })).status).toBe(400);
    const r = await upload({ name: '../../evil.md', contentBase64: b64('twenty characters or more here') });
    expect(r.status).toBe(200);
    expect(r.body.file).toBe('Reading_Library/Uploads/evil.md');   // basename only
    expect(fs.existsSync(path.join(home, 'evil.md'))).toBe(false);
  });

  it('a binary picked by mistake is refused by name before anything is written', async () => {
    const upload = await mount();
    const r = await upload({ name: 'shot.png', contentBase64: b64('\x89PNG....') });
    expect(r.status).toBe(415);
    expect(fs.existsSync(path.join(vault, 'Reading_Library'))).toBe(false);
  });

  it('with nothing at all, says how to use it', async () => {
    const upload = await mount();
    const r = await upload({});
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/type \/upload and pick a file/);
  });
});

describe('the folder list behind the destination picker', () => {
  it('lists vault folders, always offers the default, hides chat sessions', async () => {
    fs.mkdirSync(path.join(vault, 'Reference', 'Phishing'), { recursive: true });
    fs.mkdirSync(path.join(vault, 'Agents', 'Aeon', 'chat_sessions'), { recursive: true });
    const router = ingestFactory({ isVercel: false, VAULT_ROOT: vault, DATA_ROOT: path.join(home, 'AEON', 'data'), HOME_ROOT: home, WORKSPACE: path.join(home, 'AEON'), kernelLLM: llm, embed: async () => ({ vector: [0.1], model: 'stub' }) });
    const app = express(); app.use('/api', router);
    const s = await new Promise(r => { const x = app.listen(0, '127.0.0.1', () => r(x)); }); servers.push(s);
    const d = await (await fetch(`http://127.0.0.1:${s.address().port}/api/crn/second-brain/folders`)).json();
    expect(d.default).toBe('Reading_Library/Uploads');
    expect(d.folders).toContain('Reading_Library/Uploads');
    expect(d.folders).toContain('Reference/Phishing');
    expect(d.folders).toContain('Agents/Aeon');
    expect(d.folders).not.toContain('Agents/Aeon/chat_sessions');
  });
});
