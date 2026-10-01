/**
 * 3.1.0 release prep: what the shipped text says matches the code (Bible §08).
 *
 * Each launch group (security, privacy, docs, legal, first run) fixed its own
 * files and listed sentences in other groups' files that its change made
 * false. This pins the merged result: one README/PRIVACY/release-notes story
 * that matches the code, the copy and comments the groups could not reach,
 * and the version both package files carry. Text and source only: nothing is
 * started, written or fetched.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
// Code with block and line comments removed, for checks about what runs.
const code = (f) => read(f).replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

describe('the version', () => {
  it('package.json and both version fields of package-lock.json agree, and match the newest CHANGELOG release', () => {
    const pkg = JSON.parse(read('package.json'));
    const lock = JSON.parse(read('package-lock.json'));
    // The version a release carries is the newest heading in CHANGELOG.md, so a bump
    // that forgets either file fails here instead of shipping two different numbers.
    const newest = /^## (\d+\.\d+\.\d+)\b/m.exec(read('CHANGELOG.md'))[1];
    expect(pkg.version).toBe(newest);
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[''].version).toBe(pkg.version);
  });
});

describe('security: the old CORS allowlist is gone, not just unmounted', () => {
  it('security.js no longer defines or exports corsMiddleware, or trusts a vercel.app origin', () => {
    const src = read('security/security.js');
    expect(src).not.toMatch(/corsMiddleware|aeon-cortex|vercel\.app|require\('cors'\)/);
    const sec = require('../security/security.js')({ supabase: null, getLocalFile: () => '', WORKSPACE: ROOT, AUDIT_FILE: '', SDI_VIOLATION_LOG: '' });
    expect(sec.corsMiddleware).toBeUndefined();
    expect(typeof sec.helmetMiddleware).toBe('function');
  });

  it('README describes the install pipeline as the code runs it: LOW is promoted with no click', () => {
    const readme = read('README.md');
    expect(readme).not.toMatch(/gate → staging → lint → approval\)/);
    expect(readme).toMatch(/MEDIUM and HIGH wait for approval, LOW is promoted stopped/);
    expect(read('docs/SECURITY.md')).toMatch(/A \*\*LOW\*\* score is\s+promoted with no approval click/);
  });

  it('the vite dev server is described as listening on 127.0.0.1, as vite.config.js does', () => {
    expect(read('vite.config.js')).toMatch(/host: '127\.0\.0\.1'/);
    for (const f of ['docs/DEPENDENCY_DECISIONS.md', 'tools/scan/audit-gate.cjs']) {
      expect(read(f), f).not.toMatch(/server\.host: true|binds? every interface/);
    }
  });

  it('docs/SECURITY.md carries no internal escalation, and states the real restart behaviour', () => {
    const doc = read('docs/SECURITY.md');
    expect(doc).not.toMatch(/candidate PII|route findings to the CEO|Internal project/);
    expect(doc).not.toMatch(/log \+ restart/);
    expect(doc).toMatch(/Nothing restarts it except \*\*Settings → RESTART\*\*/);
  });
});

