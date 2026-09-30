/**
 * A reply the distiller cannot use is a failed run, not an empty one
 * (sweep C39, 2026-09-28).
 *
 * The model is asked for a JSON list. When it answered in prose or a numbered
 * list, `raw.match(/\[…\]/)` was null, `|| '[]'` turned that into "nothing
 * durable", and the transcript was recorded as distilled. Every later click on
 * the same conversation answered "already distilled" without asking the model
 * again, and no button sends `force` — so the memories in that reply were lost
 * and the conversation could never be distilled.
 *
 * The same held for a list with nothing usable in it: ["fact","fact"] (strings,
 * not {text} objects) had every item skipped and the run recorded. Plain
 * strings are now taken as the memory text; a list with no text at all fails.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const createMemoryRouter = require('../src/blocks/memory_core/api/memory.cjs');

let vault, memDir, calls;
const TRANSCRIPT = 'user: we invoice on net 15 now\nassistant: noted, net 15 from today';
const GOOD = JSON.stringify([{ text: 'The operator invoices on net 15 terms.', category: 'fact', title: 'Terms' }]);

function routerWith(replies) {
  const queue = [...replies];
  return createMemoryRouter({
    VAULT_ROOT: vault,
    TERMINAL_HISTORY_FILE: null,
    kernelLLM: async () => { calls++; return queue.shift(); },
  });
}

function distill(r, body) {
  const layer = r.stack.find((l) => l.route?.path === '/memory/distill' && l.route.methods.post);
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); },
    };
    Promise.resolve(layer.route.stack[0].handle({ body, headers: {} }, res, reject)).catch(reject);
  });
}

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-sweep-distill-'));
  memDir = path.join(vault, 'Agents', 'Aeon', 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  calls = 0;
});
afterEach(() => { try { fs.rmSync(vault, { recursive: true, force: true }); } catch {} });

describe('a model reply with no JSON list in it', () => {
  it('fails the run, and the next click asks the model again', async () => {
    const r = routerWith([
      '1. The operator invoices on net 15 terms.\n2. Terms changed today.',
      GOOD,
    ]);
    const first = await distill(r, { transcript: TRANSCRIPT });
    expect(first.status).toBe(502);
    expect(first.body.ok).toBe(false);
    expect(first.body.error).toMatch(/nothing was saved/);
    expect(first.body.alreadyDistilled).toBeUndefined();
    // Not recorded: a failed run leaves no ledger entry behind it.
    const ledger = path.join(memDir, '.distilled.json');
    expect(fs.existsSync(ledger) ? JSON.parse(fs.readFileSync(ledger, 'utf8')) : []).toEqual([]);

    const second = await distill(r, { transcript: TRANSCRIPT });
    expect(calls).toBe(2);
    expect(second.body.alreadyDistilled).toBeUndefined();
    expect(second.body.added).toHaveLength(1);
  });

  it('an empty reply is a failure too', async () => {
    const r = routerWith(['']);
    const res = await distill(r, { transcript: TRANSCRIPT });
    expect(res.status).toBe(502);
    expect(fs.existsSync(path.join(memDir, 'memories.json'))).toBe(false);
  });

  it('a list of plain strings is taken as memories, not skipped and recorded', async () => {
    // The shape a small local model plausibly returns. Every item used to be
    // skipped by `!c.text`, the run recorded, and the conversation locked.
    const r = routerWith([JSON.stringify([
      'The operator invoices on net 15 terms.',
      'Payroll runs every other Friday.',
    ])]);
    const res = await distill(r, { transcript: TRANSCRIPT });
    expect(res.status).toBe(200);
    expect(res.body.added.map((m) => m.text)).toEqual([
      'The operator invoices on net 15 terms.',
      'Payroll runs every other Friday.',
    ]);
    expect(res.body.added.every((m) => m.category === 'fact')).toBe(true);
    const stored = JSON.parse(fs.readFileSync(path.join(memDir, 'memories.json'), 'utf8'));
    expect(stored).toHaveLength(2);
  });

  it('a list where no entry carries text fails the run, unrecorded, and the next click asks again', async () => {
    const r = routerWith([
      JSON.stringify([{ content: 'The operator invoices on net 15 terms.' }, 42, null]),
      GOOD,
    ]);
    const first = await distill(r, { transcript: TRANSCRIPT });
    expect(first.status).toBe(502);
    expect(first.body.ok).toBe(false);
    expect(first.body.error).toMatch(/nothing was saved/);
    const ledger = path.join(memDir, '.distilled.json');
    expect(fs.existsSync(ledger) ? JSON.parse(fs.readFileSync(ledger, 'utf8')) : []).toEqual([]);
    expect(fs.existsSync(path.join(memDir, 'memories.json'))).toBe(false);

    const second = await distill(r, { transcript: TRANSCRIPT });
    expect(calls).toBe(2);
    expect(second.body.alreadyDistilled).toBeUndefined();
    expect(second.body.added).toHaveLength(1);
  });

  it('entries that are only too short are still "nothing durable", and are remembered', async () => {
    const r = routerWith([JSON.stringify([{ text: 'ok' }, 'hi'])]);
    const first = await distill(r, { transcript: TRANSCRIPT });
    expect(first.status).toBe(200);
    expect(first.body.added).toHaveLength(0);
    const second = await distill(r, { transcript: TRANSCRIPT });
    expect(second.body.alreadyDistilled).toBe(true);
    expect(calls).toBe(1);
  });

  // A provider's status is not the route's: a 401 from distil read as "your
  // AEON session ended". Only the store's own 503 passes through.
  it('a model error carrying a status answers 500, unrecorded', async () => {
    const r = createMemoryRouter({
      VAULT_ROOT: vault, TERMINAL_HISTORY_FILE: null,
      kernelLLM: async () => { calls++; throw Object.assign(new Error('provider refused the key'), { status: 401 }); },
    });
    const first = await distill(r, { transcript: TRANSCRIPT });
    expect(first.status).toBe(500);
    expect(first.body.error).toMatch(/distill failed: provider refused the key/);
    await distill(r, { transcript: TRANSCRIPT });
    expect(calls).toBe(2); // not recorded as distilled
  });

  it('a real empty list is still "nothing durable", and is remembered', async () => {
    const r = routerWith(['Nothing worth keeping: []']);
    const first = await distill(r, { transcript: TRANSCRIPT });
    expect(first.status).toBe(200);
    expect(first.body.added).toHaveLength(0);
    const second = await distill(r, { transcript: TRANSCRIPT });
    expect(second.body.alreadyDistilled).toBe(true);
    expect(calls).toBe(1);
  });
});
