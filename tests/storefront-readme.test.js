/**
 * The README is the storefront (2026-10-03 GitHub audit, #7 #16 #32 #33 #35 #36
 * #38 #44 #47). A stranger reads its first screen and decides; what that screen
 * and the community files say has to be what the code and the repo do.
 *
 * - It opened with a 113-word privacy caveat and kernel jargon, showed no
 *   screenshot, and never named Agents, the headline of 3.2.0.
 * - The help form never said the issue is public, and pasted paths carry the
 *   reader's username.
 * - "Run anywhere" contradicted the README's own platform table.
 * - README-only marketing images sat in public/, so every build and every
 *   carried drive copied 4.8 MB the app never shows.
 * - SECURITY.md asked ZIP users for a git commit and named no supported version.
 *
 * Text and files only: nothing is started, written or fetched.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tracked = new Set(execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean));
const README = read('README.md');
const pkg = JSON.parse(read('package.json'));
const section = (heading) => {
  const start = README.indexOf(`\n## ${heading}`);
  if (start < 0) return '';
  const next = README.indexOf('\n## ', start + 4);
  return README.slice(start, next < 0 ? undefined : next);
};

describe('the first screen sells what AEON does', () => {
  it('opens with the pitch, not the privacy caveat or the kernel metaphor', () => {
    const top = README.slice(README.indexOf('# AEON'), README.indexOf('## Get started'));
    expect(top).toMatch(/runs on your own computer/i);
    expect(top).toMatch(/\[what leaves, and when\]\(#privacy-in-short\)/);
    expect(top).not.toMatch(/Think Linux|nervous system/);
    expect(top).not.toMatch(/Deep Research's archive lookups/);
    // /ask returns the answer plus "[n] title" citations (retrieve.cjs); the
    // passages themselves are what /recall shows.
    expect(top).not.toMatch(/answers with the passages/);
  });

  it('shows a screenshot that is a committed file, and example uses', () => {
    const top = README.slice(0, README.indexOf('## Get started'));
    const shot = /<img src="(\.github\/assets\/[^"]+\.png)"/.exec(top);
    expect(shot).not.toBeNull();
    expect(tracked.has(shot[1]), shot[1]).toBe(true);
    expect((top.match(/^- \*\*/gm) || []).length).toBeGreaterThanOrEqual(3);
  });

  it('"What\'s inside" names Agents and comes before the process sections', () => {
    const inside = section("What's inside");
    expect(inside).toMatch(/\| \*\*Agents\*\* \|/);
    // An agent can be set to its own memory only (agents.cjs sharedMemory, context.cjs).
    expect(inside).not.toMatch(/every agent also reads the shared memory/);
    expect(inside).toContain('`Vault/Agents/<Folder>/memory`');
    expect(README.indexOf("## What's inside")).toBeLessThan(README.indexOf('## Why this is not a weekend AI project'));
  });

  it('the privacy detail moved into its own section, which links the notice', () => {
    const privacy = section('Privacy, in short');
    expect(privacy).toMatch(/Deep Research's archive lookups/);
    expect(privacy).toMatch(/\[Privacy notice\]\(PRIVACY\.md\)/);
  });

  it('the block-secret plain-text storage is stated in the security model', () => {
    // services/settings.js saves aeon-settings.json with mode 0600; a block's
    // secret setting is kept there, not in the vault (master/README.md says so too).
    expect(read('services/settings.js')).toMatch(/\(tmp, contents, \{ mode: 0o600 \}\)/);
    expect(section('Security model')).toMatch(/secret[^\n]*stored in plain text in `aeon-settings\.json`/);
  });
});

