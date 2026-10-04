/**
 * 3.3.0 — agents that can work. The version is bumped in both package files
 * and the CHANGELOG has the release's section (its heading says "not tagged
 * yet" until the tag exists). release-text-claims.test.js checks the three
 * agree with each other; this pins the number.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

describe('version 3.3.0', () => {
  it('package.json and both version fields of package-lock.json say 3.3.0', () => {
    const pkg = JSON.parse(read('package.json'));
    const lock = JSON.parse(read('package-lock.json'));
    expect(pkg.version).toBe('3.3.0');
    expect(lock.version).toBe('3.3.0');
    expect(lock.packages[''].version).toBe('3.3.0');
  });

  it('CHANGELOG.md has a 3.3.0 section, newest first', () => {
    const log = read('CHANGELOG.md');
    expect(log).toMatch(/^## 3\.3\.0\b/m);
    expect(/^## (\d+\.\d+\.\d+)\b/m.exec(log)[1]).toBe('3.3.0');
  });

  it('the 3.3.0 notes say what agents can NOT do', () => {
    const log = read('CHANGELOG.md');
    const start = log.indexOf('## 3.3.0');
    const section = log.slice(start, log.indexOf('\n## ', start + 4));
    expect(section).toMatch(/no shell/i);
    expect(section).toMatch(/no code execution|run no code|runs no code/i);
  });
});
