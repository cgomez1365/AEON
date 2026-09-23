/**
 * `aeon block <stop|start|remove|restore|removed> [id]` — the lifecycle routes
 * from the terminal, for the CEO's next gate ("install each block one by one
 * and run it"). The CLI is a client: it calls /api/build/blocks/…, the kernel
 * decides (security refused, nothing deleted). `remove` asks first; in a script
 * it needs --yes rather than hanging on a prompt nobody can answer.
 *
 * Also: the terminal's session file lived at <install>/data/terminal whatever
 * the AEON home was (measured 2026-09-23) — on a carried drive, inside the app
 * folder. It follows the home's data root now.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'tools', 'aeon-cli.cjs');

let server, url, seen, tmp;
beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-cli-block-'));
  seen = [];
  const app = express();
  app.use(express.json());
  app.get('/api/ping', (_q, r) => r.json({ ok: true }));
  app.all('/api/build/blocks/*', (q, r) => {
    seen.push(`${q.method} ${q.path}`);
    if (q.path.endsWith('/security/uninstall')) return r.status(409).json({ ok: false, error: 'security cannot be uninstalled' });
    if (q.path.endsWith('/removed')) return r.json({ removed: [{ blockId: 'council', removedAt: '2026-09-23T09-00-00-000Z' }] });
    r.json({ ok: true, blockId: q.path.split('/')[4], running: q.path.endsWith('/start'), movedTo: '/x/removed-blocks/council@t', ui: 'npm run build' });
  });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  url = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// Async on purpose: the stand-in server lives in THIS process, and spawnSync
// would block the event loop it needs to answer the CLI.
const run = (...args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [CLI, 'block', ...args], {
    env: { ...process.env, AEON_URL: url, AEON_HOME: tmp, DATA_PATH: '' },
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
  child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
});

describe('aeon block', () => {
  it('stop and start call the kernel\'s routes', async () => {
    seen = [];
    expect((await run('stop', 'council')).status).toBe(0);
    expect((await run('start', 'council')).status).toBe(0);
    expect(seen).toEqual(['POST /api/build/blocks/council/stop', 'POST /api/build/blocks/council/start']);
  });

  it('remove needs --yes when it cannot ask, and then uninstalls', async () => {
    seen = [];
    const refused = await run('remove', 'council');
    expect(refused.status).not.toBe(0);
    expect(refused.stderr + refused.stdout).toMatch(/--yes/);
    expect(seen).toEqual([]);
    const ok = await run('remove', 'council', '--yes');
    expect(ok.status).toBe(0);
    expect(seen).toEqual(['POST /api/build/blocks/council/uninstall']);
    expect(ok.stdout).toMatch(/removed-blocks/);
  });

  it('restore and the removed list', async () => {
    seen = [];
    expect((await run('restore', 'council')).status).toBe(0);
    const list = await run('removed');
    expect(list.status).toBe(0);
    expect(list.stdout).toMatch(/council/);
    expect(seen).toEqual(['POST /api/build/blocks/council/restore', 'GET /api/build/blocks/removed']);
  });

  it('a refusal from the kernel is shown and exits 1', async () => {
    const r = await run('remove', 'security', '--yes');
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/security cannot be uninstalled/);
  });

  it('usage without a sub-command', async () => {
    const r = await run();
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/aeon block/);
  });
});

describe('the terminal session follows the AEON home', () => {
  it('session.json lives under the home\'s data root, not the install', () => {
    const client = path.join(ROOT, 'tools', 'terminal', 'client.cjs');
    const code = `process.env.AEON_HOME=${JSON.stringify(tmp)};delete process.env.DATA_PATH;` +
      `const c=require(${JSON.stringify(client)});console.log(c.sessionFile ? c.sessionFile() : 'NO_EXPORT')`;
    const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 10000 });
    const file = r.stdout.trim();
    expect(file).not.toBe('NO_EXPORT');
    expect(file.startsWith(fs.realpathSync(tmp)) || file.startsWith(tmp)).toBe(true);
  });
});
