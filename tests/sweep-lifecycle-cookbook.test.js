/**
 * Cookbook serve and task registry (sweeps C18 and C27, 2026-09-28).
 *
 * C27 — the task registry was a `{}` in the router factory. Every block rescan
 *   (Remove, Restore or Start of ANY block, a store install or update) purges
 *   the module and calls the factory again, so the remounted Cookbook forgot
 *   every running download and serve while the detached processes carried on:
 *   status stopped listing them, Stop answered 404, kill-pid refused the pid.
 * C18 — the Models tab's Serve button sent `llama-server --model "Org/Repo-GGUF"
 *   --host 0.0.0.0`: a repo id where llama-server needs a .gguf path, and a
 *   model server with no login on every network interface.
 *
 * Real routes, real child processes. The "llama-server" and "vllm" here are
 * stand-in scripts that record the argv they were given; nothing is downloaded.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const API = require.resolve('../src/blocks/cookbook/api/index.cjs');
const UI = path.join(path.dirname(API), '..', 'index.jsx');

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(50); }
  return fn();
}

// A cache model dir would otherwise come from the host's own settings.
const savedEnv = { AEON_MODELS_DIR: process.env.AEON_MODELS_DIR, HF_HOME: process.env.HF_HOME };
delete process.env.AEON_MODELS_DIR;
delete process.env.HF_HOME;

let root, servers;
const strays = new Set();
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-sweep-cookbook-'))); servers = []; });
afterEach(() => {
  for (const s of servers) { try { s.close(); } catch {} }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});
afterAll(() => {
  for (const pid of strays) { try { process.kill(-pid, 'SIGKILL'); } catch {} try { process.kill(pid, 'SIGKILL'); } catch {} }
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

/** Mount a FRESH copy of the module — what blockHost.rescan() does. */
async function mount() {
  for (const k of Object.keys(require.cache)) if (k.startsWith(path.dirname(API) + path.sep)) delete require.cache[k];
  const router = require(API)({
    isVercel: false, VAULT_ROOT: root, DATA_ROOT: path.join(root, 'data'),
    getDataFile: (n) => path.join(root, 'data', n), writeOSAudit: () => {},
  });
  const app = express(); app.use(express.json()); app.use('/api', router);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  servers.push(server);
  const port = server.address().port;
  return {
    post: async (route, body) => {
      const r = await fetch(`http://127.0.0.1:${port}/api${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
      });
      return { status: r.status, body: await r.json() };
    },
    get: async (route) => (await fetch(`http://127.0.0.1:${port}/api${route}`)).json(),
  };
}

/** A stand-in server binary named `name` that writes its argv to argv.json. */
function fakeBinary(name, { stay = false } = {}) {
  const p = path.join(root, 'bin', name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, [
    `#!${process.execPath}`,
    `require('fs').writeFileSync(${JSON.stringify(path.join(root, 'argv.json'))}, JSON.stringify(process.argv.slice(2)));`,
    stay ? 'setInterval(() => {}, 1000);' : '',
  ].join('\n'));
  fs.chmodSync(p, 0o755);
  return p;
}
const argvSeen = () => waitFor(() => fs.existsSync(path.join(root, 'argv.json')) && JSON.parse(fs.readFileSync(path.join(root, 'argv.json'), 'utf8')));

/** A Hugging Face cache entry, as `hf download` leaves it, with these .gguf files. */
function cachedRepo(repo, files) {
  const snap = path.join(root, 'data', 'cookbook', 'models', 'hub', `models--${repo.replace('/', '--')}`, 'snapshots', 'abc123');
  fs.mkdirSync(snap, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(snap, f), 'GGUF');
  return snap;
}

/** Start a long-running serve (a stand-in process) and return its session and pid. */
async function startLong(cb) {
  const script = path.join(root, 'long-serve.js');
  fs.writeFileSync(script, 'setInterval(() => {}, 1000);');
  const started = await cb.post('/model/serve', { repo_id: 'fake/long', cmd: `node ${script}`, force: true });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const sid = started.body.session_id;
  const pid = Number(fs.readFileSync(path.join(root, 'data', 'cookbook', 'logs', `${sid}.pid`), 'utf8'));
  strays.add(pid);
  return { sid, pid };
}

describe.skipIf(process.platform === 'win32')('Cookbook tasks survive a rescan (C27)', () => {
  it('the remounted Cookbook still lists a running serve, and its Stop stops it', async () => {
    const before = await mount();
    const { sid, pid } = await startLong(before);
    expect((await before.get('/cookbook/tasks/status')).tasks.find((t) => t.session_id === sid)).toBeTruthy();

    const after = await mount(); // a rescan: module purged, factory called again
    const task = (await after.get('/cookbook/tasks/status')).tasks.find((t) => t.session_id === sid);
    expect(task, 'the remount forgot a serve that is still running').toBeTruthy();
    expect(task.status).toBe('running');

    const stop = await after.post(`/cookbook/task-stop/${sid}`);
    expect(stop.status, JSON.stringify(stop.body)).toBe(200);
    expect(stop.body.stopped).toBe(true);
    expect(await waitFor(() => !alive(pid), 6000)).toBe(true);
  }, 20000);

  it('kill-pid on the remounted Cookbook still recognises its own task', async () => {
    const { pid } = await startLong(await mount());
    const after = await mount();
    const r = await after.post('/cookbook/kill-pid', { pid });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await waitFor(() => !alive(pid), 6000)).toBe(true);
  }, 20000);
});

describe.skipIf(process.platform === 'win32')('Serve runs a model file, on loopback (C18)', () => {
  it('resolves a cached repo id to its .gguf file before llama-server sees it', async () => {
    const snap = cachedRepo('aeon-sweep/Tiny-GGUF', ['tiny-Q4_K_M.gguf', 'mmproj-tiny-f16.gguf']);
    const bin = fakeBinary('llama-server');
    const cb = await mount();
    const r = await cb.post('/model/serve', {
      repo_id: 'aeon-sweep/Tiny-GGUF',
      cmd: `${bin} --model "aeon-sweep/Tiny-GGUF" --host 127.0.0.1 --port 8080 -ngl 99 -c 8192`,
      force: true,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const argv = await argvSeen();
    expect(argv[argv.indexOf('--model') + 1]).toBe(path.join(snap, 'tiny-Q4_K_M.gguf'));
  }, 20000);

  // Cookbook's Download fetches every *.gguf in a repo, so several builds is the
  // usual case: listed, never guessed between, and the operator's choice comes
  // back by file name (the Serve chooser) and is what llama-server opens.
  it('lists the builds of a repo holding several, and serves the one chosen', async () => {
    const snap = cachedRepo('aeon-sweep/Two-GGUF', ['two-Q4_K_M.gguf', 'two-Q8_0.gguf', 'mmproj-two-f16.gguf']);
    const bin = fakeBinary('llama-server');
    const cb = await mount();
    const cmd = `${bin} --model "aeon-sweep/Two-GGUF" --host 127.0.0.1 --port 8080`;
    const r = await cb.post('/model/serve', { repo_id: 'aeon-sweep/Two-GGUF', cmd, force: true });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('gguf_ambiguous');
    expect(r.body.builds).toEqual([
      { file: 'two-Q4_K_M.gguf', quant: 'Q4_K_M', size_bytes: 4 },
      { file: 'two-Q8_0.gguf', quant: 'Q8_0', size_bytes: 4 },
    ]);
    expect(r.body.error).toMatch(/Choose the one to serve/);
    await sleep(300);
    expect(fs.existsSync(path.join(root, 'argv.json'))).toBe(false);

    const chosen = await cb.post('/model/serve', { repo_id: 'aeon-sweep/Two-GGUF', cmd, gguf: r.body.builds[1].file, force: true });
    expect(chosen.status, JSON.stringify(chosen.body)).toBe(200);
    const argv = await argvSeen();
    expect(argv[argv.indexOf('--model') + 1]).toBe(path.join(snap, 'two-Q8_0.gguf'));
  }, 20000);

  it('refuses a chosen build the repo does not hold, and a choice with no cached repo', async () => {
    cachedRepo('aeon-sweep/Two-GGUF', ['two-Q4_K_M.gguf', 'two-Q8_0.gguf']);
    const bin = fakeBinary('llama-server');
    const cb = await mount();
    const missing = await cb.post('/model/serve', {
      repo_id: 'aeon-sweep/Two-GGUF', cmd: `${bin} --model "aeon-sweep/Two-GGUF" --host 127.0.0.1`,
      gguf: '../../../../elsewhere.gguf', force: true,
    });
    expect(missing.status).toBe(409);
    expect(missing.body.code).toBe('gguf_not_found');
    expect(missing.body.builds.map((b) => b.file)).toEqual(['two-Q4_K_M.gguf', 'two-Q8_0.gguf']);

    const stray = await cb.post('/model/serve', {
      repo_id: 'nobody/Else', cmd: `${bin} --model "nobody/Else" --host 127.0.0.1`, gguf: 'two-Q8_0.gguf', force: true,
    });
    expect(stray.status).toBe(400);
    expect(stray.body.code).toBe('gguf_not_applicable');
    await sleep(300);
    expect(fs.existsSync(path.join(root, 'argv.json'))).toBe(false);
  });

  it('refuses a model server on every interface, by name', async () => {
    const snap = cachedRepo('aeon-sweep/Tiny-GGUF', ['tiny-Q4_K_M.gguf']);
    const bin = fakeBinary('llama-server');
    const cb = await mount();
    for (const host of ['--host 0.0.0.0', '--host=0.0.0.0', '--host 192.168.1.20']) {
      const r = await cb.post('/model/serve', {
        repo_id: 'aeon-sweep/Tiny-GGUF', cmd: `${bin} --model "${path.join(snap, 'tiny-Q4_K_M.gguf')}" ${host} --port 8080`, force: true,
      });
      expect(r.status, host).toBe(400);
      expect(r.body.code).toBe('host_not_loopback');
      expect(r.body.error).toMatch(/127\.0\.0\.1/);
    }
    await sleep(300);
    expect(fs.existsSync(path.join(root, 'argv.json'))).toBe(false);
  });

  it('gives vLLM --host 127.0.0.1 when none is set (its default is every interface)', async () => {
    const snap = cachedRepo('aeon-sweep/Tiny-GGUF', ['tiny-Q4_K_M.gguf']);
    const bin = fakeBinary('vllm');
    const cb = await mount();
    const r = await cb.post('/model/serve', {
      repo_id: 'aeon-sweep/Tiny-GGUF', cmd: `${bin} serve ${snap} --port 8000`, force: true,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const argv = await argvSeen();
    expect(argv.slice(argv.indexOf('--host'), argv.indexOf('--host') + 2)).toEqual(['--host', '127.0.0.1']);
  }, 20000);

  it('the Serve button builds loopback commands, and offers the builds to choose from', () => {
    const ui = fs.readFileSync(UI, 'utf8');
    const quickServe = ui.slice(ui.indexOf('async function quickServe'), ui.indexOf('async function stopTask'))
      .replace(/^\s*\/\/.*$/gm, ''); // what it sends, not what its comments say
    expect(quickServe).not.toMatch(/0\.0\.0\.0/);
    expect(quickServe.match(/--host 127\.0\.0\.1/g)).toHaveLength(2);
    // A 409 listing builds opens the chooser; a pick is re-sent as `gguf`.
    expect(quickServe).toMatch(/data\.code === 'gguf_ambiguous'/);
    expect(quickServe).toMatch(/setServePick\(\{ model, repo, builds: data\.builds/);
    expect(quickServe).toMatch(/\.\.\.\(gguf \? \{ gguf \} : \{\}\)/);
    expect(ui).toMatch(/onClick=\{\(\) => quickServe\(servePick\.model, b\.file\)\}/);
  });
});
