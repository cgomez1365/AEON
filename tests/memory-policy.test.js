/**
 * BO-D2a — memory must be true.
 *
 * THE DEFECTS THIS SUITE EXISTS FOR (2026-08-05), all four observed on a
 * running install:
 *
 *   #8   Chat replied "User data saved". Nothing was written. That string
 *        appears NOWHERE in the codebase — the auto-extract loop is gated on
 *        `prefs.brain_settings.auto_memory`, which is undefined by default,
 *        so the extractor never ran and the model's prose filled the silence.
 *        Memory Core read 0 MEMORIES throughout.
 *   #9   The vault held "final fantasy 7" and the model answered "Final
 *        Fantasy V". Stored, injected, and then overridden — which is worse
 *        than no memory, because it looks like it works.
 *   #10  Facts stored in second person: "[fact] your name is Cristian" sat
 *        beside "[fact] I am Nanaki". Injected into a system prompt, "your"
 *        addresses the model, so the model read it as its own name.
 *   #11  Eviction was a bare `break` in TWO places — chat-stream.cjs:66 and
 *        memory_core/api/memory.cjs:148. Memory silently vanished from the
 *        injection with no count, no warning, nothing.
 *
 * The through-line is §26: operator-owned state is the moat, and memory that
 * lies fails in the one direction the operator cannot detect.
 *
 * These drive the real module. Nothing is re-implemented inline.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const policy = require('../src/kernel/memory-policy.cjs');

const mem = (text, extra = {}) => ({ text, timestamp: Date.now(), category: 'fact', ...extra });

describe('#10 — a stored fact must be about the operator, in third person', () => {
  it('rewrites second person, which addresses the model', () => {
    const r = policy.normalizeFactPerson('your name is Cristian');
    expect(r.text).toMatch(/operator/i);
    expect(r.text).not.toMatch(/\byour\b/i);
    expect(r.changed).toBe(true);
  });

  it('rewrites first person, the source of "I am Nanaki"', () => {
    const r = policy.normalizeFactPerson('I am Nanaki');
    expect(r.text).not.toMatch(/^I am\b/);
    expect(r.text).toMatch(/operator/i);
    expect(r.changed).toBe(true);
  });

  it('leaves an already third-person fact alone', () => {
    const r = policy.normalizeFactPerson('The operator prefers terse output.');
    expect(r.text).toBe('The operator prefers terse output.');
    expect(r.changed).toBe(false);
  });

  it('does not maul a fact that merely contains the word "your"', () => {
    // "Broken Gear is your brand" is second person; "the Yourdon method" is
    // not. Word-boundary matching, not substring.
    const r = policy.normalizeFactPerson('Uses the Yourdon method for diagrams');
    expect(r.text).toBe('Uses the Yourdon method for diagrams');
    expect(r.changed).toBe(false);
  });

  it('flags first person it cannot safely rewrite, rather than mangling it', () => {
    // Found live: "I am Nanaki and I run Broken Gear" normalises the leading
    // clause and leaves the second. Rewriting that one would produce "the
    // operator run" — changing the subject changes verb agreement, and a
    // rewriter that breaks grammar to satisfy a rule is worse than one that
    // admits its limit. So it is reported, not hidden.
    const r = policy.normalizeFactPerson('I am Nanaki and I run Broken Gear');
    expect(r.text).toMatch(/^The operator is Nanaki/);
    expect(r.residualPerson).toBe(true);
  });

  it('a clean third-person fact carries no residual flag', () => {
    const r = policy.normalizeFactPerson('The operator prefers terse output.');
    expect(r.residualPerson).toBe(false);
  });

  it('does not mistake an initial or a capital I in prose for a pronoun', () => {
    const r = policy.normalizeFactPerson('The operator uses Roman numeral I for the first phase');
    // A bare capital I IS matched — that is deliberate over-reporting on a
    // flag whose only cost is a visible warning, never a rewrite.
    expect(r.text).toBe('The operator uses Roman numeral I for the first phase');
    expect(r.changed).toBe(false);
  });

  it('is idempotent — normalising twice changes nothing further', () => {
    const once = policy.normalizeFactPerson('your name is Cristian');
    const twice = policy.normalizeFactPerson(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.changed).toBe(false);
  });
});

describe('#11 — eviction must be counted, never silent', () => {
  const many = Array.from({ length: 40 }, (_, i) => mem(`fact number ${i} with some padding text to spend budget`));

  it('reports what it dropped', () => {
    const r = policy.selectForInjection({ memories: many, budgetTokens: 60 });
    expect(r.considered).toBe(40);
    expect(r.injected).toBeLessThan(40);
    expect(r.dropped).toBe(r.considered - r.injected);
    expect(r.dropped).toBeGreaterThan(0);
  });

  it('never exceeds the token budget it was given', () => {
    for (const budget of [20, 60, 200, 1000]) {
      const r = policy.selectForInjection({ memories: many, budgetTokens: budget });
      expect(r.tokensUsed).toBeLessThanOrEqual(budget);
    }
  });

  it('drops nothing when everything fits, and says so', () => {
    const r = policy.selectForInjection({ memories: [mem('short one')], budgetTokens: 500 });
    expect(r.dropped).toBe(0);
    expect(r.injected).toBe(1);
  });

  it('pinned memories are never the ones evicted', () => {
    // Pinned being the durable layer and eviction being invisible cannot both
    // be true. Under a real squeeze — enough room for some memories but not
    // all — the pinned one must be among the survivors.
    const set = [...many, mem('THE PINNED ONE', { pinned: true })];
    const r = policy.selectForInjection({ memories: set, budgetTokens: 200 });
    expect(r.dropped).toBeGreaterThan(0);          // a genuine squeeze
    expect(r.injected).toBeGreaterThan(0);
    expect(r.text).toMatch(/THE PINNED ONE/);
  });

  it('a budget too small even for the precedence header injects nothing', () => {
    // The header carries a fixed cost, and it is not optional: memory with no
    // stated precedence is what produced #9. So a budget below that cost
    // yields no injection rather than facts the model is free to overrule.
    // It must still account for every memory it declined.
    const r = policy.selectForInjection({ memories: many, budgetTokens: 1 });
    expect(r.injected).toBe(0);
    expect(r.dropped).toBe(40);
    expect(r.text).toBe('');
    expect(r.considered).toBe(40);
  });
});

describe('#9 — an injected fact must outrank the model to be worth injecting', () => {
  it('the injected block states that stored facts win', () => {
    const r = policy.selectForInjection({ memories: [mem('favourite game is final fantasy 7')], budgetTokens: 500 });
    // Without an explicit precedence instruction the model answered "Final
    // Fantasy V" over a stored "final fantasy 7". The block has to say which
    // source wins, or injection is just suggestion.
    expect(r.text).toMatch(/ground truth|authoritative|outrank|overrides/i);
  });

  it('says nothing at all when there is nothing to inject', () => {
    // An empty MEMORY header is its own small lie.
    const r = policy.selectForInjection({ memories: [], budgetTokens: 500 });
    expect(r.text).toBe('');
    expect(r.injected).toBe(0);
  });
});

describe('#8 — the product must not claim a save it did not make', () => {
  it('states plainly when auto-capture is off', () => {
    const s = policy.describeMemoryState({ autoMemoryEnabled: false, injected: 3 });
    expect(s).toMatch(/not saved|will not be saved|off/i);
    // And it must forbid the specific behaviour observed: the model
    // announcing a save that never happened.
    expect(s).toMatch(/do not (claim|tell)/i);
  });

  it('when auto-capture is on, still forbids inventing confirmations', () => {
    const s = policy.describeMemoryState({ autoMemoryEnabled: true, injected: 3 });
    expect(s).toMatch(/do not (claim|tell)/i);
  });

  it('the state is reported as a fact, not implied by silence', () => {
    const off = policy.describeMemoryState({ autoMemoryEnabled: false, injected: 0 });
    expect(off.length).toBeGreaterThan(0);
  });
});
