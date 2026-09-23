/**
 * host_os: "see this machine's health and restart AEON" — truthfully.
 *
 * Measured 2026-09-23 (agent C4, macOS): POST /api/system/restart answered
 * { success: true, message: 'Restarting AEON Command Center...' }, spawned
 * `cmd.exe /c scripts/restart.bat` — a Windows binary, and a script that does
 * not exist on ANY platform (removed in the repo reorg) — and exited 500 ms
 * later. launch.js exits when its server child exits; nothing relaunches AEON.
 * The header RESTART button then polls /api/health and reloads, so the operator
 * is told AEON is restarting and gets a dead app. settings' own /restart already
 * refuses in this situation (settings.js, BO-SHIP P8f); host_os did not.
 *
 * There was also no way to see this machine's health: /api/health is a liveness
 * ping (status, uptime), and host_os has no screen.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-hostos-sys-'));
const SAVED = { VAULT_PATH: process.env.VAULT_PATH, DATA_PATH: process.env.DATA_PATH, AEON_SECRETS_DIR: process.env.AEON_SECRETS_DIR };
process.env.VAULT_PATH = path.join(TMP, 'vault');
process.env.DATA_PATH = path.join(TMP, 'data');
process.env.AEON_SECRETS_DIR = path.join(TMP, 'secrets');
const createSystemRouter = require('../src/blocks/host_os/api/system.cjs');

const SUPERVISOR_VARS = ['AEON_SUPERVISED', 'PM2_HOME', 'NODEMON'];
let savedSup, exitSpy, servers;
beforeEach(() => {
  savedSup = Object.fromEntries(SUPERVISOR_VARS.map((k) => [k, process.env[k]]));
  for (const k of SUPERVISOR_VARS) delete process.env[k];
  // The old route called process.exit(0) 500 ms after answering — inside a
  // test worker that would kill the run. Record it instead.
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
  servers = [];
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedSup)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  exitSpy.mockRestore();
  for (const s of servers) { try { s.close(); } catch {} }
});
afterAll(() => {
  for (const [k, v] of Object.entries(SAVED)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(TMP, { recursive: true, force: true });
});

async function mount() {
  const router = createSystemRouter({
    requireShellAuth: (req, res, next) => next(), // an authorized operator
    supabase: null, isVercel: false,
    SDI_SCHEMAS: {}, validateSDI: () => ({}), SDI_VIOLATION_LOG: path.join(TMP, 'sdi.json'),
    getDataFile: (n) => path.join(TMP, 'data', n), VAULT_ROOT: path.join(TMP, 'vault'),
  });
  const app = express(); app.use(express.json()); app.use('/api', router);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}/api`;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('POST /api/system/restart', () => {
  it('refuses, and stays up, when nothing would bring AEON back', async () => {
    const base = await mount();
    const res = await fetch(`${base}/system/restart`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const body = await res.json();
    expect(res.status).toBe(501);
    expect(body.ok).toBe(false);
    expect(body.restarting).toBe(false);
    expect(body.error).toMatch(/cannot restart itself/i);
    expect(body.remedy).toMatch(/launch/i);
    await sleep(700);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('restarts only when a supervisor is present, and names it', async () => {
    process.env.AEON_SUPERVISED = '1';
    const base = await mount();
    const res = await fetch(`${base}/system/restart`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.restarting).toBe(true);
    expect(body.via).toBe('supervisor');
    await sleep(700);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

describe('GET /api/system/health — this machine and this AEON, in one read', () => {
  it('reports the machine, the AEON process, and whether a restart is possible', async () => {
    const base = await mount();
    const res = await fetch(`${base}/system/health`);
    expect(res.status).toBe(200);
    const h = await res.json();
    expect(h.ok).toBe(true);
    expect(h.machine.platform).toBe(process.platform);
    expect(h.machine.cpuThreads).toBe(os.cpus().length);
    expect(h.machine.totalMemGb).toBeGreaterThan(0);
    expect(h.aeon.pid).toBe(process.pid);
    expect(h.aeon.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(h.aeon.node).toBe(process.version);
    expect(h.restart.canRestart).toBe(false);
    expect(h.restart.reason).toMatch(/cannot restart itself/i);
    if (process.platform === 'darwin') expect(h.machine.freeMemNote).toMatch(/macOS/);
  });
});
