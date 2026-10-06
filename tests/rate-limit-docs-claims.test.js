/**
 * What AEON says about rate limits is true, and the limit stays the operator's.
 *
 * Principle 05: providers and models are policy, not product identity. A
 * provider's requests-per-minute number is the operator's account policy, read
 * from their own dashboard, so no named provider carries one in code, and the
 * words that tell the operator where to find it quote none. And claim
 * discipline (section 08): the README names what is NOT enforced.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

describe('no provider number is hardwired', () => {
  it('only the generic custom connection carries a default pacing', () => {
    const src = read('src', 'kernel', 'endpoints.cjs');
    const block = src.slice(src.indexOf('const PROVIDER_TRANSPORT = {'), src.indexOf('function defaultRegistry'));
    const withRpm = [...block.matchAll(/^\s{2}(\w+):\s*\{[^\n]*\brpm:\s*\d+/gm)].map((m) => m[1]);
    expect(withRpm).toEqual(['custom']);
  });

  it('no named provider answers a default through the helper', () => {
    process.env.AEON_SECRETS_DIR = process.env.AEON_SECRETS_DIR || fs.mkdtempSync(path.join(require('os').tmpdir(), 'aeon-rl-docs-'));
    const { rpmDefault, PROVIDER_TRANSPORT } = require('../src/kernel/endpoints.cjs');
    for (const p of Object.keys(PROVIDER_TRANSPORT)) {
      if (p === 'custom') expect(rpmDefault(p)).toBe(30);
      else expect(rpmDefault(p), `${p} ships a rate number`).toBeNull();
    }
  });
});

describe('the words that explain the limit', () => {
  const readme = read('README.md');
  const section = readme.slice(readme.indexOf('### Rate limits for your keys'), readme.indexOf('### Requirements'));
  const ui = read('src', 'blocks', 'settings', 'index.jsx');
  const help = ui.slice(ui.indexOf('function PacingRow'), ui.indexOf('function KeyPool'));
  const form = ui.slice(ui.indexOf('Requests per minute limit (optional)') - 400, ui.indexOf('conn-add-footer'));

  it('the README section exists and says what is not enforced', () => {
    expect(section.length).toBeGreaterThan(200);
    expect(section).toMatch(/no daily-request cap/i);
    expect(section).toMatch(/tokens per minute are not paced/i);
    expect(section).toMatch(/Settings → Keys/);
    expect(section).not.toMatch(/Settings → Connections/);
  });

  it('the in-app help says the daily cap is not enforced and where to find the number', () => {
    expect(help).toMatch(/daily request cap is not enforced/);
    expect(help).toMatch(/provider's own rate-limits page/);
    expect(help).toMatch(/lowest number among the models you use/);
  });

  it('quotes no provider rate number anywhere it explains the limit', () => {
    // The numbers on a provider's dashboard change. The words must not carry them.
    for (const [where, text] of [['README section', section], ['PacingRow help', help], ['Add form help', form]]) {
      expect(text, where).not.toMatch(/\b\d+\s*(requests?|rpm|req)\b[^.]*\b(per|a|\/)\s*(minute|min|day)\b/i);
      expect(text, where).not.toMatch(/near \d+|capped (at|near)|free (plans|accounts|tier)s? (are|is) (often )?capped/i);
    }
  });
});
