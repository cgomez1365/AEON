/**
 * Free install help, offered where someone gets stuck (CEO, 2026-10-02):
 * the welcome screen, the README, and an issue form that exists. One link,
 * defined once (src/utils/help.js), so the places never disagree.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { HELP_URL } from '../src/utils/help.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('install help', () => {
  it('the link names an issue form that exists in this repository', () => {
    const m = /\/issues\/new\?template=([\w.-]+\.yml)$/.exec(HELP_URL);
    expect(m).not.toBeNull();
    const form = read(`.github/ISSUE_TEMPLATE/${m[1]}`);
    expect(form).toMatch(/^name: Install help \(free\)/m);
    // Nobody is asked for a secret, and everybody is told not to paste one.
    expect(form).toMatch(/Never paste an API key/);
  });

  it('the welcome screen and the README both offer it, with the same link', () => {
    const wizard = read('src/blocks/security/components/SetupWizard.jsx');
    expect(wizard).toMatch(/import \{ HELP_URL \} from '\.\.\/\.\.\/\.\.\/utils\/help\.js'/);
    expect(wizard).toMatch(/href=\{HELP_URL\} target="_blank" rel="noopener noreferrer"/);
    const readme = read('README.md');
    expect(readme).toContain('## Need help?');
    expect(readme).toContain(`(${HELP_URL})`);
    expect(readme).toMatch(/\[Need help\?\]\(#need-help\)/);
  });
});
