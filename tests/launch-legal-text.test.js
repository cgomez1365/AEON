/**
 * The shipped legal text promises nothing that does not exist and points at a
 * contact that works (A002, A015, A065, A082, A066, A068, A115).
 *
 * LICENSE §4 and TERMS §5 promised an End User License Agreement "supplied
 * with each block"; none exists and no paid block is on sale. LICENSE and
 * TERMS sent people to the retired broken-gear-industries.pages.dev store, and
 * package.json's author address sat on brokengear.io, a domain nobody has
 * registered. There was no privacy notice at all. Text only — these pin the
 * fixes so they cannot quietly come back.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SHIPPED = ['LICENSE', 'TERMS_OF_USE.md', 'PRIVACY.md', 'package.json'];
const ISSUES = 'https://github.com/cgomez1365/AEON/issues';

describe('shipped legal text', () => {
  it('a privacy notice exists and the terms link it', () => {
    expect(fs.existsSync(path.join(ROOT, 'PRIVACY.md'))).toBe(true);
    expect(read('TERMS_OF_USE.md')).toContain('(PRIVACY.md)');
  });

  it('no promise of an EULA that does not exist', () => {
    for (const f of SHIPPED) {
      const t = read(f);
      expect(t, f).not.toMatch(/End User License Agreement supplied/i);
      expect(t, f).not.toMatch(/carry their own EULA/i);
    }
    expect(read('LICENSE')).toMatch(/No paid blocks are on sale yet/);
    expect(read('TERMS_OF_USE.md')).toMatch(/No paid blocks are on sale yet/);
  });

  it('no dead contact: not the retired pages.dev store, not the unregistered brokengear.io', () => {
    for (const f of SHIPPED) {
      const t = read(f);
      expect(t, f).not.toMatch(/broken-gear-industries\.pages\.dev/);
      expect(t, f).not.toMatch(/brokengear\.io/);
    }
    expect(read('LICENSE')).toContain(ISSUES);
    expect(read('TERMS_OF_USE.md')).toContain(ISSUES);
    expect(read('PRIVACY.md')).toContain(ISSUES);
  });

  it('package.json: no email in author, license defers to LICENSE', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(String(pkg.author)).not.toMatch(/@/);
    expect(pkg.license).toBe('SEE LICENSE IN LICENSE');
  });

  it('warranty and liability language is limited to what the law permits, and keeps consumer rights', () => {
    expect(read('LICENSE')).toMatch(/TO THE EXTENT PERMITTED BY APPLICABLE LAW/);
    expect(read('LICENSE')).toMatch(/Nothing in this license limits rights/);
    const terms = read('TERMS_OF_USE.md');
    expect(terms).toMatch(/To the extent permitted by law/);
    expect(terms).toMatch(/Nothing here limits those rights/);
  });

  it('the privacy notice names the one thing sent without setup, and the keyless search fallback', () => {
    const p = read('PRIVACY.md');
    expect(p).toMatch(/Google Fonts/);
    expect(p).toMatch(/DuckDuckGo/);
    // The code it describes: the stylesheet main.jsx imports, and search.js's fallback.
    expect(read('src/aurora.css')).toMatch(/fonts\.googleapis\.com/);
    expect(read('services/search.js')).toMatch(/lite\.duckduckgo\.com/);
  });
});
