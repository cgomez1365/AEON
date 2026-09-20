/**
 * BLOCK_CONFIG only names blocks that exist, and a failed write says so.
 *
 * Found live, 2026-09-20 (CEO: "check supabase to matrix sync... triple
 * checked", then "fix these"). BLOCK_CONFIG had 10 entries; grepping the
 * whole tree for each filename found readers/writers for only 5.
 * `inventory`/`scheduler`/`staff`/`hr_arsenal` had NONE anywhere else —
 * leftovers from a retired block set. `compare` computed a path with a
 * doubled `src/blocks` segment (__dirname is already inside aeon_matrix/api)
 * that has never resolved to a real file, pointing at a block (`compare`)
 * that no longer exists — council absorbed it and keeps its own history
 * elsewhere. `cookbook` had the same doubled-path bug but a live target
 * worth fixing rather than removing.
 *
 * Separately: writeLocal() swallowed every write exception into
 * console.error and the four routes that call it (bulk-pull, GET/POST
 * /:block, /:block/patch) answered success regardless — a write that
 * genuinely failed read exactly like one that landed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const syncFactory = require('../src/blocks/aeon_matrix/api/sync.cjs');

let root, servers;
const listen = (app) => new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }));
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-sync-'));
  servers = [];
});
afterEach(() => {
  for (const s of servers) { try { s.close(); } catch {} }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

function makeDeps(overrides = {}) {
  return {
    supabase: null,
    isVercel: false,
    getLocalFile: (name) => path.join(root, 'db', name),
    getDataFile: (rel) => path.join(root, 'data', rel),
    validateSDI: () => ({ valid: true }),
    writeOSAudit: () => {},
    ...overrides,
  };
}

async function mount(deps) {
  const app = express(); app.use(express.json());
  app.use('/api', syncFactory(deps));
  const { server, port } = await listen(app);
  servers.push(server);
  return {
    post: (route, body) => fetch(`http://127.0.0.1:${port}/api${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then((r) => r.json().then((j) => ({ status: r.status, body: j }))),
  };
}

describe('BLOCK_CONFIG only names blocks that exist', () => {
  it('a retired block is a 404, not a silent no-op', async () => {
    const { post } = await mount(makeDeps());
    for (const dead of ['inventory', 'scheduler', 'staff', 'hr_arsenal', 'compare']) {
      const { status, body } = await post(`/sync/${dead}`, { data: { x: 1 } });
      expect(status, dead).toBe(404);
      expect(body.error, dead).toMatch(new RegExp(`Unknown block: ${dead}`));
    }
  });

  it('cookbook resolves under the shared data root, not a broken path inside the install', async () => {
    const deps = makeDeps();
    const { post } = await mount(deps);
    const r = await post('/sync/cookbook', { data: { installed: ['nomic-embed'] } });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    const written = path.join(root, 'data', 'cookbook', 'cookbook_state.json');
    expect(fs.existsSync(written)).toBe(true);
    expect(JSON.parse(fs.readFileSync(written, 'utf8'))).toEqual({ installed: ['nomic-embed'] });
  });

  it('the surviving blocks still work: clients, activity, quick_links, logistics', async () => {
    const { post } = await mount(makeDeps());
    for (const live of ['clients', 'activity', 'quick_links']) {
      const r = await post(`/sync/${live}`, { data: [{ id: 1 }] });
      expect(r.status, live).toBe(200);
      expect(r.body.success, live).toBe(true);
    }
  });
});

describe('a write that fails is reported, not hidden behind success:true', () => {
  it('POST /sync/:block answers 500 with the real reason when the write throws', async () => {
    // A FILE where writeLocal expects to mkdir a directory forces a
    // deterministic, cross-platform write failure (ENOTDIR).
    const blocker = path.join(root, 'db');
    fs.writeFileSync(blocker, 'not a directory');
    const { post } = await mount(makeDeps());
    const r = await post('/sync/activity', { data: { hits: 1 } });
    expect(r.status).toBe(500);
    expect(r.body.success).toBe(false);
    expect(r.body.error).toBeTruthy();
  });

  it('POST /sync/:block/patch answers 500 the same way', async () => {
    const blocker = path.join(root, 'db');
    fs.writeFileSync(blocker, 'not a directory');
    const { post } = await mount(makeDeps());
    const r = await post('/sync/activity/patch', { action: 'add', record: { n: 1 } });
    expect(r.status).toBe(500);
    expect(r.body.success).toBe(false);
  });

  it('bulk-pull reports per-block which writes actually landed, and success:false if any did not', async () => {
    const blocker = path.join(root, 'db');
    fs.writeFileSync(blocker, 'not a directory');    // clients/activity/quick_links all write under db/
    const cookbookDir = path.join(root, 'data', 'cookbook');
    fs.mkdirSync(path.dirname(cookbookDir), { recursive: true });   // cookbook's write CAN land
    const calls = [];
    const fakeSupabase = {
      from: (table) => ({
        select: () => ({ eq: (col, tag) => ({
          single: async () => {
            calls.push(tag);
            return { data: { payload: [{ ok: true, tag }] }, error: null };
          },
        }) }),
      }),
    };
    const { post } = await mount(makeDeps({ supabase: fakeSupabase }));
    const r = await post('/sync/bulk-pull', {});
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(false);                          // NOT true just because the loop finished
    expect(r.body.results.activity.pulled).toBe(false);
    expect(r.body.results.activity.reason).toMatch(/write failed/);
    expect(r.body.results.cookbook.pulled).toBe(true);            // the one write that could land still reports true
  });
});
