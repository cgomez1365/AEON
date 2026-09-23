/**
 * Cookbook "Stop" must actually stop what Cookbook started.
 *
 * Measured 2026-09-23 on macOS: POST /api/cookbook/task-stop/:id ran
 * `taskkill /F /T /PID <pid>` — a Windows-only binary. On macOS and Linux the
 * spawn failed, the failure was swallowed, the task was marked "stopped" and the
 * route answered { ok: true }. The serve process (llama-server bound to
 * 0.0.0.0:8080) kept running with nothing left in AEON that knew it existed.
 *
 * The serve/download children are spawned `detached: true`, which on POSIX makes
 * each one the leader of its own process group. Stopping it means signalling the
 * GROUP (negative pid) so a serve's own children go too — the same thing
 * `taskkill /T` does for the tree on Windows.
 *
 * This drives the real route with a real child (node is on the serve allowlist):
 * the child spawns a grandchild, both PIDs are recorded, Stop is pressed, and
 * both must be gone. A second case covers the in-process installers, which have
 * no PID and cannot be cancelled: Stop must say so instead of claiming success.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const createCookbookRouter = require('../src/blocks/cookbook/api/index.cjs');

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000, step = 50) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(step); }
  return fn();
}

let root, servers;
const strays = new Set(); // every pid this file creates, killed in afterAll whatever happens

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-cbstop-'));
  servers = [];
});
afterEach(() => {
  for (const s of servers) { try { s.close(); } catch {} }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});
afterAll(() => {
  for (const pid of strays) { try { process.kill(pid, 'SIGKILL'); } catch {} }
});

async function mount(extraDeps = {}) {
  const router = createCookbookRouter({
    isVercel: false, VAULT_ROOT: root, DATA_ROOT: path.join(root, 'data'),
    getDataFile: (n) => path.join(root, 'data', n), writeOSAudit: () => {},
    ...extraDeps,
  });
  const app = express(); app.use(express.json()); app.use('/api', router);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  servers.push(server);
  return server.address().port;
}
const post = async (port, route, body) => {
  const r = await fetch(`http://127.0.0.1:${port}/api${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  return { status: r.status, body: await r.json() };
};

describe.skipIf(process.platform === 'win32')('cookbook task-stop on macOS/Linux', () => {
  it('stops the serve process AND its children, and says so truthfully', async () => {
    // A stand-in for llama-server: a long-running process with a child of its
    // own. The path is an existing file, which is serve's documented escape
    // hatch for "a model path no registry knows about".
    const pidsFile = path.join(root, 'pids.json');
    const script = path.join(root, 'fake-server.js');
    fs.writeFileSync(script, [
      "const { spawn } = require('child_process');",
      "const kid = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });",
      `require('fs').writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify({ parent: process.pid, child: kid.pid }));`,
      "setInterval(()=>{},1000);",
    ].join('\n'));

    const port = await mount();
    const started = await post(port, '/model/serve', { repo_id: 'fake/server', cmd: `node ${script}`, force: true });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body.ok).toBe(true);

    const pids = await waitFor(() => fs.existsSync(pidsFile) && JSON.parse(fs.readFileSync(pidsFile, 'utf8')));
    expect(pids, 'the fake server never started').toBeTruthy();
    strays.add(pids.parent); strays.add(pids.child);
    expect(alive(pids.parent)).toBe(true);
    expect(alive(pids.child)).toBe(true);

    const stop = await post(port, `/cookbook/task-stop/${started.body.session_id}`);
    expect(stop.body.ok, JSON.stringify(stop.body)).toBe(true);

    // Both must actually be gone — the parent AND the grandchild.
    const gone = await waitFor(() => !alive(pids.parent) && !alive(pids.child), 6000);
    expect(alive(pids.parent), 'serve process still running after Stop').toBe(false);
    expect(alive(pids.child), "serve process's child still running after Stop").toBe(false);
    expect(gone).toBe(true);

    const status = await (await fetch(`http://127.0.0.1:${port}/api/cookbook/tasks/status`)).json();
    const task = status.tasks.find((t) => t.session_id === started.body.session_id);
    expect(task.status).toBe('stopped');
  }, 20000);

  it('an in-process install has no process to stop — Stop says so instead of "ok"', async () => {
    // The catalogue installer runs inside AEON (no PID, no abort signal). The
    // old route marked it "stopped" and answered ok:true while the download
    // carried on and later flipped the task to "done".
    let release;
    const gate = new Promise((r) => { release = r; });
    const registry = {
      file: path.join(root, 'data', 'local-runtime', 'local-runtime.json'),
      activeRuntime: () => ({ id: 'stub' }), readyModels: () => [], modelsForCapability: () => [],
    };
    const port = await mount({
      getLocalRuntimeRegistry: () => registry,
      localInstallers: {
        runtime: { installRuntime: async () => ({}) },
        model: { installModel: () => gate, listCatalog: () => [] },
      },
    });
    const started = await post(port, '/model/download', { repo_id: 'nomic-embed-text-q8' });
    expect(started.body.ok).toBe(true);

    const stop = await post(port, `/cookbook/task-stop/${started.body.session_id}`);
    expect(stop.status).toBe(409);
    expect(stop.body.ok).toBe(false);
    expect(stop.body.error).toMatch(/cannot be stopped|cannot be cancelled/i);
    release();
  });

  it('a task that already ended is not signalled again (its PID may belong to someone else now)', async () => {
    const script = path.join(root, 'quick.js');
    fs.writeFileSync(script, 'process.exit(0)');
    const port = await mount();
    const started = await post(port, '/model/serve', { repo_id: 'fake/quick', cmd: `node ${script}`, force: true });
    expect(started.body.ok).toBe(true);
    await sleep(700);
    const stop = await post(port, `/cookbook/task-stop/${started.body.session_id}`);
    expect(stop.body.ok).toBe(true);
    expect(stop.body.alreadyExited).toBe(true);
  });
});
