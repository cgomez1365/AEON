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
