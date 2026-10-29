/**
 * Cookbook rows show an installed model as installed, with its size.
 *
 * Found filming 2026-10-29 (3.5.1): after installing Phi-4 Mini the header
 * said "2 models ready" while its row still offered "Install" and no row
 * showed a size. The rows read m.installed and m.sizeMb, which the catalogue
 * route never set (it carries installState and bytes). After the runtime
 * installed, only the runtime status was re-read: the list and the line "no
 * runtime is installed yet" stayed as they were on mount. And an in-process
 * install task (no pid) read as "stopped" on the first poll.
 *
 * Sizes are decimal and labelled so: 1 MB = 1,000,000 bytes. They used to
 * divide by 1024 and print "MB"/"GB".
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-cookbook-rows-'));
process.env.AEON_HOME = path.join(tmp, 'home');
process.env.AEON_SECRETS_DIR = path.join(tmp, 'home', 'secrets');
process.env.AEON_ENV_FILE = path.join(tmp, 'home', '.env');
const createCookbookRouter = require('../src/blocks/cookbook/api/index.cjs');
const P = require('../services/local-runtime/paths.cjs');
const catalog = require('../services/local-runtime/model-catalog.json').models;
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

const PHI = catalog.find((m) => m.id === 'phi4-mini-q4');
let root, servers, installers, registry;
const listen = (router) => new Promise((resolve) => {
  const a = express(); a.use(express.json()); a.use('/api', router);
  const server = a.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
});
async function mount() {
  const router = createCookbookRouter({
    isVercel: false, VAULT_ROOT: root, DATA_ROOT: path.join(root, 'data'), getDataFile: (n) => path.join(root, 'data', n),
    getLocalRuntimeRegistry: () => registry, localInstallers: installers, writeOSAudit: () => {},
  });
  const h = await listen(router); servers.push(h.server); return h.port;
}
const get = async (port, p) => (await fetch(`http://127.0.0.1:${port}/api${p}`)).json();

beforeEach(() => {
  root = fs.mkdtempSync(path.join(tmp, 'root-'));
  servers = [];
  installers = {
    runtime: { installRuntime: vi.fn(async () => ({ runtimeId: 'llamacpp-stub' })) },
    model: { installModel: vi.fn(async () => ({ ok: true })), listCatalog: () => [] },
  };
  registry = { file: path.join(root, 'data', 'local-runtime', 'local-runtime.json'), activeRuntime: () => null, readyModels: () => [], modelsForCapability: () => [] };
  // The registry the real model installer reads: Phi-4 Mini verified and ready.
  const dataRoot = path.join(root, 'data');
  const file = P.registryPath(dataRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1, updatedAt: new Date().toISOString(), activeRuntimeId: null, runtimes: [],
    models: [{ id: PHI.id, state: 'ready', relPath: PHI.relPathTemplate, bytes: PHI.bytes, sha256: PHI.sha256, installedAt: new Date().toISOString(), capabilities: ['chat'] }],
  }));
});
afterEach(() => { for (const s of servers) { try { s.close(); } catch {} } });

describe('GET /cookbook/local/catalog', () => {
  it('marks the installed model installed, and only that one', async () => {
    const port = await mount();
    const body = await get(port, '/cookbook/local/catalog');
    expect(body.ok).toBe(true);
    const rows = [...(body.shown || []), ...(body.hidden || [])];
    expect(rows.length).toBe(catalog.length);
    expect(rows.find((m) => m.id === PHI.id).installed).toBe(true);
    expect(rows.filter((m) => m.installed).map((m) => m.id)).toEqual([PHI.id]);
  });

  it('gives every row its size in decimal megabytes, labelled MB or GB', async () => {
    const port = await mount();
    const rows = (await get(port, '/cookbook/local/catalog')).models;
    for (const m of rows) {
      const src = catalog.find((c) => c.id === m.id);
      expect(m.sizeMb, m.id).toBe(Math.round(src.bytes / 1e6));
      expect(m.sizeLabel, m.id).toMatch(/^\d[\d,.]* (MB|GB)$/);
    }
    // 2,491,874,272 bytes: 2.5 GB, not the 2.3 "GB" a 1024 division gives.
    const phi = rows.find((m) => m.id === PHI.id);
    expect(phi.sizeMb).toBe(2492);
    expect(phi.sizeLabel).toBe('2.5 GB');
  });
});

describe('install tasks', () => {
  // The installers run in-process with no pid; their own promise sets done
  // or error (see install-runtime and local/install). Planted in the shared
  // task map (globalThis, keyed by the Cookbook data folder) so no test
  // downloads anything.
  it('a running runtime or model install (no pid) still reads as running', async () => {
    const port = await mount();
    const tasks = globalThis[Symbol.for('aeon.cookbook.activeTasks')].get(path.resolve(path.join(root, 'data', 'cookbook')));
    tasks['lr-install-1'] = { type: 'runtime-install', status: 'running', query: 'llama.cpp (cpu)', started_at: Date.now(), pid: null, pct: 10 };
    tasks['local-install-1'] = { type: 'model-install', status: 'running', query: PHI.id, started_at: Date.now(), pct: 40, log: null, error: null };
    const first = (await get(port, '/cookbook/tasks/status')).tasks;
    expect(first.find((t) => t.type === 'runtime-install').status).toBe('running');
    expect(first.find((t) => t.type === 'model-install').status).toBe('running');
    tasks['lr-install-1'].status = 'done';
    const after = (await get(port, '/cookbook/tasks/status')).tasks;
    expect(after.find((t) => t.type === 'runtime-install').status).toBe('done');
  });
});

describe('the page', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/blocks/cookbook/index.jsx'), 'utf8');
  it('re-reads the catalogue, the status and the Models tab when an install task finishes', () => {
    const effect = src.slice(src.indexOf('const seenFinished'), src.indexOf('const seenFinished') + 1200);
    expect(effect).toMatch(/runtime-install/);
    expect(effect).toMatch(/model-install/);
    expect(effect).toMatch(/fetchLrStatus\(\); fetchCatalog\(\); scanCached\(\);/);
  });
  it('shows the server\'s size label and never divides a file size by 1024', () => {
    expect(src).toMatch(/m\.sizeLabel/);
    expect(src).not.toMatch(/size_bytes \/ 1024/);
  });
});
