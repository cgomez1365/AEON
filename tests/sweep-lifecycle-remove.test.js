/**
 * Remove never deletes tracked files from a git checkout (sweep C32, 2026-09-28).
 *
 * The drive's app is a checkout that is committed and pushed from. Settings →
 * Blocks → Remove moved src/blocks/<id> — tracked — to removed-blocks, and git
 * then saw the whole block deleted: `git add -A` or `git commit -a` would
 * commit a core block's deletion, and a `git pull` wrote back only the files
 * it changed. A tracked block is now refused by default, pointing at Stop; an
 * untracked (store-installed) block in the same checkout still moves aside as
 * before. The gate runbook removes shipped blocks on purpose, so the operator
 * can say so (`tracked: true`), and the answer names what git will see.
 *
 * A real git repository in a temp folder, the real build router over it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const RS_PATH = require.resolve('../src/kernel/runState.cjs');
const ROUTER_PATH = require.resolve('../src/kernel/routers/build.cjs');

let tmp, repo, blocksDir, removedDir, server, base, rescans;
const git = (...args) => execFileSync('git', ['-c', 'user.name=AEON test', '-c', 'user.email=test@example.invalid', ...args], {
  cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});
const makeBlock = (id) => {
  fs.mkdirSync(path.join(blocksDir, id, 'api'), { recursive: true });
  fs.writeFileSync(path.join(blocksDir, id, 'block.manifest.json'), JSON.stringify({ id, name: id, version: '1.0.0' }));
  fs.writeFileSync(path.join(blocksDir, id, 'api', 'index.cjs'), 'module.exports = () => {};\n');
};

beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-sweep-remove-')));
  repo = path.join(tmp, 'AEON');
  blocksDir = path.join(repo, 'src', 'blocks');
  removedDir = path.join(tmp, 'AEON-Data', 'data', 'removed-blocks');
  process.env.AEON_DB_DIR = path.join(tmp, 'db');
  fs.mkdirSync(blocksDir, { recursive: true });
  git('init', '-q');
  makeBlock('council');
  git('add', '-A');
  git('commit', '-q', '-m', 'shipped blocks');
  makeBlock('bought_pack'); // store-installed: untracked

  delete require.cache[RS_PATH];
  delete require.cache[ROUTER_PATH];
  rescans = [];
  const app = express();
  app.use(express.json());
  app.use('/api/build', require(ROUTER_PATH)({
    pipeline: {}, approvals: {}, ideMode: {},
    kernelRescan: (reason) => { rescans.push(reason); return { ok: true }; },
    commandRescan: () => 0,
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
const trackedChanges = () => git('status', '--porcelain', '--untracked-files=no').trim();

describe('Remove in a git checkout', () => {
  it('refuses a block git tracks, points at Stop, and leaves the working tree clean', async () => {
    const r = await post('/blocks/council/uninstall');
    expect(r.status).toBe(409);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toMatch(/git checkout/);
    expect(r.body.error).toMatch(/Stop it instead/);
    expect(r.body.stop).toBe('POST /api/build/blocks/council/stop');
    expect(r.body.code).toBe('git_tracked');
    expect(r.body.override).toEqual({ tracked: true });
    expect(r.body.error).toMatch(/aeon block remove council --yes --tracked/);
    expect(fs.existsSync(path.join(blocksDir, 'council', 'block.manifest.json'))).toBe(true);
    expect(trackedChanges()).toBe('');
    expect(rescans).toEqual([]);
  });

  it('Stop — the offered alternative — works on that block', async () => {
    const r = await post('/blocks/council/stop');
    expect(r.status).toBe(200);
    expect(trackedChanges()).toBe('');
  });

  it('removes it when the operator confirms git tracks it, names the git consequence, and Restore makes the tree clean again', async () => {
    const r = await post('/blocks/council/uninstall', { tracked: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.gitTracked).toBe(true);
    expect(r.body.warning).toMatch(/git sees council's tracked files as deleted: restore it before any `git add -A`/);
    expect(fs.existsSync(path.join(blocksDir, 'council'))).toBe(false);
    expect(fs.existsSync(path.join(r.body.movedTo, 'block.manifest.json'))).toBe(true);
    expect(trackedChanges()).toMatch(/^ D src\/blocks\/council\//m);
    expect(rescans).toEqual(['uninstall:council']);

    const back = await post('/blocks/council/restore');
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(trackedChanges()).toBe('');
  });

  it('only a literal true overrides — a truthy string does not', async () => {
    const r = await post('/blocks/council/uninstall', { tracked: 'yes' });
    expect(r.status).toBe(409);
    expect(fs.existsSync(path.join(blocksDir, 'council', 'block.manifest.json'))).toBe(true);
  });

  it('still moves aside a block git does not track (a store install)', async () => {
    const r = await post('/blocks/bought_pack/uninstall');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(fs.existsSync(path.join(blocksDir, 'bought_pack'))).toBe(false);
    expect(fs.existsSync(path.join(r.body.movedTo, 'block.manifest.json'))).toBe(true);
    expect(r.body.gitTracked).toBeUndefined();
    expect(r.body.warning).toBeUndefined();
    expect(trackedChanges()).toBe('');
  });
});
