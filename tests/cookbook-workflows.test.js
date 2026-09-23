/**
 * Cookbook's model-free workflows say what is true (agent C4, 2026-09-23).
 *
 * Measured on this Mac against a fresh isolated home, no model installed:
 *  - GET /api/cookbook/gpus answered {ok:false, error:"No GPU probe available"}.
 *    probeNvidiaGpus() had already classified the case as notApplicable with a
 *    reason (F-02: an absent nvidia-smi on a Mac is a correct state, not a
 *    failure), and the route dropped both — so the Hardware tab showed a red
 *    error box on every Mac.
 *  - POST /api/cookbook/kill-pid ran `taskkill /F /T` on any pid >= 100 a caller
 *    named: on Windows a general "kill a process" endpoint, on macOS a no-op.
 *  - The What Fits tab reads fleet_control's /api/hwfit/*; requires.blocks said
 *    so, but `dependencies: []` hid it (normalizeManifest reads
 *    `m.dependencies || m.requires.blocks`).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { spawn, spawnSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const createCookbookRouter = require('../src/blocks/cookbook/api/index.cjs');
const std = require('../src/kernel/blockStandard.cjs');

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const hasNvidiaSmi = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['nvidia-smi']).status === 0;

let root, servers;
const strays = new Set();
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-cbwf-')); servers = []; });
afterEach(() => {
  for (const s of servers) { try { s.close(); } catch {} }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});
afterAll(() => { for (const pid of strays) { try { process.kill(pid, 'SIGKILL'); } catch {} } });

async function mount() {
  const router = createCookbookRouter({
    isVercel: false, VAULT_ROOT: root, DATA_ROOT: path.join(root, 'data'),
    getDataFile: (n) => path.join(root, 'data', n), writeOSAudit: () => {},
  });
  const app = express(); app.use(express.json()); app.use('/api', router);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  servers.push(server);
  return server.address().port;
}

describe('GPU probe on a machine without NVIDIA tooling', () => {
  it.skipIf(hasNvidiaSmi)('is reported as not applicable, with a reason — not as an error', async () => {
    const port = await mount();
    const r = await (await fetch(`http://127.0.0.1:${port}/api/cookbook/gpus`)).json();
    expect(r.gpus).toEqual([]);
    expect(r.notApplicable).toBe(true);
    expect(r.reason).toMatch(/NVIDIA/);
    expect(r.error).toBeUndefined();
  });
});

describe('serve with no model installed', () => {
  it('refuses by name and points at the screen that installs one, in the words that screen uses', async () => {
    // Measured live 2026-09-23 (What Fits ▸ Quick serve on a fresh install): the
    // operator got "Install it from Local models first." — no section of the
    // Cookbook screen is called that; the installer is Hardware ▸ "Local AI
    // runtime (llama.cpp)", and the Models tab already says "Install one from
    // the Hardware tab".
    const port = await mount();
    const r = await fetch(`http://127.0.0.1:${port}/api/model/serve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo_id: 'Qwen/Qwen3-8B', cmd: 'vllm serve Qwen/Qwen3-8B --port 8000' }),
    });
    const body = await r.json();
    expect(r.status).toBe(409);
    expect(body.code).toBe('model_not_installed');
    expect(body.error).toMatch(/Qwen3-8B is not installed/);
    expect(body.error).toMatch(/Hardware tab/);
    const ui = fs.readFileSync(path.join(ROOT, 'src/blocks/cookbook/index.jsx'), 'utf8');
    expect(ui).toMatch(/Local AI runtime \(llama\.cpp\)/);
    expect(body.error).toMatch(/Local AI runtime/);
  });
});

describe('kill-pid stops only what Cookbook can account for', () => {
  it('refuses a pid that is neither a Cookbook task nor a GPU process, and leaves it running', async () => {
    const bystander = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    strays.add(bystander.pid);
    const port = await mount();
    const r = await fetch(`http://127.0.0.1:${port}/api/cookbook/kill-pid`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid: bystander.pid }),
    });
    const body = await r.json();
    expect(r.status).toBe(403);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/not a Cookbook task/);
    await new Promise((res) => setTimeout(res, 300));
    expect(alive(bystander.pid)).toBe(true);
    bystander.kill('SIGKILL');
  });

  it('never shells out to taskkill outside Windows', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/blocks/cookbook/api/index.cjs'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/['"]taskkill['"]/);
    const ctl = fs.readFileSync(path.join(ROOT, 'src/blocks/cookbook/api/_procControl.cjs'), 'utf8');
    // taskkill lives only behind the win32 branch of the one stop helper.
    expect(ctl.indexOf("'taskkill'")).toBeGreaterThan(ctl.indexOf("platform === 'win32'"));
  });
});

describe('cookbook declares fleet_control, and the declaration is not hidden', () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/blocks/cookbook/block.manifest.json'), 'utf8'));
  it('requires.blocks and dependencies agree', () => {
    expect(m.requires.blocks).toContain('fleet_control');
    expect(m.dependencies).toEqual(m.requires.blocks);
  });
  it('the kernel-normalized manifest carries the dependency', () => {
    expect(std.normalizeManifest('cookbook').dependencies).toContain('fleet_control');
  });
  it('removing fleet_control degrades cookbook by name', () => {
    const r = std.checkReadiness(std.normalizeManifest('cookbook'), {}, new Set(['cookbook']));
    expect(r.missingBlocks).toEqual(['fleet_control']);
    expect(r.degraded).toBe(true);
  });
});
