/**
 * The terminal's argument splitter runs in linear time (CodeQL, 2026-10-03).
 *
 * It was the regex /"([^"]*)"|'([^']*)'|<([^>]*)>|(\S+)/g, which rescanned the
 * rest of the line for every unclosed "<" — quadratic on "<= <= <= …", typed
 * or pasted into the terminal. The replacement must split exactly as the
 * regex did, and must not slow down on that input.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { tokenizeArgs } = require('../src/kernel/commandRegistry.cjs');

// The old splitter, kept here only as the reference for equivalence.
const regexSplit = (text) => {
  const out = []; const re = /"([^"]*)"|'([^']*)'|<([^>]*)>|(\S+)/g; let m;
  while ((m = re.exec(String(text || '')))) out.push((m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').trim());
  return out;
};

describe('tokenizeArgs', () => {
  it('splits exactly as the old regex did', () => {
    const cases = ['', '   ', 'a b  c', '"two words" x', "'q s' y", '<a b> c', '<= <= <=', 'abc"def ghi" j',
      '""', '<>', '"unclosed rest', '<unclosed rest', 'x<y>z', '/cmd "a" \'b\' <c d> e', 'tab\tsep\nline',
      '"a""b"', '<<a>>', "'it''s'", null, undefined];
    for (const c of cases) expect(tokenizeArgs(c), JSON.stringify(c)).toEqual(regexSplit(c));
    // And on random strings over the characters that matter.
    const al = 'ab <>"\' \t';
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let n = 0; n < 2000; n++) {
      let s = ''; const len = Math.floor(rnd() * 20);
      for (let i = 0; i < len; i++) s += al[Math.floor(rnd() * al.length)];
      expect(tokenizeArgs(s), JSON.stringify(s)).toEqual(regexSplit(s));
    }
  });

  it('stays linear on unclosed brackets ("<= " x 100,000 in well under a second)', () => {
    const big = '<= '.repeat(100000);
    const t0 = performance.now();
    const parts = tokenizeArgs(big);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(parts).toHaveLength(100000);
  });
});
