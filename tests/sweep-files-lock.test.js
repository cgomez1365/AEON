/**
 * The File Manager's lock answer is the lock enforcement reads.
 *
 * Sweep finding C45, reproduced on b6fd6b3: writeLock() ended in `catch {}` and
 * POST /api/fs/lock answered {ok:true, locked} with the value it was asked for.
 * A failed write (read-only mount, a drive error on the carried exFAT volume)
 * therefore showed "Add-only" while rename/delete/overwrite stayed allowed, or
 * "Full edit" while the next delete came back 423 with no explanation — and the
 * audit log recorded a change that never happened.
 *
 * The write failure is simulated by making fs.writeFileSync throw EROFS for the
 * lock file only — the same module object fs.cjs calls, so no disk is mounted
 * read-only and nothing outside the temp folder is touched.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const iso = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-sweep-lock-iso-'));
const savedEnv = { AEON_HOME: process.env.AEON_HOME, AEON_SECRETS_DIR: process.env.AEON_SECRETS_DIR, AEON_ENV_FILE: process.env.AEON_ENV_FILE };
process.env.AEON_HOME = path.join(iso, 'home');
process.env.AEON_SECRETS_DIR = path.join(iso, 'secrets');
process.env.AEON_ENV_FILE = path.join(iso, '.env');
const createFsRouter = require('../src/blocks/host_os/api/fs.cjs');

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

let root, server, base, audit, lockFile;
beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-sweep-lock-')));
  lockFile = path.join(root, 'data', 'host_os', 'fs-lock.json');
  audit = [];
  const router = createFsRouter({
    isVercel: false, WORKSPACE: root, HOME_ROOT: root, VAULT_ROOT: path.join(root, 'Vault'),
    getDataFile: (n) => path.join(root, 'data', n),
    writeOSAudit: (type, detail, status) => audit.push({ type, detail, status }),
  });
  const app = express(); app.use(express.json()); app.use('/api', router);
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}/api/fs`;
});
afterEach(() => { vi.restoreAllMocks(); try { server.close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); });

const call = async (route, body) => {
  const r = await fetch(`${base}/${route}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, ok: r.ok, body: await r.json() };
};
function failLockWrites() {
  const real = fs.writeFileSync;
  vi.spyOn(fs, 'writeFileSync').mockImplementation((p, ...rest) => {
    if (String(p) === lockFile) throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' });
    return real.call(fs, p, ...rest);
  });
}

describe('POST /api/fs/lock when the lock file cannot be written', () => {
  it('an unlock that did not persist says so, and reports the hub still locked', async () => {
    failLockWrites();
    const r = await call('lock', { locked: false });
    expect(r.status).toBe(500);
    expect(r.body.ok).toBe(false);
    expect(r.body.locked).toBe(true);
    expect(r.body.error).toMatch(/Could not unlock.*EROFS.*still locked/);
    expect((await call('lock')).body.locked).toBe(true);
    expect(audit.some((a) => a.type === 'FS_LOCK')).toBe(false); // no claim of a change
    expect(audit.find((a) => a.type === 'FS_LOCK_FAILED')).toBeTruthy();
  });

  it('a lock that did not persist reports the hub still UNLOCKED — rename and delete really are still allowed', async () => {
    expect((await call('lock', { locked: false })).body.locked).toBe(false); // persisted unlocked
    failLockWrites();
    const r = await call('lock', { locked: true });
    expect(r.status).toBe(500);
    expect(r.body.locked).toBe(false);
    expect(r.body.error).toMatch(/Could not lock.*still UNLOCKED/);
    expect(JSON.parse(fs.readFileSync(lockFile, 'utf8')).locked).toBe(false);
  });

  it('a lock change that persisted answers with the state read back from disk', async () => {
    const r = await call('lock', { locked: false });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, locked: false });
    expect((await call('lock')).body.locked).toBe(false);
    expect(audit.find((a) => a.type === 'FS_LOCK').detail).toMatch(/UNLOCKED/);
    expect((await call('lock', { locked: true })).body).toEqual({ ok: true, locked: true });
  });
});

describe('the Files screen shows the lock it was told, and a failure as a failure', () => {
  it('a 500 keeps the badge on the real state and shows the error, not a success line', () => {
    const out = ui.lockOutcome(false, { ok: false, locked: true, error: 'Could not unlock the File Manager: EROFS. It is still locked (add-only).' });
    expect(out.locked).toBe(true);
    expect(out.status).toMatch(/^❌ Could not unlock/);
  });
  it('success follows the answer', () => {
    expect(ui.lockOutcome(true, { ok: true, locked: false })).toMatchObject({ locked: false, status: expect.stringMatching(/Full edit/) });
    expect(ui.lockOutcome(true, { ok: true, locked: true })).toMatchObject({ locked: true, status: expect.stringMatching(/Add-only/) });
  });
  it('an unreadable answer is treated as locked (the safe default)', () => {
    expect(ui.lockOutcome(false, null)).toMatchObject({ locked: true, status: expect.stringMatching(/^❌/) });
  });
});
