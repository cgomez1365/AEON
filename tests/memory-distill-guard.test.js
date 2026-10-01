/**
 * Distill runs once per unchanged conversation.
 *
 * Three presses on one chat once stored 13 memories — five facts, each worded
 * several ways — because a model asked the same thing twice rewords its
 * answer, and the store's exact-text check cannot see a reworded repeat.
 * What genuinely recurs is the transcript sent in, so that is fingerprinted:
 * the same conversation is refused with a reason, a grown one runs again, and
 * the store's own text check still stops a fact it already holds.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const createMemoryRouter = require('../src/blocks/memory_core/api/memory.cjs');

let vault;
let calls;
const TRANSCRIPT = 'user: I am reading The Shining for the book club\nassistant: noted — The Shining, for the book club.';
const GROWN = `${TRANSCRIPT}\nuser: and the club meets on Thursdays`;
const ONE = JSON.stringify([{ text: 'The operator is reading The Shining for a book club.', category: 'fact' }]);
const TWO = JSON.stringify([{ text: 'The operator\'s book club meets on Thursdays.', category: 'fact' }]);

/** A router whose model answers from `replies` in order, then "[]". */
function routerWith(...replies) {
  const queue = [...replies];
  return createMemoryRouter({
    VAULT_ROOT: vault,
    TERMINAL_HISTORY_FILE: null,
    kernelLLM: async () => { calls++; return queue.length ? queue.shift() : '[]'; },
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
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-distill-guard-'));
  fs.mkdirSync(path.join(vault, 'Agents', 'Aeon', 'memory'), { recursive: true });
  calls = 0;
});
afterEach(() => { fs.rmSync(vault, { recursive: true, force: true }); });

describe('the distill guard', () => {
  it('stores it the first time', async () => {
    const { body } = await distill(routerWith(ONE), { transcript: TRANSCRIPT });
    expect(body.ok).toBe(true);
    expect(body.added).toHaveLength(1);
    expect(body.alreadyDistilled).toBeUndefined();
  });

  it('refuses the second time, and says why', async () => {
    const r = routerWith(ONE);
    await distill(r, { transcript: TRANSCRIPT });
    const { body } = await distill(r, { transcript: TRANSCRIPT });
    expect(body.alreadyDistilled).toBe(true);
    expect(body.added).toHaveLength(0);
    expect(body.message).toMatch(/nothing new/i);
    expect(calls).toBe(1);
  });

  it('distils again once the conversation has moved on', async () => {
    const r = routerWith(ONE, TWO);
    await distill(r, { transcript: TRANSCRIPT });
    const { body } = await distill(r, { transcript: GROWN });
    expect(body.alreadyDistilled).toBeUndefined();
    expect(body.added).toHaveLength(1);
    expect(body.added[0].text).toBe(JSON.parse(TWO)[0].text);
  });

  it('still refuses a fact it already holds, even in a grown conversation', async () => {
    const r = routerWith(ONE, ONE);
    await distill(r, { transcript: TRANSCRIPT });
    const { body } = await distill(r, { transcript: GROWN });
    expect(body.alreadyDistilled).toBeUndefined();
    expect(body.added).toHaveLength(0);
  });

  it('remembers a run that found nothing', async () => {
    const r = routerWith('[]');
    const first = await distill(r, { transcript: TRANSCRIPT });
    expect(first.body.added).toHaveLength(0);
    expect(first.body.alreadyDistilled).toBeUndefined();
    const second = await distill(r, { transcript: TRANSCRIPT });
    expect(second.body.alreadyDistilled).toBe(true);
    expect(calls).toBe(1);
  });

  it('runs anyway when forced', async () => {
    const r = routerWith(ONE);
    await distill(r, { transcript: TRANSCRIPT });
    const { body } = await distill(r, { transcript: TRANSCRIPT, force: true });
    expect(body.alreadyDistilled).toBeUndefined();
    expect(calls).toBe(2);
  });
});
