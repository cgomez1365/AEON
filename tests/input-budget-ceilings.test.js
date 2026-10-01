/**
 * inputBudgets — fractions for small windows, absolute ceilings for large ones.
 *
 * Once describeRole reports a provider's real window, a 1,000,000-token model
 * would get 120,000 tokens of memory and 250,000 of retrieved documents on a
 * single turn. The ceilings stop that without moving a single small-window
 * budget: they only bind above ~128k–267k tokens.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tokens = require('../src/kernel/tokens.cjs');
const budget = require('../services/local-runtime/budget.cjs');
const { inputBudgets } = tokens;

describe('the exports every consumer relies on', () => {
  it('keeps the estimator and adds the three ceilings', () => {
    expect(tokens.MAX_MEMORY_TOKENS).toBe(32000);
    expect(tokens.MAX_SKILL_TOKENS).toBe(8000);
    expect(tokens.MAX_RECALL_TOKENS).toBe(32000);
    for (const name of ['estimateTokens', 'estimateMessageTokens', 'detectKind', 'inputBudgets']) {
      expect(typeof tokens[name], name).toBe('function');
    }
    expect(tokens.CHARS_PER_TOKEN).toMatchObject({ prose: 4, code: 2.5, mixed: 3.2 });
  });

  it('reaches services/local-runtime/budget.cjs unchanged', () => {
    expect(budget.inputBudgets).toBe(tokens.inputBudgets);
    expect(budget.estimateTokens).toBe(tokens.estimateTokens);
  });
});

describe('small windows are what they always were', () => {
  it('8k', () => {
    expect(inputBudgets(8192)).toEqual({ contextTokens: 8192, memoryTokens: 983, skillTokens: 491, recallTokens: 2048 });
  });

  it('32k, with and without wake', () => {
    expect(inputBudgets(32768)).toMatchObject({ memoryTokens: 3932, skillTokens: 1966, recallTokens: 8192 });
    expect(inputBudgets(32768, { wake: true })).toMatchObject({ memoryTokens: 8192, skillTokens: 3932, recallTokens: 8192 });
  });

  it('still clamps and defaults the window', () => {
    expect(inputBudgets(100).contextTokens).toBe(512);
    expect(inputBudgets('not a number').contextTokens).toBe(4096);
  });
});

describe('large windows hit the ceilings', () => {
  it('a million-token window gets the ceilings, and keeps its window', () => {
    expect(inputBudgets(1000000)).toEqual({ contextTokens: 1000000, memoryTokens: 32000, skillTokens: 8000, recallTokens: 32000 });
  });

  it.each([
    [266666, {}, 'memoryTokens', 31999],
    [266667, {}, 'memoryTokens', 32000],
    [300000, {}, 'memoryTokens', 32000],
    [128000, {}, 'recallTokens', 32000],
    [200000, {}, 'recallTokens', 32000],
    [133333, {}, 'skillTokens', 7999],
    [140000, {}, 'skillTokens', 8000],
    [200000, { wake: true }, 'memoryTokens', 32000],
  ])('window %i %o → %s %i', (window, opts, field, expected) => {
    expect(inputBudgets(window, opts)[field]).toBe(expected);
  });
});

describe('per-call overrides of a ceiling', () => {
  it('replace only the budget they name', () => {
    expect(inputBudgets(1000000, { maxMemoryTokens: 1000 })).toMatchObject({ memoryTokens: 1000, skillTokens: 8000, recallTokens: 32000 });
  });

  it('take 0 at its word, and treat null as absent', () => {
    expect(inputBudgets(1000000, { maxRecallTokens: 0 }).recallTokens).toBe(0);
    expect(inputBudgets(1000000, { maxSkillTokens: null }).skillTokens).toBe(8000);
  });
});
