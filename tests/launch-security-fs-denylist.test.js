/**
 * The File Manager's credential deny-list holds on a case-insensitive disk.
 *
 * Audit A056, reproduced on fe93dbf: safePath() compared path segments with
 * `===`, so on macOS (APFS, case-insensitive by default), Windows (NTFS) and the
 * carried drive (exFAT) a request for `.SSH/id_ed25519` opened `.ssh/id_ed25519`
 * and was served, `AEON/.ENV` served the vault master key, and a write to
 * `Library/launchagents/` planted a login item, while the exact-case spellings
 * were refused. APFS also folds `ß` to `ss` and `ſ` to `s` (measured on the
 * CEO's iMac, 2026-09-30: `.ßh` and `.ſsh` both open `.ssh`), so lower-casing
 * alone is not the whole fix.
 *
 * The router is mounted over a temp home; nothing outside it is read or written.
 * On a case-sensitive disk (most Linux CI) the variant spellings are different
 * folders. They must still be refused there (no one needs `.SSH`, and exFAT on
 * Linux folds case too), so the refusals are asserted everywhere; the "served
 * the real key" half of the original defect only exists where the disk folds.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const iso = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-ls-fs-iso-'));
process.env.AEON_HOME = path.join(iso, 'home');
process.env.AEON_SECRETS_DIR = path.join(iso, 'secrets');
process.env.AEON_ENV_FILE = path.join(iso, '.env');
const createFsRouter = require('../src/blocks/host_os/api/fs.cjs');

let root, server, base;
beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-ls-fs-')));
  fs.mkdirSync(path.join(root, '.ssh'));
  fs.writeFileSync(path.join(root, '.ssh', 'id_ed25519'), 'PRIVATE-KEY-BYTES');
  fs.mkdirSync(path.join(root, 'AEON'));
  fs.writeFileSync(path.join(root, 'AEON', '.env'), 'AEON_VAULT_MASTER_KEY=deadbeef');
  fs.mkdirSync(path.join(root, 'Library', 'LaunchAgents'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Documents'));
  fs.writeFileSync(path.join(root, 'Documents', 'notes.txt'), 'hello');
  const router = createFsRouter({
    isVercel: false, WORKSPACE: root, HOME_ROOT: root, VAULT_ROOT: path.join(root, 'Vault'),
    getDataFile: (n) => path.join(root, 'data', n),
  });
  const app = express(); app.use(express.json()); app.use('/api', router);
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}/api/fs`;
});
afterEach(() => { try { server.close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); });

const serve = async (rel) => {
  const r = await fetch(`${base}/serve?path=${encodeURIComponent(path.join(root, rel))}`);
  return { status: r.status, text: await r.text() };
};
const write = async (rel, content = 'x') => {
  // Unlocked, so a refusal can only come from the deny-list, not the add-only lock.
  await fetch(`${base}/lock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ locked: false }) });
  const r = await fetch(`${base}/write`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filePath: path.join(root, rel), content }) });
  return { status: r.status, body: await r.json() };
};

describe('File Manager deny-list ignores the spelling of a denied folder', () => {
  it('the exact spelling is refused (unchanged)', async () => {
    expect((await serve('.ssh/id_ed25519')).status).toBe(403);
    expect((await serve('AEON/.env')).status).toBe(403);
  });

  it.each([
    ['.SSH/id_ed25519'],
    ['.Ssh/id_ed25519'],
    ['.ßh/id_ed25519'],     // APFS folds ß to ss
    ['.ſsh/id_ed25519'],    // and ſ (long s) to s
    ['AEON/.ENV'],
    ['AEON/.Env'],
  ])('refuses %s and never returns the secret', async (rel) => {
    const r = await serve(rel);
    expect(r.status).toBe(403);
    expect(r.text).not.toMatch(/PRIVATE-KEY-BYTES|AEON_VAULT_MASTER_KEY/);
    expect(JSON.parse(r.text).blocked).toBe(true);
  });

  it('Windows path normalisation spellings (trailing dot / space) are refused too', async () => {
    expect((await serve('.ssh./id_ed25519')).status).toBe(403);
    expect((await serve('.ssh /id_ed25519')).status).toBe(403);
    expect((await serve('AEON/.env.')).status).toBe(403);
  });

  it('a login item cannot be planted under a re-cased LaunchAgents', async () => {
    const r = await write('Library/launchagents/com.evil.plist', '<plist/>');
    expect(r.status).toBe(403);
    expect(r.body.blocked).toBe(true);
    expect(fs.readdirSync(path.join(root, 'Library', 'LaunchAgents'))).toEqual([]);
  });

  it('ordinary files are still served, and names that only contain a denied word are not refused', async () => {
    expect((await serve('Documents/notes.txt')).text).toBe('hello');
    fs.writeFileSync(path.join(root, 'Documents', 'MY.ENV.notes'), 'fine');
    expect((await serve('Documents/MY.ENV.notes')).text).toBe('fine');
  });

  it('a symlink inside the home that points at a denied folder is refused (the disk is asked)', async () => {
    try { fs.symlinkSync(path.join(root, '.ssh'), path.join(root, 'Documents', 'keys')); }
    catch { return; } // Windows without the symlink privilege: nothing to test here
    const r = await serve('Documents/keys/id_ed25519');
    expect(r.status).toBe(403);
    expect(r.text).not.toMatch(/PRIVATE-KEY-BYTES/);
  });
});
