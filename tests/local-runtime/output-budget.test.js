/**
 * BO-D1a / D1f — the output budget must be arithmetic, and one unit.
 *
 * THE DEFECT THIS SUITE EXISTS FOR (2026-08-05): every long answer the
 * operator asked for stopped at roughly 750 tokens. The activity feed shows
 * it three times over — 701, 730, 743. That was not the model choosing to
 * stop. Three unrelated numbers were fighting: max_tokens hardcoded 512, a
 * 180-second wall clock, and n_ctx clamped to 8192. No setting the operator
 * could reach moved any of them.
 *
 * The trap this file guards: raising max_tokens ALONE makes things worse.
 * The request then runs past the wall clock and returns nothing instead of a
 * partial file. The budget only means something when it is derived from the
 * window every other number also comes out of.
 *
 * These drive the real module. Nothing is re-implemented inline.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const budget = require('../../services/local-runtime/budget.cjs');

describe('output budget arithmetic', () => {
  it('is window minus prompt minus margin, not a constant', () => {
    const b = budget.outputBudget({ contextTokens: 8192, promptTokens: 1000, margin: 512 });
    expect(b.maxTokens).toBe(8192 - 1000 - 512);
    expect(b.fits).toBe(true);
  });

  it('shrinks as the prompt grows — the property 512 never had', () => {
    // long mode, so the default cap is not the binding constraint and the
    // relationship to prompt size is what is actually under test.
    const small = budget.outputBudget({ contextTokens: 32768, promptTokens: 500, long: true });
    const large = budget.outputBudget({ contextTokens: 32768, promptTokens: 20000, long: true });
    expect(large.maxTokens).toBeLessThan(small.maxTokens);
    expect(small.maxTokens + 500).toBeLessThanOrEqual(32768);
    expect(large.maxTokens + 20000).toBeLessThanOrEqual(32768);
  });

  it('grows with the window — 32k must not answer like 8k', () => {
    const at8k = budget.outputBudget({ contextTokens: 8192, promptTokens: 1000 });
    const at32k = budget.outputBudget({ contextTokens: 32768, promptTokens: 1000 });
    expect(at32k.maxTokens).toBeGreaterThan(at8k.maxTokens);
  });

  it('never lets input plus output exceed the window', () => {
    // The invariant. Overflow evicts from the front, which silently deletes
    // the system prompt and the MEMORY block.
    for (const ctx of [2048, 8192, 32768, 131072]) {
      for (const prompt of [0, 100, 1000, 7000, 30000]) {
        const b = budget.outputBudget({ contextTokens: ctx, promptTokens: prompt, long: true });
        if (b.fits) expect(prompt + b.maxTokens).toBeLessThanOrEqual(ctx);
      }
    }
  });

  it('reserves a margin so overflow cannot evict the system prompt', () => {
    const b = budget.outputBudget({ contextTokens: 8192, promptTokens: 1000, margin: 512, long: true });
    expect(b.maxTokens).toBeLessThanOrEqual(8192 - 1000 - 512);
  });

  it('caps a normal turn but releases the remainder in long mode', () => {
    const normal = budget.outputBudget({ contextTokens: 131072, promptTokens: 1000 });
    const long = budget.outputBudget({ contextTokens: 131072, promptTokens: 1000, long: true });

    expect(normal.maxTokens).toBe(budget.DEFAULT_OUTPUT_CAP);
    expect(normal.limitedBy).toBe('cap');
    expect(long.maxTokens).toBeGreaterThan(normal.maxTokens);
    expect(long.limitedBy).toBe('context');
  });

  it('refuses honestly when the prompt has eaten the window', () => {
    const b = budget.outputBudget({ contextTokens: 2048, promptTokens: 2000 });
    expect(b.fits).toBe(false);
    // §08: an error must name the numbers and the remedy.
    expect(b.reason).toMatch(/2,048|2,000/);
    expect(b.reason).toMatch(/Shorten|larger context/i);
  });

  it('honours an explicit caller ceiling without exceeding the window', () => {
    const b = budget.outputBudget({ contextTokens: 32768, promptTokens: 1000, requested: 300 });
    expect(b.maxTokens).toBe(300);
    expect(b.limitedBy).toBe('requested');
  });

  it('the 750-token ceiling is gone at a realistic window', () => {
    // The headline. An 8B at the 32,768 this machine can now serve, with a
    // typical loaded prompt, must permit far more than 750 tokens out.
    const b = budget.outputBudget({ contextTokens: 32768, promptTokens: 2500 });
    expect(b.maxTokens).toBeGreaterThan(5000);
  });
});

describe('one unit — tokens, not characters', () => {
  it('counts code denser than prose', () => {
    const prose = 'the quick brown fox jumps over the lazy dog and keeps running along. '.repeat(20);
    const code = 'const x = foo({ a: 1, b: [2,3] }); if (x && y) { return x?.z ?? 0; }\n'.repeat(20);
    expect(budget.detectKind(prose)).toBe('prose');
    expect(budget.detectKind(code)).toBe('code');
    // Same length, more tokens for code — the reconciliation D1f asks for.
    const same = code.slice(0, prose.length);
    expect(budget.estimateTokens(same)).toBeGreaterThan(budget.estimateTokens(prose));
  });

  it('input budgets scale with the window instead of being fixed characters', () => {
    const at8k = budget.inputBudgets(8192);
    const at32k = budget.inputBudgets(32768);
    expect(at32k.memoryTokens).toBeGreaterThan(at8k.memoryTokens);
    expect(at32k.skillTokens).toBeGreaterThan(at8k.skillTokens);
  });

  it('memory and skills together cannot consume the whole window', () => {
    for (const ctx of [4096, 8192, 32768]) {
      for (const wake of [false, true]) {
        const b = budget.inputBudgets(ctx, { wake });
        expect(b.memoryTokens + b.skillTokens).toBeLessThan(ctx * 0.5);
      }
    }
  });

  it('a wake turn gets more room, still bounded', () => {
    const normal = budget.inputBudgets(32768, { wake: false });
    const wake = budget.inputBudgets(32768, { wake: true });
    expect(wake.memoryTokens).toBeGreaterThan(normal.memoryTokens);
  });

  it('estimates message arrays including per-message framing', () => {
    const msgs = [{ role: 'system', content: 'x'.repeat(400) }, { role: 'user', content: 'y'.repeat(400) }];
    const n = budget.estimateMessageTokens(msgs);
    expect(n).toBeGreaterThan(budget.estimateTokens('x'.repeat(800)));
  });
});
