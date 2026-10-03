/**
 * The public docs say what the 3.1.0 code does (claim discipline, Bible §08).
 *
 * The 2026-09-30 launch audit found the README and docs telling a stranger to
 * download v3.0.0 (168 commits behind, with auth bypasses fixed since), that
 * deleting the AEON folder is a safe update (installed packs live in it, and
 * the launcher rebuilds nothing after a `git pull`), that `chmod +x` clears a
 * Gatekeeper quarantine (it does not), that llama.cpp is bundled (Cookbook
 * downloads it), and describing several keys as a way to multiply free-tier
 * limits. Each was a sentence, so each is checked as one. This file reads text
 * only: no module is required and nothing is written.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);

const README = read('README.md');
const ENV_EXAMPLE = read('.env.example');
const KEY_POOL = read('src/kernel/keyPool.cjs');

// Customer-facing prose: the README, every doc, every block README, the env template.
const PUBLIC_DOCS = [
  'README.md',
  '.env.example',
  ...tracked.filter((f) => /^docs\/.+\.md$/.test(f) || /^src\/blocks\/[^/]+\/README\.md$/.test(f)),
].filter((f) => fs.existsSync(path.join(ROOT, f)));

describe('the download a stranger is pointed at', () => {
  it('links the latest release, not the release list where v3.0.0 is the only entry', () => {
    expect(README).toMatch(/\]\(https:\/\/github\.com\/cgomez1365\/AEON\/releases\/latest\)/);
    expect(README).not.toMatch(/\]\(https:\/\/github\.com\/cgomez1365\/AEON\/releases\)/);
  });

  it('says plainly that v3.0.0 is superseded', () => {
    expect(README).toMatch(/v3\.0\.0 is superseded/);
  });
});

describe('updating keeps the operator\'s packs and builds the interface', () => {
  it('no longer calls deleting the AEON folder a safe update', () => {
    expect(README).not.toMatch(/delete the AEON folder, unzip a new one/i);
  });

  it('says installed packs live in the AEON folder, and that a pull needs npm ci and a build', () => {
    // src/kernel/blocksDir.cjs: the one blocks root is <install>/src/blocks.
    expect(read('src/kernel/blocksDir.cjs')).toMatch(/DEFAULT_BLOCKS_DIR = path\.join\(__dirname, '\.\.', 'blocks'\)/);
    expect(README).toMatch(/packs you installed[^\n]*`src\/blocks\/`/i);
    // Its own section, no longer a subsection of Get started (2026-10-03 audit).
    expect(README).toMatch(/^## Updating AEON$/m);
    const updating = README.slice(README.indexOf('## Updating AEON'));
    expect(updating).toMatch(/git pull\s+npm ci\s+npm run build/);
    expect(updating).toMatch(/a pull's new dependencies and interface are not picked up/);
  });

  it('the launcher has no way to notice a pull, which is why the README asks for npm ci and a build', () => {
    // The fact the README's extra steps rest on, not how launch.js spells its
    // install and build checks (those change; an unfinished install is now
    // detected too). A launcher that ran git, read package-lock.json or compared
    // file times could pick a pull up, and the README would need rewording.
    const launch = read('launch.js');
    expect(launch).not.toMatch(/(execSync|execFileSync|spawn|spawnSync)\(\s*['"`]git\b|rev-parse/);
    expect(launch).not.toMatch(/['"`/\\]package-lock\.json/); // node_modules/.package-lock.json is npm's own
    expect(launch).not.toMatch(/\.mtime/);
  });
});

describe('requirements match the code', () => {
  it('the README states the same Node floor as package.json engines', () => {
    const floor = /(\d+\.\d+)/.exec(JSON.parse(read('package.json')).engines.node)[1];
    expect(README).toMatch(new RegExp(`### Requirements[\\s\\S]*${floor.replace('.', '\\.')} or newer`));
  });

  it('macOS: the README gives the real Gatekeeper steps, not chmod as the remedy', () => {
    expect(README).toMatch(/Open Anyway/);
    expect(README).not.toMatch(/type `chmod \+x `/);
  });
});

describe('the local runtime is described as downloaded, never bundled', () => {
  // services/local-runtime/runtime-assets.json downloads it from GitHub releases;
  // `git ls-files` holds no llama binaries.
  it('runtime-assets.json still downloads the runtime', () => {
    const assets = JSON.parse(read('services/local-runtime/runtime-assets.json'));
    expect(assets.releaseBaseUrl).toMatch(/^https:\/\/github\.com\/ggml-org\/llama\.cpp\/releases\/download\//);
    expect(tracked.filter((f) => /llama-(server|cli)(\.exe)?$/.test(f))).toEqual([]);
  });

  it.each(PUBLIC_DOCS)('%s does not call it bundled', (file) => {
    const hits = read(file).split('\n')
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => /\b(self-)?bundled\s+(`?llama|local runtime|llama\.cpp|runtime)/i.test(line));
    expect(hits.map(([n, l]) => `${file}:${n} ${l.trim().slice(0, 90)}`)).toEqual([]);
  });
});

describe('several keys are failover, never a way around provider limits', () => {
  it('keyPool.cjs comments no longer describe free accounts multiplying a limit', () => {
    expect(KEY_POOL).not.toMatch(/free accounts?/i);
    expect(KEY_POOL).not.toMatch(/\d+\s*rpm are \d+\s*rpm/i);
    expect(KEY_POOL).toMatch(/not a way around a provider's limits/);
  });

  it('.env.example and the README say so where they offer more than one key', () => {
    expect(ENV_EXAMPLE).not.toMatch(/rotated on rate limits/i);
    expect(ENV_EXAMPLE).toMatch(/not a way around a provider's limits/);
    expect(README).toMatch(/not a way around a provider's limits/);
  });
});

describe('docs/DISASTER_RECOVERY.md is written for the person running AEON', () => {
  it('carries no internal escalation or hosted-service targets', () => {
    const dr = read('docs/DISASTER_RECOVERY.md');
    expect(dr).not.toMatch(/Decisions that need the CEO|aeon_candidates|flag to legal|RTO ≤|RPO ≤/);
    // The Settings tab that holds keys is "Keys" (settings/index.jsx), not "Account".
    expect(read('src/blocks/settings/index.jsx')).toMatch(/label: 'Keys'/);
    expect(dr).not.toMatch(/Settings → Account panel/);
    expect(dr).toMatch(/Settings → Keys/);
  });
});
