/**
 * The CI workflow keeps the settings the 2026-10-03 GitHub audit asked for
 * (#6, #11, #13, #42, #43), and the coverage script has its provider (#46).
 *
 * Read as text, not parsed: no YAML parser is a dependency, and every check
 * here is a line the workflow either has or does not.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const ci = read('.github/workflows/ci.yml');
const pkg = JSON.parse(read('package.json'));
// The workflow's lines with their comments removed, so a setting named only
// in a comment does not count.
const code = ci.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).join('\n');

// Top-level jobs: two-space keys under `jobs:`, each with its body.
function jobs() {
  const body = code.slice(code.indexOf('\njobs:\n') + 7);
  const out = {};
  let name = null;
  for (const line of body.split('\n')) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m) { name = m[1]; out[name] = ''; continue; }
    if (/^\S/.test(line)) break;
    if (name) out[name] += `${line}\n`;
  }
  return out;
}

describe('.github/workflows/ci.yml', () => {
  it('runs on main, release tags, pull requests to main, weekly and by hand — not every branch push', () => {
    const on = code.slice(code.indexOf('\non:\n'), code.indexOf('\npermissions:'));
    expect(on).toMatch(/push:\n\s+branches: \[ main \]\n\s+tags: \[ 'v\*' \]/);
    expect(on).toMatch(/pull_request:\n\s+branches: \[ main \]/);
    expect(on).toMatch(/schedule:\n\s+- cron: '[^']+'/);
    expect(on).toMatch(/\n {2}workflow_dispatch:\s*\n/);
  });

  it('gives the job token read access only', () => {
    expect(code).toMatch(/\npermissions:\n {2}contents: read\n/);
    expect(code).not.toMatch(/: write\b/);
  });

  it('cancels a superseded pull request run, and keys every other run on its commit', () => {
    expect(code).toMatch(/\nconcurrency:\n {2}group: .*github\.event_name != 'pull_request' && github\.sha/);
    expect(code).toMatch(/\n {2}cancel-in-progress: true\n/);
  });

  it('every job has a time limit', () => {
    const all = jobs();
    expect(Object.keys(all).sort()).toEqual(['build', 'security']);
    for (const [name, body] of Object.entries(all)) {
      const m = /\n {4}timeout-minutes: (\d+)\n/.exec(`\n${body}`);
      expect(m, `${name} has no timeout-minutes`).toBeTruthy();
      expect(Number(m[1]), name).toBeLessThanOrEqual(30);
    }
  });

  it('pins every action to a full commit, with its tag beside it', () => {
    // A `uses:` key only: a comment that mentions one is not a step.
    const uses = [...ci.matchAll(/^\s*(?:- )?uses:\s*(\S+)(.*)$/gm)];
    expect(uses.length).toBeGreaterThan(0);
    for (const [, ref, rest] of uses) {
      expect(ref, ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
      expect(rest, `${ref} has no "# vX.Y.Z" comment`).toMatch(/^\s+# v\d+\.\d+\.\d+\s*$/);
    }
  });

  it('every checkout leaves the job token out of .git/config', () => {
    const checkouts = code.split(/\n(?=\s+- )/).filter((s) => /uses: actions\/checkout@/.test(s));
    expect(checkouts.length).toBe(2);
    for (const step of checkouts) expect(step).toMatch(/persist-credentials: false/);
  });

  it('every install is npm ci, the floor leg included', () => {
    // `npm install --package-lock-only` writes no node_modules: it is the
    // lockfile check below, not an install.
    expect(code.replace(/npm install --package-lock-only/g, '')).not.toMatch(/npm install/);
    expect(code).not.toMatch(/matrix\.install/);
    const installs = [...code.matchAll(/^\s+run: (npm ci.*)$/gm)].map((m) => m[1]);
    expect(installs).toEqual(['npm ci', 'npm ci --ignore-scripts']);
  });

  it('fails a Linux leg whose npm would rewrite the committed lockfile', () => {
    const build = jobs().build;
    const step = build.slice(build.indexOf('- name: Lockfile stays as committed'));
    expect(step).toMatch(/^- name: Lockfile stays as committed[^\n]*\n\s+if: runner\.os == 'Linux'\n\s+run: \|\n/);
    expect(step).toMatch(/\n\s+npm install --package-lock-only --ignore-scripts[^\n]*\n\s+git diff --exit-code package-lock\.json\n/);
    // After the install, so the lockfile is the one npm ci just accepted.
    expect(build.indexOf('run: npm ci\n')).toBeLessThan(build.indexOf('- name: Lockfile stays as committed'));
  });

  it('builds on the engines floor, on Node 24, and on Node 26 before it becomes LTS', () => {
    const legs = [...code.matchAll(/- os: (\S+)\n\s+node: '([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`);
    const floor = /(\d+\.\d+)/.exec(pkg.engines.node)[1];
    expect(legs).toContain(`ubuntu-latest ${floor}`);
    expect(legs).toContain('ubuntu-latest 24');
    expect(legs).toContain('windows-latest 24');
    expect(legs).toContain('macos-latest 24');
    expect(legs).toContain('ubuntu-latest 26');
  });

  it('the README counts the legs the workflow has', () => {
    const builds = [...code.matchAll(/- os: (\S+)\n\s+node: '([^']+)'/g)].length;
    const total = builds + Object.keys(jobs()).filter((j) => j !== 'build').length;
    const m = /· (\d+) CI legs \(([^)]+)\)/.exec(read('README.md'));
    expect(m, 'README has no "· N CI legs (...)" line').toBeTruthy();
    expect(Number(m[1])).toBe(total);
    expect(m[2].split(' · ')).toHaveLength(total);
  });
});

describe('npm run test:coverage', () => {
  it('has the coverage provider it names, at the vitest version', () => {
    const cfg = read('vitest.config.js');
    expect(cfg).toMatch(/provider: 'v8'/);
    expect(pkg.scripts['test:coverage']).toMatch(/--coverage/);
    expect(pkg.devDependencies['@vitest/coverage-v8']).toBe(pkg.devDependencies.vitest);
  });

  it('its report is never committed', () => {
    expect(read('.gitignore').split('\n')).toContain('coverage/');
  });
});
