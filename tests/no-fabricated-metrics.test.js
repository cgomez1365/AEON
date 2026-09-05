/**
 * A meter must never invent a reading.
 *
 * Two separate routes serving /api/telemetry both once padded an empty result
 * so the charts "looked alive":
 *
 *   activity/api/analytics.cjs   injected 12 fake calls  — fixed earlier, and
 *                                its comment records the rule: "a trusted
 *                                meter never fakes data".
 *   fleet_control/api/telemetry.js injected 4 requests / 1200 tokens against
 *                                "qwen" and "zenith" whenever the real total
 *                                was zero — found during clean-install
 *                                verification, on an install with no
 *                                providers configured at all.
 *
 * The same defect in two files, fixed once. This gate is why it cannot come
 * back in a third: a zeroed metric that gets overwritten with a literal when
 * it is zero is the shape being banned.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sources() {
  const out = [];
  const skip = new Set(['node_modules', 'dist', '.git', 'data', 'db']);
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(cjs|js|jsx)$/.test(e.name)) out.push(p);
    }
  };
  walk(path.join(ROOT, 'src'));
  walk(path.join(ROOT, 'services'));
  return out;
}

const stripComments = (src) => src
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');

describe('metrics are measured, never invented', () => {
  const files = sources().map(f => ({
    path: path.relative(ROOT, f),
    code: stripComments(fs.readFileSync(f, 'utf8')),
  }));

  it('no route pads a zero metric with a hardcoded non-zero value', () => {
    // The shape: a zero-check on a total, whose body then assigns a numeric
    // literal to a total/count/token/request field.
    const hits = [];
    for (const f of files) {
      const guard = /if\s*\(\s*[\w.]*\b(total\w*|count|requests?)\b\s*===?\s*0\s*\)\s*\{([\s\S]{0,400}?)\}/gi;
      let m;
      while ((m = guard.exec(f.code))) {
        const body = m[2];
        // An assignment of a non-zero numeric literal to a metric field.
        if (/\b(total\w*|requests?|tokens?|count)\b\s*[:=]\s*[1-9]\d*/i.test(body)) {
          hits.push(`${f.path}: ${m[0].slice(0, 90).replace(/\s+/g, ' ')}…`);
        }
      }
    }
    expect(
      hits,
      'A metric is being padded with an invented value when the real one is zero. '
      + 'An empty install must report zero:\n' + hits.join('\n')
    ).toEqual([]);
  });

  it('the honest aggregator still refuses to seed, and says why', () => {
    // Pins the survivor, not just the absence — the comment carries the rule.
    const analytics = fs.readFileSync(
      path.join(ROOT, 'src', 'blocks', 'activity', 'api', 'analytics.cjs'), 'utf8');
    expect(analytics).toMatch(/never fakes data/i);
  });
});
