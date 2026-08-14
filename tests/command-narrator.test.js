/**
 * A command result, read back as a sentence — without becoming a liar.
 *
 * BO-SHIP P7. CEO request: "after any slash command executes, the chat model
 * reads it back as text, not a code window."
 *
 * The feature is one bad prompt away from being a false-green generator, which
 * is the defect this entire build order exists to remove. §22: a false green
 * ends an investigation; a visible error invites one. So the tests below are
 * mostly about the ways narration must REFUSE to speak rather than the ways it
 * speaks.
 *
 * The load-bearing rule: a FAILED command must never be narrated as success.
 * The model is told the outcome as a fact, and the output is checked against
 * that fact afterwards — belt and braces, because a prompt instruction is a
 * request and this needs to be a guarantee.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  narrate,
  buildPrompt,
  deterministicNarration,
  contradictsOutcome,
  summarizeForPrompt,
} = require('../src/kernel/commandNarrator.cjs');

describe('deterministic narration — always available, never wrong', () => {
  it('states a failure as a failure', () => {
    const out = deterministicNarration({ cmd: '/write', ok: false, error: 'rate limited' });
    expect(out).toMatch(/did not run/);
    expect(out).toMatch(/rate limited/);
  });

  it('counts array results', () => {
    expect(deterministicNarration({ cmd: '/docs', ok: true, data: [1, 2, 3] })).toMatch(/3 items/);
    expect(deterministicNarration({ cmd: '/docs', ok: true, data: [1] })).toMatch(/1 item\b/);
  });

  it('prefers a sentence the handler already wrote', () => {
    const out = deterministicNarration({ cmd: '/set', ok: true, text: 'chat → gemini / gemini-2.0-flash' });
    expect(out).toBe('chat → gemini / gemini-2.0-flash');
  });
});

describe('the outcome guard', () => {
  it('catches success language on a failed command', () => {
    expect(contradictsOutcome('The command succeeded and wrote the file.', false)).toBe(true);
    expect(contradictsOutcome('Completed successfully.', false)).toBe(true);
  });

  it('allows failure language that mentions success words in context', () => {
    expect(contradictsOutcome('The command did not succeed — the provider was rate limited.', false)).toBe(false);
    expect(contradictsOutcome('It failed; a previous run had succeeded.', false)).toBe(false);
  });

  it('never fires on a successful command', () => {
    expect(contradictsOutcome('The command succeeded.', true)).toBe(false);
  });
});

describe('narrate()', () => {
  const failing = { cmd: '/write', ok: false, error: 'groq rate limited (429)', data: null };

  it('uses the handler sentence without spending a model call', async () => {
    let called = false;
    const llm = async () => { called = true; return 'x'; };
    const out = await narrate({ cmd: '/set', ok: true, text: 'chat → gemini / flash' }, llm);
    expect(out.source).toBe('handler');
    expect(out.narration).toBe('chat → gemini / flash');
    expect(called, 'a model was called for a result the handler had already written').toBe(false);
  });

  it('discards a narration that contradicts a failure', async () => {
    const llm = async () => 'The command succeeded and everything is fine.';
    const out = await narrate(failing, llm);
    expect(out.source).toBe('deterministic');
    expect(out.discarded).toBe('contradicted-outcome');
    expect(out.narration).toMatch(/did not run/);
  });

  it('falls back rather than inventing when the model is rate-limited', async () => {
    const llm = async () => { throw new Error('Groq API error 429'); };
    const out = await narrate(failing, llm);
    expect(out.source).toBe('deterministic');
    expect(out.llmError).toMatch(/429/);
    expect(out.narration).toMatch(/did not run/);
  });

  it('falls back when the model returns nothing', async () => {
    const out = await narrate({ cmd: '/docs', ok: true, data: [] }, async () => '   ');
    expect(out.source).toBe('deterministic');
    expect(out.narration).toBeTruthy();
  });

  it('works with no model at all', async () => {
    const out = await narrate({ cmd: '/docs', ok: true, data: [1, 2] }, null);
    expect(out.source).toBe('deterministic');
    expect(out.narration).toMatch(/2 items/);
  });

  // R-05: the sentence is a rendering, never a replacement.
  it('always returns the raw payload alongside the prose', async () => {
    const out = await narrate({ cmd: '/gpu', ok: true, data: { gpus: [{ name: 'GTX 1050' }] } }, async () => 'One GPU found.');
    expect(out.raw.data.gpus[0].name).toBe('GTX 1050');
    expect(out.raw.ok).toBe(true);
  });

  it('passes a model narration through when it does not contradict', async () => {
    const out = await narrate({ cmd: '/gpu', ok: true, data: { gpus: [] } }, async () => 'No GPUs were detected.');
    expect(out.source).toBe('model');
    expect(out.narration).toBe('No GPUs were detected.');
  });
});

describe('the prompt states the outcome as a fact', () => {
  it('tells the model a failure is a failure, twice', () => {
    const p = buildPrompt({ cmd: '/write', ok: false, error: 'boom' });
    expect(p).toMatch(/Outcome: FAILED/);
    expect(p).toMatch(/The command FAILED\. Say so\./);
    expect(p).toMatch(/Never describe a failure as a success/);
  });

  it('forbids invention explicitly', () => {
    expect(buildPrompt({ cmd: '/docs', ok: true, data: [] }))
      .toMatch(/Never invent a number, name, file, or status/);
  });

  it('carries only the payload it was given', () => {
    const p = buildPrompt({ cmd: '/docs', ok: true, data: { secret: 'value-42' } });
    expect(p).toMatch(/value-42/);       // the real data reaches the model
    expect(p).not.toMatch(/undefined/);   // and nothing else does
  });
});

describe('payload summarisation', () => {
  it('keeps a big array readable and says how much was cut', () => {
    const out = summarizeForPrompt(Array.from({ length: 500 }, (_, i) => ({ id: i, note: 'x'.repeat(40) })));
    expect(out).toMatch(/more items \(500 total\)/);
    expect(out.length).toBeLessThan(6000);
  });

  it('survives a circular structure instead of throwing', () => {
    const a = { name: 'a' };
    a.self = a;
    expect(() => summarizeForPrompt(a)).not.toThrow();
  });
});
