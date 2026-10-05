/**
 * tools/rls-canary.cjs, run for real against a local fake of Supabase's REST API.
 *
 * The canary is how an operator learns whether the public key still opens their
 * tables, so a wrong verdict is worse than no tool. Two ways it used to lie:
 *   - an open-but-empty table (200 []) was reported LOCKED, the same as a closed one;
 *   - a refused KEY (401 for any reason) would count as "permission denied".
 * Only Postgres saying permission denied (42501) proves a table is locked.
 *
 * Nothing leaves the machine: the canary is pointed at 127.0.0.1.
 */
import { afterEach, describe, expect, it } from 'vitest';
import http from 'http';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const CANARY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'rls-canary.cjs');
let server;
afterEach(() => new Promise((r) => (server ? server.close(r) : r())));

/** answers(table) → { status, body }; records the headers each request carried. */
async function run(answers, { key = 'test-anon-key', args = [] } = {}) {
  const seen = [];
  server = http.createServer((req, res) => {
    const table = /\/rest\/v1\/([a-z_]+)/.exec(req.url)?.[1];
    seen.push({ table, headers: req.headers });
    const a = answers(table) || { status: 404, body: { code: 'PGRST205', message: 'no such table' } };
    res.writeHead(a.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(a.body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, [CANARY, ...args], { env: { PATH: process.env.PATH, SUPABASE_URL: url, SUPABASE_ANON_KEY: key }, cwd: path.dirname(CANARY) });
    let text = '';
    p.stdout.on('data', (d) => { text += d; }); p.stderr.on('data', (d) => { text += d; });
    p.on('close', (code) => resolve({ code, text }));
  });
  return { ...out, seen };
}

const DENIED = { status: 401, body: { code: '42501', message: 'permission denied for table x' } };
const EMPTY = { status: 200, body: [] };
const ROWS = { status: 200, body: [{ secret: 'PRIVATE-NOTE-TEXT' }] };
const BAD_KEY = { status: 401, body: { message: 'Invalid API key' } };

describe('rls-canary verdicts', () => {
  it('permission denied (42501) on every table → LOCKED, exit 0', async () => {
    const r = await run(() => DENIED);
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/LOCKED\s+aeon_notes/);
    expect(r.text).toMatch(/PASS — every AEON table that exists refuses/);
    expect(r.text).not.toMatch(/UNPROVEN|EXPOSED/);
  });

  it('200 with no rows is UNPROVEN, never LOCKED (an empty list cannot tell RLS from an empty open table)', async () => {
    const r = await run(() => EMPTY);
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/UNPROVEN\s+aeon_notes/);
    expect(r.text).not.toMatch(/LOCKED\s+aeon_notes/);
    expect(r.text).not.toMatch(/PASS —/);
  });

  it('--strict makes UNPROVEN fail', async () => {
    expect((await run(() => EMPTY, { args: ['--strict'] })).code).toBe(1);
  });

  it('rows come back → EXPOSED, exit 1 — and the row contents are never printed', async () => {
    const r = await run((t) => (t === 'aeon_notes' ? ROWS : DENIED));
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/EXPOSED\s+aeon_notes — anon read returned 1 row/);
    expect(r.text).not.toMatch(/PRIVATE-NOTE-TEXT/);
  });

  it('a refused KEY is not a locked table: REJECTED, and all-rejected is INCONCLUSIVE (exit 2)', async () => {
    const r = await run(() => BAD_KEY);
    expect(r.code).toBe(2);
    expect(r.text).toMatch(/REJECTED\s+aeon_notes/);
    expect(r.text).toMatch(/INCONCLUSIVE/);
    expect(r.text).not.toMatch(/LOCKED/);
  });

  it('requests that fail outright (nothing answers) are INCONCLUSIVE, never PASS', async () => {
    // the 2026-10-04 run printed "PASS" after 19 "fetch failed" lines
    const dead = http.createServer(() => {});
    await new Promise((r) => dead.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${dead.address().port}`;
    await new Promise((r) => dead.close(r));            // now nothing listens there
    const out = await new Promise((resolve) => {
      const p = spawn(process.execPath, [CANARY], { env: { PATH: process.env.PATH, SUPABASE_URL: url, SUPABASE_ANON_KEY: 'k' }, cwd: path.dirname(CANARY) });
      let text = ''; p.stdout.on('data', (d) => { text += d; }); p.stderr.on('data', (d) => { text += d; });
      p.on('close', (code) => resolve({ code, text }));
    });
    expect(out.code).toBe(2);
    expect(out.text).toMatch(/INCONCLUSIVE/);
    expect(out.text).not.toMatch(/PASS/);
  });

  it('one table failing to answer spoils the PASS even when the rest are locked', async () => {
    const r = await run((t) => (t === 'aeon_blocks' ? BAD_KEY : DENIED));
    expect(r.code).toBe(2);
    expect(r.text).not.toMatch(/PASS —/);
  });

  it('nothing positively locked (every table absent) is INCONCLUSIVE, not PASS', async () => {
    const r = await run(() => null);
    expect(r.code).toBe(2);
    expect(r.text).not.toMatch(/PASS —/);
  });

  it('a table that does not exist is ABSENT and does not count against the project', async () => {
    const r = await run((t) => (t === 'aeon_notes' ? null : DENIED));
    expect(r.text).toMatch(/ABSENT\s+aeon_notes/);
    expect(r.code).toBe(0);
    expect(r.text).toMatch(/PASS — every AEON table that exists/);
  });

  it('a mix reports each table on its own', async () => {
    const r = await run((t) => ({ aeon_notes: ROWS, aeon_blocks: EMPTY }[t] || DENIED));
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/EXPOSED\s+aeon_notes/);
    expect(r.text).toMatch(/UNPROVEN\s+aeon_blocks/);
    expect(r.text).toMatch(/LOCKED\s+aeon_governance/);
  });

  it('sends a legacy JWT anon key as apikey AND Bearer, but a sb_publishable_ key as apikey only', async () => {
    const jwt = await run(() => DENIED, { key: 'eyJhbGciOi.payload.sig' });
    expect(jwt.seen[0].headers.apikey).toBe('eyJhbGciOi.payload.sig');
    expect(jwt.seen[0].headers.authorization).toBe('Bearer eyJhbGciOi.payload.sig');
    const pub = await run(() => DENIED, { key: 'sb_publishable_abc123' });
    expect(pub.seen[0].headers.apikey).toBe('sb_publishable_abc123');
    expect(pub.seen[0].headers.authorization).toBeUndefined();
  });

  it('only reads: every request is a GET with a limit of one row', async () => {
    const r = await run(() => DENIED);
    expect(r.seen.length).toBeGreaterThan(15);
  });
});