describe('privacy: README, PRIVACY.md and the release notes tell one story', () => {
  const readme = read('README.md');
  const privacy = read('PRIVACY.md');
  const notes = read('RELEASE_NOTES_v3.1.0.md');

  it('local models are called private only with Local only on, which the code has', () => {
    expect(read('src/blocks/settings/index.jsx')).toMatch(/aria-label="Local only"/);
    expect(readme).not.toMatch(/fully private/);
    expect(readme).toMatch(/Local stays private only while Settings → Models → \*\*Local only\*\* is on/);
    expect(privacy).toMatch(/With \*\*Local only\*\* off \(the default\), a local model that cannot answer hands the prompt/);
    expect(notes).toMatch(/Local only is off by default/);
  });

  it('nobody says the interface loads Google Fonts or Google favicons any more', () => {
    for (const [f, text] of [['README.md', readme], ['PRIVACY.md', privacy], ['RELEASE_NOTES_v3.1.0.md', notes]]) {
      expect(text, f).not.toMatch(/loads (its )?(fonts|typefaces) from Google Fonts|from Google's favicon service, which sends/);
    }
    expect(read('src/blocks/quick_links/README.md')).not.toMatch(/Favicons are fetched/);
  });

  it('the cloud-key Vault indexing flow is named wherever outbound traffic is listed', () => {
    expect(readme).toMatch(/adding a cloud key can send your Vault's text to that provider for indexing/);
    expect(privacy).toMatch(/picks the first provider you have added a key for/);
  });

  it('OCR data is downloaded only with AEON_OCR_DOWNLOAD=1, and every text that mentions it says so', () => {
    expect(read('src/kernel/tesseractLang.cjs')).toMatch(/env\.AEON_OCR_DOWNLOAD === '1'/);
    expect(read('.env.example')).toMatch(/^# AEON_OCR_DOWNLOAD=1$/m);
    for (const f of ['README.md', 'PRIVACY.md', 'src/blocks/aeon_matrix/README.md']) {
      expect(read(f), f).toMatch(/AEON_OCR_DOWNLOAD=1/);
    }
    expect(privacy).not.toMatch(/The first time AEON reads text from an image or a scanned PDF, it downloads/);
  });

  it('README links the privacy notice beside the licence and terms', () => {
    expect(readme).toMatch(/See \[Terms of Use\]\(TERMS_OF_USE\.md\) and the \[Privacy notice\]\(PRIVACY\.md\)/);
  });
});

describe('vault recovery: every text names the path that exists on every layout', () => {
  it('launch.js has --recover-vault, and README, the recovery page and the release notes point to it', () => {
    expect(read('launch.js')).toMatch(/process\.argv\.includes\('--recover-vault'\)/);
    for (const f of ['README.md', 'docs/DISASTER_RECOVERY.md', 'RELEASE_NOTES_v3.1.0.md']) {
      const t = read(f);
      expect(t, f).toMatch(/node launch\.js --recover-vault/);
      expect(t, f).not.toMatch(/carried drive's launchers[^.]*do(es)? not( ask)?|launchers start AEON directly and\s+do not ask/);
    }
  });
});

describe('settings copy points at what exists', () => {
  const settingsUi = read('src/blocks/settings/index.jsx');

  it('Supabase is optional, and the Keys tab is the one named', () => {
    expect(settingsUi).not.toMatch(/The one setup that matters/);
    expect(settingsUi).toMatch(/title="Connect Supabase \(optional\)"/);
    expect(settingsUi).toMatch(/\{ id: 'connections', label: 'Keys'/);
  });

  it('no user-facing string sends anyone to a "Settings → Connections" tab', () => {
    const hits = tracked
      .filter((f) => /^(src|services|server)\/.*\.(js|jsx|cjs)$/.test(f))
      .filter((f) => /Settings → Connections/.test(code(f)));
    expect(hits).toEqual([]);
  });

  it('a local model is told to use Cookbook, never to add a key', () => {
    expect(settingsUi).toMatch(/cfg\.provider === 'local'\s*\?/);
    expect(settingsUi).toMatch(/needs the local runtime and a model — install them in Cookbook/);
  });

  it('the Security block no longer promises a password on every launch', () => {
    const m = JSON.parse(read('src/blocks/security/block.manifest.json'));
    expect(m.description).not.toMatch(/password on every launch/);
    expect(m.description).toMatch(/a password once you create an account \(off until then\)/);
    // The carried drive's README said the same; it is written by the builder.
    expect(read('scripts/build-usb-carry.cjs')).not.toMatch(/password on every launch/);
  });

  it('every /model-pull example names a model the catalog has', () => {
    const ids = new Set(JSON.parse(read('services/local-runtime/model-catalog.json')).models.map((m) => m.id));
    const examples = [];
    for (const f of ['README.md', 'services/local-runtime/catalog-ids.cjs']) {
      for (const m of read(f).matchAll(/\/model-pull ([a-z0-9][a-z0-9.-]+-q\d)\b/g)) examples.push([f, m[1]]);
    }
    expect(examples.length).toBeGreaterThan(0);
    for (const [f, id] of examples) expect(ids.has(id), `${f}: ${id}`).toBe(true);
  });
});

describe('several keys are failover, everywhere they are described', () => {
  it.each([
    'services/settings.js', 'src/blocks/settings/index.jsx',
    'src/blocks/settings/api/connections.js', 'tests/key-rotation.test.js',
  ])('%s does not describe opening free accounts', (f) => {
    expect(read(f)).not.toMatch(/free accounts|handful of free/i);
  });

  it('no shipped file or test names a pilot user\'s employer', () => {
    expect(read('tests/key-rotation.test.js')).not.toMatch(/Hope's CEO/);
  });

  it('the prompt-hygiene reasons say "financial figure"', () => {
    const t = read('tests/prompt-hygiene.test.js');
    expect(t).not.toMatch(/operator debt figure/);
    expect(t).toMatch(/operator financial figure inside a model prompt/);
  });
});

describe('adding a block: a restart alone does not rebuild the interface', () => {
  it.each([
    '.github/AGENTS.md', '.claude/CLAUDE.md',
    'src/blocks/cookbook/README.md', 'src/blocks/memory_core/README.md', 'src/blocks/quick_links/README.md',
  ])('%s asks for prep:routes and a build', (f) => {
    const t = read(f);
    expect(t).not.toMatch(/restart, it works|restart the Command Center/);
    expect(t).toMatch(/npm run prep:routes/);
  });

  it('launch.js does not call the local runtime bundled', () => {
    expect(read('launch.js')).not.toMatch(/bundled llama/);
  });
});

describe('the changelog covers every commit since fe93dbf', () => {
  it.each(['dc8e3a1', '6defca4', '2b4b364', '801fda5', '601155b', '0c80a7c'])('names %s', (sha) => {
    expect(read('CHANGELOG.md')).toContain(`${sha})`);
  });
});
