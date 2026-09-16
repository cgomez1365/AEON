/**
 * The boot gate DRAWS the mark. It does not approximate it, and it no longer
 * <img>s it.
 *
 * What this replaces: until now the gate's canvas drew a system of its own
 * invention — drawAeonMark() built a chevron out of screen-fraction constants
 * (outerApexY = -S * .120 and five siblings, none of them the emblem's), and
 * outerSystem/middleSystem/innerSystem drew rings at .335/.245/.142 of an
 * arbitrary S with hand-picked arc spans. Next to it, in the copy block, sat an
 * <img> of the real mark at 48px. The gate therefore showed the emblem twice
 * and agreed with itself on neither the geometry nor the count. The badge is
 * gone (brand-mark.test.js §3 dropped its floor from 5 to 4 the same day) and
 * the canvas now draws the file's own numbers.
 *
 * So the invariant that was carried by "there is an <img> of the mark here" has
 * to be carried by something, or removing the <img> would quietly remove the
 * mark from this surface altogether. This is that something. Every number
 * below is CROSS-CHECKED against public/brand/aeon-mark/aeon-mark.svg rather
 * than written out twice, so editing either file alone fails — which is the
 * only way a derivation gate is worth anything.
 *
 * Numbers are read from the code with comments stripped: a radius promised in
 * prose is not a radius being drawn.
 *
 * Both halves of that claim are enforced, which took a second pass. The first
 * cut asserted on the MARK table and on the SHAPE of the drawing code, and
 * never on the two meeting: four mutations that left MARK byte-correct while
 * drawing a different mark — a ring at 160 * k, a 3 * k stroke, nodes at
 * 150/40, a chevron grown 1.4x inside chevronPath() — all went green. So every
 * field is now pinned at its CONSUMPTION SITE as well, and each of those four
 * mutations is a control in the last section.
 *
 * The last section runs every probe against a deliberately broken copy of the
 * source and asserts it goes red. A gate nobody has seen fail is a gate nobody
 * knows the state of.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(ROOT, 'src', 'blocks', 'security', 'AeonBootGate.jsx');
const SVG = path.join(ROOT, 'public', 'brand', 'aeon-mark', 'aeon-mark.svg');

const read = (p) => fs.readFileSync(p, 'utf8');
/** Strip JS comments — prose is not code. */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
/** Strip XML comments, same reason. */
const markup = (s) => s.replace(/<!--[\s\S]*?-->/g, '');

const RAW = read(GATE);
const SRC = code(RAW);
const SVG_SRC = markup(read(SVG));

