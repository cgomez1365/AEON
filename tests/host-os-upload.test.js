/**
 * The File Manager's upload obeys the same two rules as every other /api/fs
 * route: the add-only lock, and the credential/shell-config refusal list.
 *
 * Measured live 2026-09-23 (agent C4, macOS, isolated home, lock ON):
 *  - /api/fs/write refused to overwrite Vault/Agents/keep.md (423), and
 *    /api/fs/upload of a file named keep.md into the same folder replaced it —
 *    "ORIGINAL operator text" was gone. Add-only mode was an add-and-overwrite
 *    mode for anything that arrived by upload.
 *  - /api/fs/read refused Vault/.ssh/… by name ("holds credentials"), and
 *    /api/fs/upload wrote into Vault/.ssh/ without complaint. On a real machine
 *    the same request reaches ~/.ssh (authorized_keys) or
 *    ~/Library/LaunchAgents (runs at next login): the uploader's own boundary
 *    was only "inside home/workspace/vault".
 *  - An upload with no folder went to the workspace while the listing it was
 *    started from showed the Vault.
 *
 * Old-code reproduction: `deps.upload` here is built exactly like
 * services/storage.js's (targetDir -> destination, basename filename), which is
 * what fs.cjs used before it owned its upload storage.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const multer = require('multer');
const createFsRouter = require('../src/blocks/host_os/api/fs.cjs');

let tmp, dirs, server, base;

function servicesStyleUpload() {
  // The shape of services/storage.js `upload` (roots check only, no refusal
  // list, no lock, '' -> WORKSPACE, silent overwrite).
  return multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const t = typeof req.body.targetDir === 'string' ? req.body.targetDir.trim() : '';
        const dest = t ? path.resolve(t) : dirs.ws;
        const inside = [dirs.home, dirs.ws, dirs.vault].some((r) => dest === r || dest.startsWith(r + path.sep));
        if (!inside) return cb(new Error('outside'));
        fs.mkdirSync(dest, { recursive: true }); cb(null, dest);
      },
      filename: (req, file, cb) => cb(null, path.basename(file.originalname)),
    }),
    limits: { fileSize: 50 * 1024 * 1024, files: 20 },
  });
}

beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-hostos-up-')));
  dirs = { home: path.join(tmp, 'home'), ws: path.join(tmp, 'home', 'AEON'), vault: path.join(tmp, 'home', 'AEON', 'Vault') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const router = createFsRouter({
    isVercel: false, WORKSPACE: dirs.ws, VAULT_ROOT: dirs.vault, HOME_ROOT: dirs.home,
    getDataFile: (n) => path.join(tmp, 'data', n), upload: servicesStyleUpload(), writeOSAudit: () => {},
  });
  const app = express(); app.use(express.json()); app.use('/api', router);
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
afterEach(() => { try { server.close(); } catch {} fs.rmSync(tmp, { recursive: true, force: true }); });

async function upload(targetDir, name, content) {
  const fd = new FormData();
  fd.append('targetDir', targetDir);
  fd.append('files', new Blob([content]), name);
  const res = await fetch(`${base}/fs/upload`, { method: 'POST', body: fd });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe('POST /api/fs/upload', () => {
  it('in add-only mode, never replaces a file that is already there', async () => {
    const keep = path.join(dirs.vault, 'keep.md');
    fs.writeFileSync(keep, 'ORIGINAL operator text');
    const r = await upload(dirs.vault, 'keep.md', 'replaced by upload');
    expect(r.status).toBe(423);
    expect(r.body.error).toMatch(/already exists|add-only/i);
    expect(fs.readFileSync(keep, 'utf8')).toBe('ORIGINAL operator text');
  });

  it('when unlocked (full edit), replacing is the operator\'s call and is allowed', async () => {
    await fetch(`${base}/fs/lock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"locked":false}' });
    const keep = path.join(dirs.vault, 'keep.md');
    fs.writeFileSync(keep, 'ORIGINAL');
    const r = await upload(dirs.vault, 'keep.md', 'new version');
    expect(r.status).toBe(200);
    expect(fs.readFileSync(keep, 'utf8')).toBe('new version');
  });

  it('refuses credential and shell-config folders by name, and writes nothing there', async () => {
    const r = await upload(path.join(dirs.vault, '.ssh'), 'authorized_keys', 'ssh-ed25519 AAAA fake');
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/\.ssh/);
    expect(fs.existsSync(path.join(dirs.vault, '.ssh', 'authorized_keys'))).toBe(false);
    const r2 = await upload(path.join(dirs.home, 'Library', 'LaunchAgents'), 'x.plist', '<plist/>');
    expect(r2.status).toBe(403);
    expect(fs.existsSync(path.join(dirs.home, 'Library', 'LaunchAgents', 'x.plist'))).toBe(false);
  });

  it('refuses a denied file NAME too (an upload called .env)', async () => {
    const r = await upload(dirs.vault, '.env', 'KEY=fake');
    expect(r.status).toBe(403);
    expect(fs.existsSync(path.join(dirs.vault, '.env'))).toBe(false);
  });

  it('with no folder, lands where the listing lands (the Vault), not the workspace', async () => {
    const r = await upload('', 'note.txt', 'hello');
    expect(r.status).toBe(200);
    expect(fs.existsSync(path.join(dirs.vault, 'note.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dirs.ws, 'note.txt'))).toBe(false);
  });

  it('a new file into a browsed folder still works while locked (adding is allowed)', async () => {
    const r = await upload(dirs.vault, 'fresh.txt', 'new');
    expect(r.status).toBe(200);
    expect(r.body.uploaded[0].path).toBe(path.join(dirs.vault, 'fresh.txt'));
  });
});
