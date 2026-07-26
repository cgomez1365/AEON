// The agentic loop (tools/terminal/agent.cjs) — multi-step: the model
// proposes one registered command, the loop dispatches it through the kernel
// command bus, feeds the real result back, and asks again.
//
// The model and the dispatcher are both injected, so these tests pin the
// loop's CONTROL FLOW deterministically. Testing this against a live model
// would be non-deterministic (phrasing varies run to run) and, on this
// machine, minutes per step -- a 14B model on CPU-only inference, since the
// GTX 1050 lost CUDA support in Ollama 0.32.4. The live end-to-end path is
// exercised separately by the stress script.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const agent = require('../tools/terminal/agent.cjs');

const REGISTRY = [
  { id: 'memory_core.remember', cmd: '/remember', blockId: 'memory_core', blockLabel: 'Memory', title: 'Save something to memory', param: 'text', available: true },
  { id: 'memory_core.memory', cmd: '/memory', blockId: 'memory_core', blockLabel: 'Memory', title: 'List or search saved memories', param: 'q', available: true },
  { id: 'files.write', cmd: '/write', blockId: 'files', blockLabel: 'Files', title: 'Write a file in the workspace', params: ['filePath', 'content'], dangerous: true, available: true },
  { id: 'settings.set', cmd: '/set', blockId: 'settings', blockLabel: 'Settings', title: 'Change a setting in plain English', param: 'phrase', available: true },
];

const getCommands = async () => ({ commands: REGISTRY, source: 'test' });
const silent = () => {};
const okResult = (data = {}) => ({ ok: true, status: 200, data: { ok: true, data } });

/** A model that returns a scripted sequence of decisions, one per call. */
function scriptedModel(decisions) {
  let i = 0;
  return vi.fn(async () => decisions[Math.min(i++, decisions.length - 1)]);
}