// ── The SVG's own geometry, read off the file ───────────────────────────────
const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]+)"/g)].map((m) => [m[1], m[2]]));
const svgCircles = [...SVG_SRC.matchAll(/<circle\b([^>]*)>/g)].map((m) => attrs(m[1]));
const svgRing = svgCircles.find((c) => c['stroke-dasharray']);
const svgNodes = svgCircles.filter((c) => c !== svgRing && Number(c.r) < 60);
const svgInner = svgCircles.find((c) => c !== svgRing && !svgNodes.includes(c));
const svgChevD = SVG_SRC.match(/<path\b[^>]*\bd="([^"]+)"/)[1];
const vertices = (d) => [...d.matchAll(/[ML]\s*(-?[\d.]+)\s+(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
/** Degrees on the 512-box, centre 256,256 — how the gate names the node seats. */
const seat = (c) => {
  const dx = Number(c.cx) - 256, dy = Number(c.cy) - 256;
  return { r: Math.hypot(dx, dy), deg: ((Math.atan2(dy, dx) / Math.PI * 180) % 360 + 360) % 360 };
};

// ── The gate's own geometry, read off the code ──────────────────────────────
/** Evaluate a top-level `const NAME = <literal>;` out of the source. */
function literal(src, name) {
  const m = src.match(new RegExp(`\\bconst ${name} = ([\\s\\S]*?);\\n`));
  if (!m) throw new Error(`the gate no longer declares ${name}`);
  // eslint-disable-next-line no-new-func
  return Function(`"use strict"; return (${m[1]});`)();
}
/**
 * The text of a top-level `function NAME(...) { ... }`, brace-matched.
 * The parameter list is walked first: `function AeonLockup({ className })`
 * opens a brace before the body does, and the first cut of this helper
 * returned the destructuring pattern and called it the function.
 */
function body(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`the gate no longer defines ${name}()`);
  let j = src.indexOf('(', start), parens = 0;
  for (; j < src.length; j++) {
    if (src[j] === '(') parens++;
    else if (src[j] === ')' && --parens === 0) break;
  }
  let depth = 0;
  for (j = src.indexOf('{', j); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`${name}() never closes`);
}

/**
 * The mark's drawing code, both halves. theMark() moves and markStill() does
 * not — the still half is pre-rendered — but between them they are every line
 * of the emblem, and the point of reading them is that a probe on the constant
 * table alone cannot tell you which of those numbers ever reached a ctx.arc().
 */
const markCode = (src) => `${body(src, 'theMark')}\n${body(src, 'markStill')}`;

const MARK = literal(SRC, 'MARK');
const LOOP = literal(SRC, 'LOOP');
const CHEVRON_D = literal(SRC, 'CHEVRON_D');
const CHEVRON_BOX = literal(SRC, 'CHEVRON_BOX');
const MARK_CODE = markCode(SRC);

// ─────────────────────────────────────────────────────────────────────────────
describe('1. the boot gate draws the mark, at the mark\'s own numbers', () => {
  it('the outer ring is the SVG\'s: r 205, stroke 14, dash 257.61/64.40, rotated -36', () => {
    expect(MARK.ringR).toBe(205);
    expect(MARK.ringW).toBe(14);
    expect(MARK.dash).toEqual([257.61, 64.40]);
    expect(MARK.ringRot).toBe(-36);
    // and each of those is what the vector says, not a coincidence.
    expect(MARK.ringR).toBe(Number(svgRing.r));
    expect(MARK.ringW).toBe(Number(svgRing['stroke-width']));
    expect(MARK.dash).toEqual(svgRing['stroke-dasharray'].trim().split(/\s+/).map(Number));
    expect(MARK.ringRot).toBe(Number(svgRing.transform.match(/rotate\((-?[\d.]+)/)[1]));
    // and the canvas draws THOSE fields, not numbers of its own that happen to agree
    expect(MARK_CODE, 'the ring is arced at MARK.ringR').toMatch(/ctx\.arc\(0, 0, MARK\.ringR \* k,/);
    expect(MARK_CODE, 'and stroked at MARK.ringW').toMatch(/softStroke\(ctx, T, k, T\.ring, MARK\.ringW \* k,/);
    expect(MARK_CODE, 'and dashed on MARK.dash').toMatch(/setLineDash\(\[MARK\.dash\[0\] \* k, MARK\.dash\[1\] \* k\]\)/);
    expect(MARK_CODE, 'and seated from MARK.ringRot').toMatch(/MARK\.ringRot\s*\+/);
  });

  it('the three nodes are the SVG\'s: r 24, stroke 10, on radius 218 at 315/45/180 degrees', () => {
    expect(MARK.nodeSize).toBe(24);
    expect(MARK.nodeW).toBe(10);
    expect(MARK.nodeR).toBe(218);
    expect([...MARK.nodeAng].sort((a, b) => a - b)).toEqual([45, 180, 315]);

    expect(svgNodes).toHaveLength(3);
    for (const c of svgNodes) {
      expect(Number(c.r)).toBe(MARK.nodeSize);
      expect(Number(c['stroke-width'])).toBe(MARK.nodeW);
      expect(seat(c).r).toBeCloseTo(MARK.nodeR, 1);
    }
    expect(svgNodes.map((c) => Math.round(seat(c).deg)).sort((a, b) => a - b))
      .toEqual([...MARK.nodeAng].sort((a, b) => a - b));

    expect(MARK_CODE, 'the nodes orbit at MARK.nodeR, MARK.nodeSize across')
      .toMatch(/Math\.cos\(ang\) \* MARK\.nodeR \* k, Math\.sin\(ang\) \* MARK\.nodeR \* k, MARK\.nodeSize \* k/);
    expect(MARK_CODE, 'and are stroked at MARK.nodeW').toMatch(/softStroke\(ctx, T, k, T\.node, MARK\.nodeW \* k,/);
    expect(MARK_CODE, 'and are seated from MARK.nodeAng').toMatch(/MARK\.nodeAng\[i\]/);
  });

  it('the inner ring is the SVG\'s: r 118, stroke 9', () => {
    expect(MARK.innerR).toBe(118);
    expect(MARK.innerW).toBe(9);
    expect(MARK.innerR).toBe(Number(svgInner.r));
    expect(MARK.innerW).toBe(Number(svgInner['stroke-width']));

    expect(MARK_CODE, 'the inner ring is arced at MARK.innerR').toMatch(/ctx\.arc\(0, 0, MARK\.innerR \* k,/);
    expect(MARK_CODE, 'and stroked at MARK.innerW').toMatch(/softStroke\(ctx, T, k, T\.inner, MARK\.innerW \* k,/);
  });

  it('the chevron is the SVG\'s own six vertices, solid, no crossbar', () => {
    expect(MARK.chev).toHaveLength(6);
    expect(MARK.chev).toEqual([[183, 328], [256, 192], [329, 328], [307, 328], [256, 233], [205, 328]]);
    expect(MARK.chev).toEqual(vertices(svgChevD));
    // the canvas path closes the six points and FILLS them
    expect(body(SRC, 'chevronPath')).toMatch(/closePath\(\)/);
    expect(MARK_CODE).toMatch(/chevronPath\(ctx, k\);\s*ctx\.fill\(\)/);
    // and it takes the vertices as they are: k scales them and nothing else does
    expect(body(SRC, 'chevronPath'), 'no factor of its own between the file and the path')
      .toMatch(/\(MARK\.chev\[i\]\[0\] - 256\) \* k, y = \(MARK\.chev\[i\]\[1\] - 256\) \* k;/);
  });

  it('every line of the mark carries a soft halo: a wide half-strength pass under a crisp pass', () => {
    const soft = body(SRC, 'softStroke');
    expect(soft).toMatch(/globalAlpha = \.55/);
    expect(soft).toMatch(/globalAlpha = 1/);
    expect((soft.match(/ctx\.stroke\(\)/g) || [])).toHaveLength(2);
    for (const layer of ['T.ring', 'T.node', 'T.inner']) {
      expect(MARK_CODE, `${layer} must go through softStroke`).toMatch(new RegExp(`softStroke\\(ctx, T, k, ${layer.replace('.', '\\.')}`));
    }
  });

  it('both halves are reached, and the pre-rendered one is the same code', () => {
    // The still half is cached, so "the canvas draws the mark" now has a second
    // way to go wrong: the live path could be right and the cached path could
    // draw something else, and every frame after the first would be the cache.
    expect(body(SRC, 'theMark'), 'the live path falls through to the still half')
      .toMatch(/else markStill\(ctx, k, T\)/);
    expect(body(SRC, 'buildStill'), 'and the pre-rendered layer paints that same function')
      .toMatch(/markStill\(g, k, T\)/);
    expect(body(SRC, 'drawFinal'), 'the mark goes down last, which is what makes caching its tail safe')
      .toMatch(/theMark\(ctx, k, p, T, opts\.still\);\s*ctx\.restore\(\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('2. the motion is the animated README banner\'s', () => {
  it('the loop is 12.67s and p is the only clock', () => {
    expect(LOOP).toBe(12.67);
    expect(body(SRC, 'drawFinal')).toMatch(/\(t % LOOP\) \/ LOOP/);
  });

  it('the outer ring turns +90 degrees per loop and the three nodes -360', () => {
    const mark = body(SRC, 'theMark');
    expect(mark, 'outer ring: +90 per loop').toMatch(/MARK\.ringRot\s*\+\s*p\s*\*\s*90\b/);
    expect(mark, 'nodes: -360 per loop, one whole turn the other way').toMatch(/MARK\.nodeAng\[i\]\s*-\s*p\s*\*\s*360\b/);
  });

  it('the inner ring and the chevron are STILL', () => {
    const still = body(SRC, 'markStill');
    expect(still, 'the still half is not handed a clock').toMatch(/^function markStill\(ctx, k, T\) \{/);
    expect(still, 'and does not reach for one').not.toMatch(/\bp\b/);
    const mark = body(SRC, 'theMark');
    const after = mark.slice(mark.indexOf('markStill'));
    expect(after, 'nor does anything after it').not.toMatch(/\bp\b/);
  });

  it('the data stream runs OUTWARD from the core, three crossings per loop', () => {
    const s = body(SRC, 'stream');
    expect(s).toMatch(/p \* 3\b/);
    // r grows with the phase: it starts at rStart and reaches rEnd.
    expect(s).toMatch(/rStart \+ Math\.pow\(ph, 0\.78\) \* \(rEnd - rStart\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('3. the emblem appears exactly once, and the things left out stay out', () => {
  it('the gate carries no <img> of the mark — the animation IS the emblem', () => {
    expect(SRC, 'the 48px badge was deleted; the canvas draws the mark now').not.toMatch(/<img\b/);
    expect(SRC, 'no /brand/ asset is loaded by this file').not.toMatch(/\/brand\//);
  });

  it('the invented geometry it replaced is gone', () => {
    for (const dead of ['drawAeonMark', 'outerSystem', 'middleSystem', 'innerSystem', 'satellites', 'drawAxes', 'drawGrid']) {
      expect(SRC, `${dead}() drew a mark that was not the mark`).not.toMatch(new RegExp(`\\b${dead}\\b`));
    }
  });

  it('no bearing numerals, no line through the middle, no frosted glass on the canvas', () => {
    expect(SRC, 'bearing numerals were cut').not.toMatch(/fillText|strokeText/);
    expect(SRC, 'no chord or crosshair across the centre').not.toMatch(/drawAxes|crosshair|chord/i);
    expect(SRC, 'the canvas has no backdrop filter of its own').not.toMatch(/ctx\.filter/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('4. the lockup is the mark\'s chevron, and it still says AEON out loud', () => {
  const lockup = body(SRC, 'AeonLockup');

  it('the chevron is the mark\'s own path, cropped to itself, filled with currentColor', () => {
    expect(vertices(CHEVRON_D)).toEqual(MARK.chev);
    const xs = MARK.chev.map((v) => v[0]), ys = MARK.chev.map((v) => v[1]);
    const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
    expect(CHEVRON_BOX.trim().split(/\s+/).map(Number), 'viewBox is the chevron\'s own bounds').toEqual(box);
    expect(lockup).toMatch(/fill="currentColor"/);
  });

  it('a screen reader hears one word: the wrapper is named AEON and the svg is hidden', () => {
    expect(lockup).toMatch(/aria-label="AEON"/);
    expect(lockup).toMatch(/role="img"/);
    expect(lockup.slice(lockup.indexOf('<svg')), 'the graphic must not be announced separately').toMatch(/aria-hidden="true"/);
    expect(lockup, 'the chevron stands in for the A, so the letters are EON').toMatch(/>EON</);
  });

  it('both surfaces wear it, and the sign-in heading keeps its own name', () => {
    expect((SRC.match(/<AeonLockup\b/g) || []), 'the boot copy and the auth panel').toHaveLength(2);
    expect(SRC).toMatch(/<h1>Connect to AEON<\/h1>/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('5. these probes can fail', () => {
  /**
   * Re-run a probe against a mutant of the source. EVERY occurrence is
   * replaced: the node orbit is written once in instruments() and once in
   * theMark(), and a first-only replace broke the instruments copy while
   * leaving the one under test intact — the control then "passed" by not
   * having mutated anything the probe reads.
   */
  const mutate = (from, to) => {
    const broken = SRC.split(from).join(to);
    expect(broken, `control did not change the source: ${from}`).not.toBe(SRC);
    return broken;
  };

  it('a drifted radius is caught', () => {
    expect(literal(mutate('ringR: 205', 'ringR: 204'), 'MARK').ringR).not.toBe(Number(svgRing.r));
    expect(literal(mutate('innerR: 118', 'innerR: 120'), 'MARK').innerR).not.toBe(Number(svgInner.r));
    expect(literal(mutate('nodeR: 218', 'nodeR: 210'), 'MARK').nodeR).not.toBeCloseTo(seat(svgNodes[0]).r, 1);
  });

  it('a drifted dash pair is caught', () => {
    expect(literal(mutate('dash: [257.61, 64.40]', 'dash: [257.61, 64.50]'), 'MARK').dash)
      .not.toEqual(svgRing['stroke-dasharray'].trim().split(/\s+/).map(Number));
  });

  it('a chevron with a vertex moved is caught', () => {
    expect(literal(mutate('[183, 328]', '[184, 328]'), 'MARK').chev).not.toEqual(vertices(svgChevD));
  });

  it('a stopped ring, a stopped orbit and a moving chevron are caught', () => {
    expect(body(mutate('p * 90', 'p * 0'), 'theMark')).not.toMatch(/MARK\.ringRot\s*\+\s*p\s*\*\s*90\b/);
    expect(body(mutate('MARK.nodeAng[i] - p * 360', 'MARK.nodeAng[i] + 0'), 'theMark'))
      .not.toMatch(/MARK\.nodeAng\[i\]\s*-\s*p\s*\*\s*360\b/);
    expect(body(mutate('MARK.innerR * k', 'MARK.innerR * k * p'), 'markStill')).toMatch(/\bp\b/);
    expect(body(mutate('function markStill(ctx, k, T) {', 'function markStill(ctx, k, T, p) {'), 'markStill'))
      .not.toMatch(/^function markStill\(ctx, k, T\) \{/);
  });

  /**
   * The four that used to pass. Each leaves MARK byte-correct — literal() still
   * reads 205, 14, 218, 24 and the six vertices — and draws a different mark.
   */
  it('a mark drawn at numbers that are not MARK\'s is caught, though MARK is untouched', () => {
    const ring = mutate('ctx.arc(0, 0, MARK.ringR * k', 'ctx.arc(0, 0, 160 * k');
    expect(literal(ring, 'MARK').ringR, 'the table survives the mutation').toBe(205);
    expect(markCode(ring)).not.toMatch(/ctx\.arc\(0, 0, MARK\.ringR \* k,/);

    expect(markCode(mutate('T.ring, MARK.ringW * k', 'T.ring, 3 * k')))
      .not.toMatch(/softStroke\(ctx, T, k, T\.ring, MARK\.ringW \* k,/);

    const nodes = mutate('MARK.nodeR * k, Math.sin(ang) * MARK.nodeR * k, MARK.nodeSize * k',
                         '150 * k, Math.sin(ang) * 150 * k, 40 * k');
    expect(literal(nodes, 'MARK').nodeR, 'the table survives this one too').toBe(218);
    expect(markCode(nodes))
      .not.toMatch(/Math\.cos\(ang\) \* MARK\.nodeR \* k, Math\.sin\(ang\) \* MARK\.nodeR \* k, MARK\.nodeSize \* k/);

    expect(markCode(mutate('ctx.arc(0, 0, MARK.innerR * k', 'ctx.arc(0, 0, 90 * k')))
      .not.toMatch(/ctx\.arc\(0, 0, MARK\.innerR \* k,/);
    expect(markCode(mutate('T.inner, MARK.innerW * k', 'T.inner, 2 * k')))
      .not.toMatch(/softStroke\(ctx, T, k, T\.inner, MARK\.innerW \* k,/);
  });

  it('a chevron grown inside chevronPath() is caught', () => {
    const grown = mutate('(MARK.chev[i][0] - 256) * k, y = (MARK.chev[i][1] - 256) * k;',
                         '(MARK.chev[i][0] - 256) * k * 1.4, y = (MARK.chev[i][1] - 256) * k * 1.4;');
    expect(literal(grown, 'MARK').chev, 'the six vertices are still the file\'s').toEqual(vertices(svgChevD));
    expect(body(grown, 'chevronPath'))
      .not.toMatch(/\(MARK\.chev\[i\]\[0\] - 256\) \* k, y = \(MARK\.chev\[i\]\[1\] - 256\) \* k;/);
  });

  it('an unreached still half, or a cache that paints something else, is caught', () => {
    expect(body(mutate('else markStill(ctx, k, T);', 'else void k;'), 'theMark'))
      .not.toMatch(/else markStill\(ctx, k, T\)/);
    expect(body(mutate('markStill(g, k, T);', 'void g;'), 'buildStill'))
      .not.toMatch(/markStill\(g, k, T\)/);
  });

  it('a re-added badge is caught', () => {
    expect(mutate('<AeonLockup className="aeon-boot-brand" />', '<img src="/brand/aeon-mark/aeon-mark.svg" alt="" width="48" height="48" />'))
      .toMatch(/<img\b/);
  });

  it('a lockup that loses its name is caught', () => {
    expect(body(mutate('aria-label="AEON"', 'aria-label=""'), 'AeonLockup')).not.toMatch(/aria-label="AEON"/);
  });
});