describe('versions point at the latest release', () => {
  it('Get started names no superseded release and labels Download ZIP as the latest code', () => {
    const start = section('Get started (no technical skills needed)');
    expect(start).not.toMatch(/v?3\.[01]\.\d/);
    expect(start).toMatch(/Download ZIP/);
    expect(start).toMatch(/latest code/);
  });

  it('the 3.0.0 upgrade steps live under Updating AEON, with the folder names GitHub really uses', () => {
    const updating = section('Updating AEON');
    expect(updating).toMatch(/### Upgrading from 3\.0\.0/);
    expect(updating).toMatch(/`AEON-main` for \*\*Code → Download ZIP\*\*/);
    expect(updating).not.toMatch(/AEON-3\.1\.0/);
    // The release-folder example names the current release line (a patch bump keeps it true).
    const [major, minor] = pkg.version.split('.');
    expect(updating).toContain(`\`AEON-${major}.${minor}.`);
  });

  it('README points at the dated test reading, and that reading is of the current release line', () => {
    // The numbers themselves are a dated reading (section 5), so they are not
    // pinned here; what is pinned is that a release re-takes the reading: it
    // names the package.json release line, a CI run id and the commit it ran on.
    expect(README).toMatch(/\]\(docs\/ENGINEERING_STANDARD\.md#5-numbers-are-dated-readings\)/);
    const std = read('docs/ENGINEERING_STANDARD.md');
    const current = std.slice(std.indexOf('**Current reading'), std.indexOf('**Previous reading'));
    const [major, minor] = pkg.version.split('.');
    expect(current).toContain(`v${major}.${minor}.`);
    expect(current).toMatch(/CI run \d+ on `[0-9a-f]{7,40}`/);
  });
});

describe('"Runs on your computer", not "Run anywhere"', () => {
  it.each(['README.md', 'package.json'])('%s', (f) => {
    expect(read(f)).not.toMatch(/Runs? anywhere/i);
  });

  it('package.json description says it', () => {
    expect(pkg.description).toMatch(/Runs on your computer\.$/);
  });
});

describe('the help request says it is public', () => {
  it('the issue form says so and asks for the username to be removed from paths', () => {
    const form = read('.github/ISSUE_TEMPLATE/install-help.yml');
    expect(form).toMatch(/This issue is public — anyone can read it/);
    expect(form).toMatch(/Remove your username from any paths you paste/);
  });

  it('the README says so beside the help link', () => {
    expect(section('Need help?')).toMatch(/The request is public — anyone can read it\*\*, so remove your username from any paths you paste/);
  });
});

describe('the security policy fits a ZIP download', () => {
  const policy = read('.github/SECURITY.md');

  it('asks for the release downloaded, and the commit only for a clone', () => {
    expect(policy).toMatch(/the release you downloaded \(for example v\d+\.\d+\.\d+\), or for a `git clone` the commit/);
  });

  it('has a supported-versions table naming the current release line', () => {
    const [major, minor] = pkg.version.split('.');
    expect(policy).toMatch(new RegExp(`\\| ${major}\\.${minor}\\.x \\| Yes \\|`));
  });

  it('the dependency-audit row says what runs, not a weekly audit', () => {
    const row = read('docs/SECURITY.md').split('\n').find((l) => l.startsWith('| Dependency audit |'));
    // Same triggers as .github/workflows/ci.yml's `on:` (fix-ci, audit #11 and #42).
    expect(row).toMatch(/every push to `main`, every `v\*` release tag, every pull request to `main`, a weekly scheduled run/);
    expect(row).not.toMatch(/every push,/);
    expect(row).not.toMatch(/\| weekly \|$/);
  });
});

describe('community files', () => {
  it('CODE_OF_CONDUCT.md exists, reports through GitHub, and the README links it', () => {
    const coc = read('CODE_OF_CONDUCT.md');
    expect(coc).toMatch(/Contributor Covenant, version 2\.1/);
    expect(coc).toMatch(/security\/advisories\/new/);
    expect(coc).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(README).toMatch(/\]\(CODE_OF_CONDUCT\.md\)/);
  });
});

describe('README-only images live out of public/', () => {
  const images = ['aeon-banner.webp', 'aeon-banner.png', 'aeon-primary-logo.png'];

  it.each(images)('%s is in .github/assets, not public/brand', (f) => {
    expect(tracked.has(`.github/assets/${f}`)).toBe(true);
    expect(tracked.has(`public/brand/${f}`)).toBe(false);
  });

  it('every image the README shows is a committed file', () => {
    const srcs = [...README.matchAll(/(?:src|srcset)="([^"]+)"/g)].map((m) => m[1]);
    expect(srcs.length).toBeGreaterThanOrEqual(3);
    for (const s of srcs) expect(tracked.has(s), s).toBe(true);
  });

  it('the banner generator writes to .github/assets', () => {
    expect(read('tools/generate-aeon-banner.mjs')).toMatch(/path\.join\(ROOT, '\.github', 'assets', ANIMATE \? 'aeon-banner\.webp' : 'aeon-banner\.png'\)/);
  });
});