describe('agent loop — control flow', () => {
  it('runs a multi-step goal and stops when the model says done', async () => {
    const ask = scriptedModel([
      { action: 'run', id: 'memory_core.remember', arg: 'the agentic terminal shipped', why: 'save it' },
      { action: 'run', id: 'memory_core.memory', arg: '', why: 'show them' },
      { action: 'done', summary: 'Saved the note and listed your memories.' },
    ]);
    const dispatch = vi.fn(async () => okResult({ saved: true }));

    const out = await agent.run('save a note then show me my memories', { ask, dispatch, getCommands, log: silent });

    expect(out.ok).toBe(true);
    expect(out.summary).toMatch(/saved/i);
    expect(out.steps).toHaveLength(2);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0][0]).toBe('memory_core.remember');
    expect(dispatch.mock.calls[1][0]).toBe('memory_core.memory');
  });

  it('refuses a hallucinated command locally and feeds the refusal back instead of dying', async () => {
    const ask = scriptedModel([
      { action: 'run', id: 'totally.invented', arg: 'x', why: 'made this up' },
      { action: 'run', id: 'memory_core.memory', arg: '', why: 'corrected' },
      { action: 'done', summary: 'recovered' },
    ]);
    const dispatch = vi.fn(async () => okResult());

    const out = await agent.run('do a thing', { ask, dispatch, getCommands, log: silent });

    expect(out.ok).toBe(true);
    // The invented id must never have reached the dispatcher.
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toBe('memory_core.memory');
    // ...and the model must have been told why, so it can self-correct.
    expect(out.steps[0].observation).toMatch(/not a real command/i);
  });

  it('passes a structured body through for multi-field commands', async () => {
    const ask = scriptedModel([
      { action: 'run', id: 'files.write', body: { filePath: 'notes.txt', content: 'hello' }, why: 'write it' },
      { action: 'done', summary: 'wrote the file' },
    ]);
    const dispatch = vi.fn(async () => okResult({ success: true }));

    await agent.run('write notes.txt', { ask, dispatch, getCommands, log: silent, yes: true });

    expect(dispatch.mock.calls[0][2].body).toEqual({ filePath: 'notes.txt', content: 'hello' });
  });

  it('honours the kernel 428 gate: asks, and aborts the whole run when the human declines', async () => {
    const ask = scriptedModel([
      { action: 'run', id: 'files.write', body: { filePath: 'x.txt', content: 'y' }, why: 'write' },
      { action: 'done', summary: 'should never be reached' },
    ]);
    const dispatch = vi.fn(async () => ({ ok: false, status: 428, data: { requiresConfirmation: true, prompt: 'Files: write x.txt — confirm to execute.' } }));
    const confirm = vi.fn(async () => false); // the human says no

    const out = await agent.run('write a file', { ask, dispatch, getCommands, log: silent, confirm });

    expect(confirm).toHaveBeenCalledOnce();
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('declined');
    expect(out.at).toBe('files.write');
    // Only the un-confirmed attempt happened; no confirmed retry.
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('retries with confirmed:true once the human approves a dangerous step', async () => {
    const ask = scriptedModel([
      { action: 'run', id: 'files.write', body: { filePath: 'x.txt', content: 'y' }, why: 'write' },
      { action: 'done', summary: 'wrote it' },
    ]);
    let calls = 0;
    const dispatch = vi.fn(async (id, arg, opts) => {
      calls++;
      if (calls === 1) return { ok: false, status: 428, data: { requiresConfirmation: true, prompt: 'confirm?' } };
      return okResult({ success: true });
    });
    const confirm = vi.fn(async () => true);

    const out = await agent.run('write a file', { ask, dispatch, getCommands, log: silent, confirm });

    expect(out.ok).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[1][2].confirmed).toBe(true);
  });

  it('--yes pre-confirms without ever asking the human', async () => {
    const ask = scriptedModel([
      { action: 'run', id: 'files.write', body: { filePath: 'x.txt', content: 'y' }, why: 'write' },
      { action: 'done', summary: 'done' },
    ]);
    let calls = 0;
    const dispatch = vi.fn(async () => (++calls === 1
      ? { ok: false, status: 428, data: { requiresConfirmation: true, prompt: 'confirm?' } }
      : okResult()));
    const confirm = vi.fn(async () => false); // would decline if consulted

    const out = await agent.run('write', { ask, dispatch, getCommands, log: silent, yes: true, confirm });

    expect(confirm).not.toHaveBeenCalled();
    expect(out.ok).toBe(true);
  });

  it('stops at the step cap instead of looping forever', async () => {
    // A model that never says done.
    const ask = vi.fn(async () => ({ action: 'run', id: 'memory_core.memory', arg: '', why: 'again' }));
    const dispatch = vi.fn(async () => okResult());

    const out = await agent.run('loop forever', { ask, dispatch, getCommands, log: silent, maxSteps: 3 });

    expect(out.ok).toBe(false);
    expect(out.reason).toBe('step-limit');
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it('surfaces an "ask" decision as needs-input rather than guessing', async () => {
    const ask = scriptedModel([{ action: 'ask', question: 'Which file did you mean?' }]);
    const dispatch = vi.fn();

    const out = await agent.run('write that file', { ask, dispatch, getCommands, log: silent });

    expect(out.ok).toBe(false);
    expect(out.reason).toBe('needs-input');
    expect(out.question).toMatch(/which file/i);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('feeds a failed step back as an ERROR observation and keeps going', async () => {
    const ask = scriptedModel([
      { action: 'run', id: 'settings.set', arg: 'set nonsense', why: 'try' },
      { action: 'done', summary: 'handled the failure' },
    ]);
    const dispatch = vi.fn(async () => ({ ok: false, status: 400, data: { error: 'unknown role' } }));

    const out = await agent.run('change a setting', { ask, dispatch, getCommands, log: silent });

    expect(out.ok).toBe(true);
    expect(out.steps[0].ok).toBe(false);
    expect(out.steps[0].observation).toMatch(/ERROR: unknown role/);
  });
});

describe('agent loop — token economy', () => {
  // The full 33-command registry is ~675 tokens, 72% of a first-step prompt,
  // and it was re-sent on EVERY step. That is what makes a free tier or a slow
  // local model unusable for a real day's work. Three fixes, tested here.
  const BIG = Array.from({ length: 33 }, (_, i) => ({
    id: `b${i}.cmd${i}`, cmd: `/cmd${i}`, blockId: `b${i}`, blockLabel: `Block ${i}`,
    title: `does thing ${i}`, available: true,
  }));

  it('shows only a relevant subset instead of the whole registry', () => {
    // Local copy — mutating the shared fixture would leak into other tests.
    const pool = BIG.map((c, i) => (i === 7 ? { ...c, title: 'save something to memory' } : c));
    const picked = agent.pickRelevant('save a memory', pool, [], 12);
    expect(picked.length).toBeLessThanOrEqual(12);
    expect(picked.map((c) => c.id)).toContain('b7.cmd7');
  });

  it('keeps commands already used this run visible, so a multi-step goal stays coherent', () => {
    const history = [{ id: 'b30.cmd30', argText: '', observation: 'ok', ok: true }];
    const picked = agent.pickRelevant('save a memory', BIG, history, 12);
    expect(picked.map((c) => c.id)).toContain('b30.cmd30');
  });

  it('falls back to the FULL list when nothing scores, rather than showing an arbitrary slice', () => {
    const picked = agent.pickRelevant('xyzzy plugh nothing matches this', BIG, [], 12);
    expect(picked).toHaveLength(BIG.length);
  });

  it('never filters when the registry is already small', () => {
    const small = BIG.slice(0, 5);
    expect(agent.pickRelevant('anything', small, [], 12)).toHaveLength(5);
  });

  it('{"action":"list"} escapes the filter — the subset is never a hard wall', async () => {
    // A goal that DOES score, so filtering actually engages. (A goal that
    // scores nothing correctly falls back to the full list, which is a
    // different behaviour, covered by its own test above.)
    const pool = Array.from({ length: 33 }, (_, i) => ({
      id: `p${i}.cmd${i}`, cmd: `/pcmd${i}`, blockId: `p${i}`, blockLabel: `P${i}`,
      title: `handles widget number ${i}`, available: true,
    }));
    const prompts = [];
    let n = 0;
    const ask = vi.fn(async (p) => {
      prompts.push(p);
      return [{ action: 'list' }, { action: 'done', summary: 'saw everything' }][Math.min(n++, 1)];
    });
    const out = await agent.run('widget', {
      ask, dispatch: vi.fn(), getCommands: async () => ({ commands: pool }),
      log: silent, catalogueLimit: 3,
    });
    expect(out.ok).toBe(true);

    const count = (p) => (p.match(/\| handles widget/g) || []).length;
    expect(count(prompts[0])).toBe(3);              // filtered
    expect(count(prompts[1])).toBe(pool.length);    // escaped to everything
    expect(prompts[0]).toMatch(/further commands exist/);
  });

  it('"final":true finishes without spending another model call', async () => {
    const ask = vi.fn(async () => ({
      action: 'run', id: 'memory_core.remember', arg: 'x',
      why: 'last step', final: true, summary: 'Saved it.',
    }));
    const dispatch = vi.fn(async () => okResult({ saved: true }));

    const out = await agent.run('save a note', { ask, dispatch, getCommands, log: silent });

    expect(out.ok).toBe(true);
    expect(out.finalizedEarly).toBe(true);
    expect(out.summary).toBe('Saved it.');
    // One model call total, not two — that is the whole point.
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('ignores "final" when the command actually failed, so the model can react', async () => {
    let n = 0;
    const ask = vi.fn(async () => (n++ === 0
      ? { action: 'run', id: 'memory_core.remember', arg: 'x', final: true, summary: 'done?' }
      : { action: 'done', summary: 'recovered after the failure' }));
    const dispatch = vi.fn(async () => ({ ok: false, status: 500, data: { error: 'boom' } }));

    const out = await agent.run('save a note', { ask, dispatch, getCommands, log: silent });

    expect(out.finalizedEarly).toBeUndefined();
    expect(ask).toHaveBeenCalledTimes(2);
    expect(out.summary).toMatch(/recovered/);
  });

  it('older observations collapse to one line; only the latest is carried in full', () => {
    const long = 'X'.repeat(600);
    const history = [
      { id: 'a.one', argText: '', observation: long, ok: true },
      { id: 'b.two', argText: '', observation: long, ok: true },
    ];
    const prompt = agent.buildPrompt('goal', [], history);
    // The newest survives in full; the older one is clipped hard.
    expect(prompt).toContain('X'.repeat(600));
    expect(prompt.match(/X{600}/g)).toHaveLength(1);
  });

  it('reports token usage so the cost of a run is visible, not guessed', async () => {
    const ask = scriptedModel([{ action: 'done', summary: 'ok' }]);
    const out = await agent.run('anything', { ask, dispatch: vi.fn(), getCommands, log: silent });
    expect(out.usage.calls).toBe(1);
    expect(out.usage.estPromptTokens).toBeGreaterThan(0);
  });
});

describe('agent loop — context safety', () => {
  it('truncates a large observation so an overnight loop cannot exhaust context', () => {
    const huge = { ok: true, status: 200, data: { ok: true, data: { blob: 'x'.repeat(50000) } } };
    const summary = agent.summarizeObservation(huge);
    expect(summary.length).toBeLessThan(1400);
    expect(summary).toMatch(/truncated, \d+ chars total/);
  });

  it('reports an error result as an ERROR line rather than silently looking like success', () => {
    expect(agent.summarizeObservation({ ok: false, status: 500, data: { error: 'boom' } })).toBe('ERROR: boom');
    expect(agent.summarizeObservation(null)).toBe('no response');
  });

  it('the catalogue tells the model the argument shape, including multi-field bodies', () => {
    const cat = agent.buildCatalogue(REGISTRY);
    expect(cat).toMatch(/files\.write \| body:\{filePath, content\} \| DANGEROUS/);
    expect(cat).toMatch(/memory_core\.remember \| arg:<text>/);
  });

  it('omits unavailable commands from what the model is allowed to pick', () => {
    const cat = agent.buildCatalogue([...REGISTRY, { id: 'x.gone', cmd: '/gone', title: 'nope', available: false }]);
    expect(cat).not.toMatch(/x\.gone/);
  });
});
