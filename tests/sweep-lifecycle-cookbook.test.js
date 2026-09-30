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
  // A test reads the argv of ITS binary: the previous test's argv.json must
  // not answer first (seen as a flake under full-suite load).
  fs.rmSync(path.join(root, 'argv.json'), { force: true });
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
// A half-written argv.json is "not yet", not a failure.
const argvSeen = () => waitFor(() => {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'argv.json'), 'utf8')); } catch { return false; }
});

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
    // llama-server reads the same address from LLAMA_ARG_HOST.
    const viaEnv = await cb.post('/model/serve', {
      repo_id: 'aeon-sweep/Tiny-GGUF', cmd: `LLAMA_ARG_HOST=0.0.0.0 ${bin} --model "${path.join(snap, 'tiny-Q4_K_M.gguf')}" --port 8080`, force: true,
    });
    expect(viaEnv.status).toBe(400);
    expect(viaEnv.body.code).toBe('host_not_loopback');
    expect(viaEnv.body.error).toMatch(/LLAMA_ARG_HOST=0\.0\.0\.0/);
    await sleep(300);
    expect(fs.existsSync(path.join(root, 'argv.json'))).toBe(false);
  });

  it('drops a network LLAMA_ARG_HOST the server inherited, so llama-server binds loopback', async () => {
    const snap = cachedRepo('aeon-sweep/Tiny-GGUF', ['tiny-Q4_K_M.gguf']);
    const p = path.join(root, 'bin', 'llama-server');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, [
      `#!${process.execPath}`,
      `require('fs').writeFileSync(${JSON.stringify(path.join(root, 'argv.json'))}, JSON.stringify({ host: process.env.LLAMA_ARG_HOST ?? null }));`,
    ].join('\n'));
    fs.chmodSync(p, 0o755);
    const saved = process.env.LLAMA_ARG_HOST;
    process.env.LLAMA_ARG_HOST = '0.0.0.0';
    try {
      const cb = await mount();
      const r = await cb.post('/model/serve', {
        repo_id: 'aeon-sweep/Tiny-GGUF', cmd: `${p} --model "${path.join(snap, 'tiny-Q4_K_M.gguf')}" --port 8080`, force: true,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect((await argvSeen()).host).toBe(null);
    } finally {
      if (saved === undefined) delete process.env.LLAMA_ARG_HOST; else process.env.LLAMA_ARG_HOST = saved;
    }
  }, 20000);

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

// The VRAM gate judged the REPO id, and a GGUF repo id rarely names a quant: a
// 4B repo read as fp16 (9.2 GB), so on a 4 GB card every build the chooser
// offered was refused, the 2.8 GB Q4_K_M included, with a remedy (lower -ngl)
// the Serve button cannot take. The pick is what loads, so the pick is judged.
// A stand-in nvidia-smi on PATH reports one 4096 MB card; no `force`.
describe.skipIf(process.platform === 'win32')('Serve judges the chosen build against the card (C18)', () => {
  let savedPath;
  beforeEach(() => {
    const smi = path.join(root, 'gpu-bin', 'nvidia-smi');
    fs.mkdirSync(path.dirname(smi), { recursive: true });
    fs.writeFileSync(smi, [
      `#!${process.execPath}`,
      "if (process.argv.some(a => a.startsWith('--query-gpu'))) console.log('0, Stand-in GPU, 4000, 4096, 96, 0, GPU-aeon-sweep');",
    ].join('\n'));
    fs.chmodSync(smi, 0o755);
    savedPath = process.env.PATH;
    process.env.PATH = `${path.dirname(smi)}${path.delimiter}${savedPath}`;
  });
  afterEach(() => { process.env.PATH = savedPath; });

  it('serves a Q4_K_M that fits, though its repo id reads as fp16', async () => {
    const snap = cachedRepo('aeon-sweep/Qwen3-4B-GGUF', ['Qwen3-4B-Q4_K_M.gguf', 'Qwen3-4B-Q8_0.gguf']);
    const bin = fakeBinary('llama-server');
    const cb = await mount();
    const cmd = `${bin} --model "aeon-sweep/Qwen3-4B-GGUF" --host 127.0.0.1 --port 8080 -ngl 99 -c 8192`;
    const listed = await cb.post('/model/serve', { repo_id: 'aeon-sweep/Qwen3-4B-GGUF', cmd });
    expect(listed.body.code).toBe('gguf_ambiguous');

    const r = await cb.post('/model/serve', { repo_id: 'aeon-sweep/Qwen3-4B-GGUF', cmd, gguf: 'Qwen3-4B-Q4_K_M.gguf' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const argv = await argvSeen();
    expect(argv[argv.indexOf('--model') + 1]).toBe(path.join(snap, 'Qwen3-4B-Q4_K_M.gguf'));
  }, 20000);

  it('still refuses a build too big for the card, and names that build', async () => {
    cachedRepo('aeon-sweep/Qwen3-4B-GGUF', ['Qwen3-4B-Q4_K_M.gguf', 'Qwen3-4B-Q8_0.gguf']);
    cachedRepo('aeon-sweep/Qwen3-8B-GGUF', ['Qwen3-8B-Q4_K_M.gguf', 'Qwen3-8B-F16.gguf']);
    const bin = fakeBinary('llama-server');
    const cb = await mount();
    for (const [repo, gguf, re] of [
      ['aeon-sweep/Qwen3-4B-GGUF', 'Qwen3-4B-Q8_0.gguf', /^Qwen3-4B-Q8_0\.gguf \(q8\) needs about 4\.9 GB of VRAM and this GPU has 4 GB/],
      ['aeon-sweep/Qwen3-8B-GGUF', 'Qwen3-8B-Q4_K_M.gguf', /^Qwen3-8B-Q4_K_M\.gguf \(q4\) needs about 5\.5 GB/],
      ['aeon-sweep/Qwen3-8B-GGUF', 'Qwen3-8B-F16.gguf', /^Qwen3-8B-F16\.gguf \(f16\) needs about 18\.4 GB/],
    ]) {
      const r = await cb.post('/model/serve', {
        repo_id: repo, cmd: `${bin} --model "${repo}" --host 127.0.0.1 --port 8080 -ngl 99 -c 8192`, gguf,
      });
      expect(r.status, gguf).toBe(409);
      expect(r.body.code).toBe('model_exceeds_vram');
      expect(r.body.error).toMatch(re);
    }
    await sleep(300);
    expect(fs.existsSync(path.join(root, 'argv.json'))).toBe(false);
  }, 20000);

  it('a build whose file name carries no parameter count borrows the repo\'s', async () => {
    cachedRepo('aeon-sweep/Qwen3-8B-GGUF', ['model-q8_0.gguf', 'model-q2_k.gguf']);
    const bin = fakeBinary('llama-server');
    const cb = await mount();
    const cmd = `${bin} --model "aeon-sweep/Qwen3-8B-GGUF" --host 127.0.0.1 --port 8080 -ngl 99`;
    const big = await cb.post('/model/serve', { repo_id: 'aeon-sweep/Qwen3-8B-GGUF', cmd, gguf: 'model-q8_0.gguf' });
    expect(big.status).toBe(409);
    expect(big.body.error).toMatch(/^model-q8_0\.gguf \(q8\) needs about 9\.8 GB/);
    const small = await cb.post('/model/serve', { repo_id: 'aeon-sweep/Qwen3-8B-GGUF', cmd, gguf: 'model-q2_k.gguf' });
    expect(small.status, JSON.stringify(small.body)).toBe(200);
  }, 20000);
});

// Review follow-up: the process-wide registry was never emptied — a rescan
// used to do that by accident — so finished tasks, each holding its process
// handle, piled up and every status poll re-read every one of their logs.
describe('the task registry keeps what is running and the recent finished ones', () => {
  it('drops the oldest finished tasks past the cap, never a running one', async () => {
    const cb = await mount();
    const key = path.resolve(path.join(root, 'data', 'cookbook'));
    const tasks = globalThis[Symbol.for('aeon.cookbook.activeTasks')].get(key);
    expect(tasks).toBeTruthy();
    const t0 = Date.now() - 100000;
    for (let i = 0; i < 30; i++) tasks[`old-${String(i).padStart(2, '0')}`] = { type: 'serve', status: 'done', exited: true, started_at: t0 + i, query: 'x' };
    tasks['still-running'] = { type: 'serve', status: 'running', started_at: t0 - 1, query: 'y', pid: process.pid };
    const listed = (await cb.get('/cookbook/tasks/status')).tasks.map((t) => t.session_id);
    expect(listed).toContain('still-running');
    const kept = Object.keys(tasks).filter((k) => k.startsWith('old-')).sort();
    expect(kept).toHaveLength(20);
    expect(kept[0]).toBe('old-10'); // the ten oldest went
    delete tasks['still-running'];
  });
});
