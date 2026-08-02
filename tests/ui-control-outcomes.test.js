// A control that fails invisibly is a silent failure (R-05).
//
// The Memory buttons in aeon_matrix did nothing on press. The route was mounted
// and the request was fine — saveToMemory() simply ended in a bare `catch {}`
// and set no state on success either, so success and failure were both
// invisible. Three buttons shared that one function: the header "Memory", the
// Ask tab "Save", and the Summary tab "Save to Memory".
//
// The neighbouring Listen button appeared to work for exactly one reason: it is
// a synchronous setViewMode() whose feedback never depends on a network call.
//
// This gate is deliberately narrow. A blanket "no empty catch" rule would be
// wrong — SecondBrainVisualizer's document loader uses a chain of caught
// fetches that falls through to a visible message, which is correct. What must
// hold is that a USER-INITIATED action reports what happened.
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const VIS = path.join(ROOT, 'src', 'blocks', 'aeon_matrix', 'components', 'SecondBrainVisualizer.jsx');
const src = fs.readFileSync(VIS, 'utf8');

/** Body of a named arrow function declared with const. */
function fnBody(source, name) {
  const start = source.indexOf(`const ${name} = `);
  if (start === -1) return null;
  let i = source.indexOf('{', start);
  if (i === -1) return null;
  let depth = 0;
  for (let j = i; j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}') {
      depth--;
      if (depth === 0) return source.slice(i, j + 1);
    }
  }
  return null;
}

describe('saveToMemory reports its outcome', () => {
  const body = fnBody(src, 'saveToMemory');

  it('exists', () => {
    expect(body, 'saveToMemory not found in SecondBrainVisualizer').toBeTruthy();
  });

  it('does not swallow errors in a bare catch', () => {
    expect(body).not.toMatch(/catch\s*\{\s*\}/);
    expect(body).not.toMatch(/catch\s*\([^)]*\)\s*\{\s*\}/);
  });

  it('reports success', () => {
    // Some state must change on the success path, or the button stays a no-op
    // even when the save works — which is exactly what users experienced.
    const successHalf = body.split('catch')[0];
    expect(successHalf).toMatch(/flashMemoryStatus|setMemoryStatus/);
  });

  it('reports failure with a reason', () => {
    const catchHalf = body.slice(body.indexOf('catch'));
    expect(catchHalf).toMatch(/flashMemoryStatus|setMemoryStatus/);
    expect(catchHalf, 'the failure message should carry the cause').toMatch(/e\.message|error/i);
  });

  it('checks response.ok rather than assuming success', () => {
    expect(body).toMatch(/response\.ok/);
  });
});

describe('the status it sets is actually rendered', () => {
  it('memoryStatus reaches the DOM', () => {
    // State that nothing renders is the same bug wearing a different hat.
    expect(src).toMatch(/\{memoryStatus\s*&&/);
  });

  it('all three Memory controls route through saveToMemory', () => {
    // Header "Memory", Ask-tab "Save", Summary-tab "Save to Memory" — all three
    // were dead for the same reason, and all three are fixed by one function.
    const callSites = src.match(/=>\s*saveToMemory\(/g) || [];
    expect(callSites.length).toBe(3);
  });
});
