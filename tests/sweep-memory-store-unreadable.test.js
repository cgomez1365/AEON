/**
 * An unreadable memories.json is not an empty one (sweep C12, 2026-09-28).
 *
 * load() caught a parse error the same way it caught a missing file and
 * returned []. A store cut short by an unplug mid-write (save() was a plain,
 * non-atomic writeFileSync on an exFAT drive) or left with a trailing comma by
 * a hand edit in Matrix Edit Mode then read as "0 memories", and the next
 * add, edit or distill wrote a store holding only that one memory over every
 * other one — no error anywhere. Reproduced: 3 memories + a trailing comma,
 * GET 200 count 0, POST /memory/add 200, file left holding 1 memory.
 *
 * The rule vault.cjs and endpoints.cjs already follow: refuse the write, keep
 * the file exactly as it is, and log it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const createMemoryRouter = require('../src/blocks/memory_core/api/memory.cjs');

let vault, memDir, store, llmCalls;

function router() {
  return createMemoryRouter({
    VAULT_ROOT: vault,
    TERMINAL_HISTORY_FILE: null,
    kernelLLM: async () => { llmCalls++; return JSON.stringify([{ text: 'The operator invoices on net 15 terms.', category: 'fact' }]); },
  });
}

/** Drive one route handler without standing up express. */
function call(r, method, routePath, { params = {}, body = {}, query = {} } = {}) {
  const layer = r.stack.find((l) => l.route?.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`no ${method} ${routePath}`);
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); },
    };
    Promise.resolve(layer.route.stack[0].handle({ params, body, query, headers: {} }, res, reject)).catch(reject);
  });
}

const THREE = [
  { id: 'aaa111', text: 'The operator is Cristian.', category: 'identity', timestamp: 1 },
  { id: 'bbb222', text: 'Invoices go out on the first of the month.', category: 'fact', timestamp: 2 },
  { id: 'ccc333', text: 'The operator prefers terse answers.', category: 'preference', timestamp: 3 },
];
// A hand edit in Edit Mode that left a trailing comma.
const DAMAGED = JSON.stringify(THREE, null, 2).replace(/\n\]$/, ',\n]');

let errSpy;
beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-sweep-memory-'));
  memDir = path.join(vault, 'Agents', 'Aeon', 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  store = path.join(memDir, 'memories.json');
  llmCalls = 0;
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
  try { fs.rmSync(vault, { recursive: true, force: true }); } catch {}
});

describe('a memories.json that will not parse', () => {
  beforeEach(() => { fs.writeFileSync(store, DAMAGED); });

  it('is reported, not listed as an empty store', async () => {
    const r = await call(router(), 'get', '/memory');
    expect(r.status).toBe(503);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toMatch(/unreadable/);
    expect(r.body.error).toContain(store);
    expect(r.body.count).toBeUndefined();
    // Logged, so it shows in the server log as well as on the screen.
    expect(errSpy.mock.calls.some(([m]) => /\[MEMORY\].*unreadable/.test(String(m)))).toBe(true);
  });

  it('an add is refused and every earlier memory is still in the file', async () => {
    const r = await call(router(), 'post', '/memory/add', { body: { text: 'A brand new fact about the operator.' } });
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/nothing was saved/);
    expect(fs.readFileSync(store, 'utf8')).toBe(DAMAGED);
    // No mirror for a memory that was never stored.
    expect(fs.readdirSync(memDir).filter((f) => f.endsWith('.md'))).toEqual([]);
  });

  it('edit, pin and delete are refused with the reason, and the file is untouched', async () => {
    const r = router();
    const edit = await call(r, 'put', '/memory/:id', { params: { id: 'aaa111' }, body: { text: 'Changed text here.' } });
    const pin = await call(r, 'post', '/memory/:id/pin', { params: { id: 'aaa111' } });
    const del = await call(r, 'delete', '/memory/:id', { params: { id: 'aaa111' } });
    for (const x of [edit, pin, del]) {
      expect(x.status).toBe(503);
      expect(x.body.error).toMatch(/unreadable/);
    }
    expect(fs.readFileSync(store, 'utf8')).toBe(DAMAGED);
  });

  it('distill refuses before the model is asked, and does not record the transcript', async () => {
    const r = await call(router(), 'post', '/memory/distill', { body: { transcript: 'user: we bill net 15\nassistant: noted' } });
    expect(r.status).toBe(503);
    expect(llmCalls).toBe(0);
    expect(fs.readFileSync(store, 'utf8')).toBe(DAMAGED);
    expect(fs.existsSync(path.join(memDir, '.distilled.json'))).toBe(false);
  });

  it('the injection payload does not pass it off as "no memories" either', async () => {
    const r = await call(router(), 'get', '/memory/context', { query: {} });
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/unreadable/);
  });
});

describe('a memories.json that parses but is not a list', () => {
  it('is refused too, not replaced by a list of one', async () => {
    fs.writeFileSync(store, '{}');
    const r = await call(router(), 'post', '/memory/add', { body: { text: 'A brand new fact about the operator.' } });
    expect(r.status).toBe(503);
    expect(fs.readFileSync(store, 'utf8')).toBe('{}');
  });
});

describe('a missing memories.json is still an empty store', () => {
  it('lists nothing, and the first add creates it — written whole, no temp file left beside it', async () => {
    const r = router();
    const list = await call(r, 'get', '/memory');
    expect(list.status).toBe(200);
    expect(list.body.count).toBe(0);

    const add = await call(r, 'post', '/memory/add', { body: { text: 'The operator invoices on net 15 terms.' } });
    expect(add.status).toBe(200);
    expect(JSON.parse(fs.readFileSync(store, 'utf8'))).toHaveLength(1);
    expect(fs.readdirSync(memDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('a healthy store keeps every memory through an add', async () => {
    fs.writeFileSync(store, JSON.stringify(THREE, null, 2));
    const add = await call(router(), 'post', '/memory/add', { body: { text: 'Payroll runs every other Friday.' } });
    expect(add.status).toBe(200);
    expect(JSON.parse(fs.readFileSync(store, 'utf8')).map((m) => m.id)).toEqual(expect.arrayContaining(['aaa111', 'bbb222', 'ccc333']));
  });
});
