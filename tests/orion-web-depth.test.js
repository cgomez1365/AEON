/**
 * Orion's depth control reaches the web engine.
 *
 * CEO, 2026-09-10: depth set to 16 (and 24) — three web results, every time.
 * Every provider in services/search.js hardcoded its own number (DDG 3, the
 * keyed ones 5) and /api/orion/search never told /api/search-web how many it
 * wanted, so the control changed a label and nothing else.
 *
 * Now /api/search-web takes `count` (clamped 1..30, default 5), every provider
 * honours it up to its own API ceiling, and Orion forwards k as count.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const search = require('../services/search.js')({ writeOSAudit() {}, kernelLLM: async () => '' });

describe('web search result count', () => {
  it('clamps what the caller asks for and defaults when it asks nothing', () => {
    expect(search.DEFAULT_COUNT).toBe(5);
    expect(search.clampCount(undefined)).toBe(5);
    expect(search.clampCount('abc')).toBe(5);
    expect(search.clampCount(0)).toBe(5);
    expect(search.clampCount('16')).toBe(16);
    expect(search.clampCount(24)).toBe(24);
    expect(search.clampCount(999)).toBe(search.MAX_COUNT);
  });

  it('no provider hardcodes its own number any more', () => {
    const src = fs.readFileSync(path.join(ROOT, 'services/search.js'), 'utf8');
    expect(src).not.toMatch(/count=5\b/);
    expect(src).not.toMatch(/num: 5\b/);
    expect(src).not.toMatch(/max_results: 5\b/);
    expect(src).not.toMatch(/slice\(0, 5\)/);
    expect(src).not.toMatch(/Math\.min\(3,/);
    expect(src).toMatch(/req\.query\.count/);
  });

  it('Orion forwards its depth to the web route as count', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/blocks/orion_search/api/orion.cjs'), 'utf8');
    expect(src).toMatch(/search-web\?q=\$\{encodeURIComponent\(q\)\}&synthesize=0&count=\$\{encodeURIComponent\(k\)\}/);
  });

  it('Orion decodes HTML entities in titles and snippets', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/blocks/orion_search/api/orion.cjs'), 'utf8');
    expect(src).toMatch(/unescapeHtml/);
    expect(src).toMatch(/&#x\(\[0-9a-f\]\+\);/i);
  });
});
