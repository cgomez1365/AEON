/**
 * Settings → Blocks: per-block Stop / Start / Remove / Restore, wired to the
 * kernel lifecycle routes (src/kernel/routers/build.cjs):
 *
 *   GET  /api/build/blocks/:id/state
 *   POST /api/build/blocks/:id/{stop,start,uninstall,restore}
 *   GET  /api/build/blocks/removed
 *
 * The page's logic lives in src/blocks/settings/blockLifecycle.js so it can be
 * driven here without a DOM, against the REAL build router over a temp blocks
 * tree (no block is moved out of the checkout). What must hold:
 *  - every call carries x-aeon-self-reported: 1 (the page renders its own
 *    errors inline, so the global forensics banner must not also fire);
 *  - no call throws — a refusal or a dead server comes back as { ok:false,
 *    error } with the kernel's own words, which the page shows inline;
 *  - Security's refusal is shown verbatim;
 *  - Remove says the block was MOVED ASIDE, not deleted, where to, and names
 *    the dependents / warning the kernel reported;
 *  - every change tells the operator the screen updates after
 *    `npm run build` + reload.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-settings-lifecycle-'));
process.env.AEON_DB_DIR = path.join(TMP, 'db'); // runState's file, before it loads

const express = require('express');
const createBuildRouter = require('../src/kernel/routers/build.cjs');
const lc = await import('../src/blocks/settings/blockLifecycle.js');

const BLOCKS = path.join(TMP, 'blocks');
const REMOVED = path.join(TMP, 'removed-blocks');
const headersSeen = [];
let server;
let base;
let rescans = 0;

function writeBlock(id, requires = []) {
  const dir = path.join(BLOCKS, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'block.manifest.json'), JSON.stringify({ id, label: id, requires: { blocks: requires } }));
}

beforeAll(async () => {
  writeBlock('security');
  writeBlock('writer');
  writeBlock('council', ['writer']);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { headersSeen.push({ url: req.url, self: req.headers['x-aeon-self-reported'] }); next(); });
  app.use('/api/build', createBuildRouter({
    pipeline: {}, approvals: {}, ideMode: {},
    kernelRescan: () => { rescans++; return { ok: true }; },
    commandRescan: () => {},
    blocksDir: BLOCKS,
    removedDir: REMOVED,
  }));
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  delete process.env.AEON_DB_DIR;
  fs.rmSync(TMP, { recursive: true, force: true });
});

const client = () => lc.createLifecycleClient({ base });

describe('state, stop, start', () => {
  it('reads a shipped block as running (auto mode)', async () => {
    const r = await client().state('writer');
    expect(r.ok).toBe(true);
    expect(lc.runLabel(r.data)).toBe('Running');
  });

  it('stop then start round-trips, each with the build+reload note', async () => {
    const c = client();
    const stop = await c.stop('writer');
    expect(stop.ok).toBe(true);
    expect(lc.runLabel(stop.data)).toBe('Stopped');
    expect(stop.message).toMatch(/npm run build/);
    expect(lc.runLabel((await c.state('writer')).data)).toBe('Stopped');
    const start = await c.start('writer');
    expect(start.ok).toBe(true);
    expect(lc.runLabel(start.data)).toBe('Running');
    expect(start.message).toMatch(/reload/);
  });

  it('Security refuses to stop, and the kernel\'s own words come back', async () => {
    const r = await client().stop('security');
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
    expect(r.error).toMatch(/cannot be stopped/);
    expect(r.error).toMatch(/locked out/);
  });

  it('an unknown block is a 404 with the kernel\'s text, not a throw', async () => {
    const r = await client().start('nope_block');
    expect(r).toMatchObject({ ok: false, status: 404 });
    expect(r.error).toMatch(/no installed block "nope_block"/);
  });
});

describe('remove and restore', () => {
  it('Security refuses to be removed, verbatim', async () => {
    const r = await client().remove('security');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cannot be uninstalled/);
    expect(fs.existsSync(path.join(BLOCKS, 'security'))).toBe(true);
  });

  it('remove moves the block aside, says so, and names its dependents', async () => {
    const r = await client().remove('writer');
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(BLOCKS, 'writer'))).toBe(false);
    expect(r.data.movedTo.startsWith(REMOVED)).toBe(true);
    expect(fs.existsSync(r.data.movedTo)).toBe(true);        // nothing was deleted
    expect(r.message).toMatch(/moved aside/i);
    expect(r.message).toMatch(/not deleted/i);
    expect(r.message).toContain(r.data.movedTo);
    expect(r.data.dependents).toEqual(['council']);
    expect(r.message).toMatch(/council/);
    expect(r.message).toMatch(/degraded/);                   // the kernel's warning, shown
    expect(r.message).toMatch(/npm run build/);
  });

  it('the removed list shows it, and restore brings it back', async () => {
    const c = client();
    const list = await c.removed();
    expect(list.ok).toBe(true);
    expect(list.data.removed.map((x) => x.blockId)).toContain('writer');
    const back = await c.restore('writer');
    expect(back.ok).toBe(true);
    expect(fs.existsSync(path.join(BLOCKS, 'writer', 'block.manifest.json'))).toBe(true);
    expect(back.message).toMatch(/restored/i);
    expect(back.message).toMatch(/npm run build/);
    expect((await c.removed()).data.removed.map((x) => x.blockId)).not.toContain('writer');
  });

  it('restoring over an installed block is refused with the kernel\'s text', async () => {
    const r = await client().restore('writer');
    expect(r.ok).toBe(false);
    expect(r.status).toBe(409);
    expect(r.error).toMatch(/already installed/);
  });

  it('every lifecycle change triggered the kernel rescan', () => {
    expect(rescans).toBeGreaterThanOrEqual(2);
  });
});

describe('transport', () => {
  it('every request carried x-aeon-self-reported: 1', () => {
    expect(headersSeen.length).toBeGreaterThan(8);
    for (const h of headersSeen) expect(h.self, h.url).toBe('1');
  });

  it('a dead server is an inline error, not a throw', async () => {
    const dead = lc.createLifecycleClient({ base: 'http://127.0.0.1:9' });
    const r = await dead.stop('writer');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/could not reach AEON/i);
  });

  it('a non-JSON answer (a 401 page, a proxy error) is an inline error, not a throw', async () => {
    const fake = lc.createLifecycleClient({
      base: '',
      fetchImpl: async () => new Response('<html>nope</html>', { status: 502 }),
    });
    const r = await fake.state('writer');
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect(r.error).toMatch(/502/);
  });

  it('a 401 says the session ended, so the operator knows to sign in again', async () => {
    const fake = lc.createLifecycleClient({
      base: '',
      fetchImpl: async () => new Response(JSON.stringify({ error: 'UNAUTHORIZED_SESSION', reason: 'idle' }), { status: 401 }),
    });
    const r = await fake.stop('writer');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/sign in/i);
  });
});
