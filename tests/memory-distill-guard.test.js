/**
 * Distil twice, store once.
 *
 * The operator clicked "distil session" three times on one conversation and
 * got thirteen memories — the same five facts written three ways, because a
 * model asked the same question twice paraphrases rather than repeats. The
 * store's existing check compares text exactly and so never fired.
 *
 * A fuzzy text comparison was tried first and measured against those real
 * duplicates: it caught 2 of 9 and wrongly flagged a genuine memory. It is the
 * wrong tool — paraphrases share meaning, not words. What repeats is the
 * INPUT, so the input is what gets remembered.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const createMemoryRouter = require('../src/blocks/memory_core/api/memory.cjs');

let vault;
const TRANSCRIPT = 'user: what is the stand about\nassistant: a superflu kills almost everyone';

/**
 * `llmReply` may be one reply, or a list consumed one per call — a longer
 * conversation yields a DIFFERENT fact, which is the case worth proving.
 */
function routerWith(llmReply) {
  const queue = Array.isArray(llmReply) ? [...llmReply] : null;
  return createMemoryRouter({
    VAULT_ROOT: vault,
    kernelLLM: async () => (queue ? (queue.shift() ?? '[]') : llmReply),
    TERMINAL_HISTORY_FILE: null,
  });
}

/** Drive the POST /memory/distill handler without standing up express. */
async function distill(router, body) {
  const layer = router.stack.find((l) => l.route?.path === '/memory/distill' && l.route.methods.post);
  const req = { body, headers: {} };
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); },
    };
    layer.route.stack[0].handle(req, res, () => resolve({ status: 0, body: null }));
  });
}

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-distill-'));
  fs.mkdirSync(path.join(vault, 'Agents', 'Aeon', 'memory'), { recursive: true });
});
afterEach(() => { try { fs.rmSync(vault, { recursive: true, force: true }); } catch {} });

const ONE = JSON.stringify([{ text: 'The Stand is a 1978 King novel about a superflu.', category: 'fact', title: 'The Stand' }]);
const TWO = JSON.stringify([{ text: 'Stephen King wrote it; it was his breakout epic.', category: 'fact', title: 'Author' }]);

describe('distilling the same conversation twice', () => {
  it('stores it the first time', async () => {
    const r = await distill(routerWith(ONE), { transcript: TRANSCRIPT });
    expect(r.body.ok).toBe(true);
    expect(r.body.added).toHaveLength(1);
    expect(r.body.alreadyDistilled).toBeUndefined();
  });

  it('REFUSES the second time, and says why rather than silently doing nothing', async () => {
    const router = routerWith(ONE);
    await distill(router, { transcript: TRANSCRIPT });
    const second = await distill(router, { transcript: TRANSCRIPT });

    expect(second.body.alreadyDistilled).toBe(true);
    expect(second.body.added).toHaveLength(0);
    expect(second.body.message).toMatch(/nothing new/i);
  });

  it('distils again once the conversation has moved on', async () => {
    const router = routerWith([ONE, TWO]);
    await distill(router, { transcript: TRANSCRIPT });
    const grown = await distill(router, { transcript: `${TRANSCRIPT}\nuser: who wrote it` });

    expect(grown.body.alreadyDistilled).toBeUndefined();
    expect(grown.body.added).toHaveLength(1);
    expect(grown.body.added[0].text).toMatch(/King wrote it/);
  });

  it('still refuses a fact it already holds, even in a grown conversation', async () => {
    // The hash guard is about the INPUT. The store's own exact-text check is
    // about the OUTPUT, and both have to hold: a longer chat that yields the
    // same fact must not store it twice.
    const router = routerWith([ONE, ONE]);
    await distill(router, { transcript: TRANSCRIPT });
    const grown = await distill(router, { transcript: `${TRANSCRIPT}\nuser: anything else` });

    expect(grown.body.alreadyDistilled).toBeUndefined();
    expect(grown.body.added).toHaveLength(0);
  });

  it('remembers a run that found nothing, so an empty result is not re-asked', async () => {
    const router = routerWith('[]');
    const first = await distill(router, { transcript: TRANSCRIPT });
    expect(first.body.added).toHaveLength(0);

    const second = await distill(router, { transcript: TRANSCRIPT });
    expect(second.body.alreadyDistilled).toBe(true);
  });

  it('runs anyway when the operator insists', async () => {
    const router = routerWith(ONE);
    await distill(router, { transcript: TRANSCRIPT });
    const forced = await distill(router, { transcript: TRANSCRIPT, force: true });
    expect(forced.body.alreadyDistilled).toBeUndefined();
  });
});
