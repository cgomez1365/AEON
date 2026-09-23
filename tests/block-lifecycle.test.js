/**
 * A block can be stopped, removed, and put back — and AEON continues.
 *
 * The CEO's next gate (2026-09-23): "install each block one by one and run it."
 * The removability run the same night (one block at a time, build → restart →
 * login → probe) found what stood in the way:
 *   - stop/start answered 400 "not a manual-start block" for ALL 17 shipped
 *     blocks: only pipeline-installed blocks had run state;
 *   - there was no uninstall — removal meant moving the folder by hand;
 *   - a kernel rescan remounted block APIs but left their commands listed,
 *     and dispatching one answered "Command failed (404)";
 *   - a block removed while running came back RUNNING on reinstall, while the
 *     install response said "stopped" (registerManual never overwrote).
 *
 * Drives the real build router and run-state module over a temp blocks tree.
 * Nothing is deleted: uninstall moves the folder aside, restore moves it back.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const RS_PATH = require.resolve('../src/kernel/runState.cjs');
const ROUTER_PATH = require.resolve('../src/kernel/routers/build.cjs');

let tmp, blocksDir, removedDir, server, base, rescans, commandRescans, rs;

const manifest = (id, extra = {}) => JSON.stringify({ id, name: id, version: '1.0.0', ...extra });
const makeBlock = (id, extra) => {
  fs.mkdirSync(path.join(blocksDir, id), { recursive: true });
  fs.writeFileSync(path.join(blocksDir, id, 'block.manifest.json'), manifest(id, extra));
  fs.writeFileSync(path.join(blocksDir, id, 'index.jsx'), 'export default () => null;\n');
};

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-lifecycle-'));
  blocksDir = path.join(tmp, 'blocks');
  removedDir = path.join(tmp, 'data', 'removed-blocks');
  process.env.AEON_DB_DIR = path.join(tmp, 'db');
  delete require.cache[RS_PATH];
  delete require.cache[ROUTER_PATH];
  rs = require(RS_PATH);
  for (const id of ['security', 'settings', 'council', 'memory_core']) makeBlock(id);
  makeBlock('writer', { requires: { blocks: ['memory_core'] } });
  rescans = []; commandRescans = 0;
  const app = express();
  app.use(express.json());
  app.use('/api/build', require(ROUTER_PATH)({
    pipeline: {}, approvals: {}, ideMode: {},
    kernelRescan: (reason) => { rescans.push(reason); return { ok: true }; },
    commandRescan: () => { commandRescans++; return 0; },
    blocksDir, removedDir,
  }));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}/api/build`;
});

afterEach(() => {
  server.close();
  delete process.env.AEON_DB_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const post = async (p, body = {}) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };

describe('stop and start work for shipped blocks, not only pipeline-installed ones', () => {
  it('a shipped block stops and starts (was 400 "not a manual-start block")', async () => {
    expect(rs.isRunning('council')).toBe(true);
    const stop = await post('/blocks/council/stop');
    expect(stop.status).toBe(200);
    expect(rs.isRunning('council')).toBe(false);
    const start = await post('/blocks/council/start');
    expect(start.status).toBe(200);
    expect(rs.isRunning('council')).toBe(true);
  });

  it('security cannot be stopped — it would lock the operator out', async () => {
    const r = await post('/blocks/security/stop');
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/lock/i);
    expect(rs.isRunning('security')).toBe(true);
  });

  it('a block that does not exist is refused, and no run state is invented for it', async () => {
    expect((await post('/blocks/nope/stop')).status).toBe(404);
    expect((await post('/blocks/..%2Fsecurity/stop')).status).toBeGreaterThanOrEqual(400);
    expect(rs.listManual().find((b) => b.blockId === 'nope')).toBeUndefined();
  });
});

describe('uninstall moves a block aside; restore puts it back; nothing is deleted', () => {
  it('uninstall removes the block from the tree, keeps a copy, and rescans blocks AND commands', async () => {
    await post('/blocks/council/stop');
    const r = await post('/blocks/council/uninstall');
    expect(r.status).toBe(200);
    expect(fs.existsSync(path.join(blocksDir, 'council'))).toBe(false);
    expect(r.body.movedTo).toBeTruthy();
    expect(fs.existsSync(path.join(r.body.movedTo, 'block.manifest.json'))).toBe(true);
    expect(path.dirname(r.body.movedTo)).toBe(removedDir);
    expect(rescans.length).toBe(1);
    expect(commandRescans).toBe(1);
    // Its run state is forgotten, so a later install starts clean.
    expect(rs.listManual().find((b) => b.blockId === 'council')).toBeUndefined();
    expect(r.body.ui).toMatch(/npm run build/);
  });

  it('names the blocks that depend on the one being removed', async () => {
    const r = await post('/blocks/memory_core/uninstall');
    expect(r.status).toBe(200);
    expect(r.body.dependents).toEqual(['writer']);
  });

  it('security cannot be uninstalled', async () => {
    const r = await post('/blocks/security/uninstall');
    expect(r.status).toBe(409);
    expect(fs.existsSync(path.join(blocksDir, 'security', 'block.manifest.json'))).toBe(true);
  });

  it('restore brings back the latest removed copy and rescans', async () => {
    await post('/blocks/council/uninstall');
    const removed = await get('/blocks/removed');
    expect(removed.body.removed.map((x) => x.blockId)).toContain('council');
    const r = await post('/blocks/council/restore');
    expect(r.status).toBe(200);
    expect(fs.existsSync(path.join(blocksDir, 'council', 'block.manifest.json'))).toBe(true);
    expect(rescans.length).toBe(2);
    expect(commandRescans).toBe(2);
    expect((await get('/blocks/removed')).body.removed.map((x) => x.blockId)).not.toContain('council');
  });

  it('restore refuses to overwrite a block that is already installed', async () => {
    await post('/blocks/council/uninstall');
    makeBlock('council');
    const r = await post('/blocks/council/restore');
    expect(r.status).toBe(409);
  });

  it('restore of a block that is neither installed nor removed is a 404', async () => {
    expect((await post('/blocks/deep_research/restore')).status).toBe(404);
  });
});

describe('a kernel rescan refreshes commands too', () => {
  it('POST /rescan runs both', async () => {
    const r = await post('/rescan');
    expect(r.status).toBe(200);
    expect(rescans).toEqual(['manual']);
    expect(commandRescans).toBe(1);
  });
});

describe('a reinstall lands stopped, as the install response says', () => {
  it('registerManual with reset overwrites a block left running before it was removed', () => {
    rs.registerManual('council', { by: 'pipeline:test' });
    rs.setRunning('council', true);
    expect(rs.isRunning('council')).toBe(true);
    rs.registerManual('council', { by: 'pipeline:test', reset: true });
    expect(rs.isRunning('council')).toBe(false);
  });

  it('the pipeline resets run state at both promote sites', () => {
    const src = fs.readFileSync(require.resolve('../src/kernel/buildPipeline.cjs'), 'utf8');
    const calls = src.match(/runState\.registerManual\([^)]*\)/g) || [];
    expect(calls.length).toBe(2);
    for (const c of calls) expect(c).toMatch(/reset:\s*true/);
  });
});
