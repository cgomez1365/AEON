/**
 * Credential backup is assembled by the kernel, not by a block.
 *
 * BO-SHIP P2.2, on the CEO's instruction that the settings → security crossing
 * "needs a real API, not a path".
 *
 * `GET /api/settings/export-credentials` built `path.join(APP_ROOT,'secrets')`,
 * dynamically required services/storage.js, and called
 * getVaultFile('blocks/security') — a block reaching into two private
 * operational roots and a sibling block's Vault namespace.
 *
 * The three artifacts are halves of one key: the vault is unreadable without
 * all of them, which is why the backup exists and why a partial restore locks
 * the owner out. Assembling them is a kernel concern.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const { exportBundle, resolveSources } = require('../src/kernel/credentialBackup.cjs');

let root;
let deps;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-credbak-'));
  fs.mkdirSync(path.join(root, 'secrets'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Vault', 'blocks', 'security'), { recursive: true });
  deps = {
    appRoot: root,
    secretsDir: path.join(root, 'secrets'),
    getVaultFile: (rel) => path.join(root, 'Vault', rel),
  };
});

afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

describe('source resolution', () => {
  it('names all three artifacts in one place', () => {
    const s = resolveSources(deps);
    expect(Object.keys(s)).toEqual([
      '.env',
      'secrets/aeon-keyslots.json',
      'vault/provider_credentials.json',
    ]);
  });

  it('survives an unconfigured vault instead of throwing', () => {
    const s = resolveSources({ ...deps, getVaultFile: () => { throw new Error('not configured'); } });
    expect(s['vault/provider_credentials.json']).toBeNull();
    expect(s['.env']).toBeTruthy();
  });
});

describe('bundle assembly', () => {
  it('collects every artifact that exists', () => {
    fs.writeFileSync(path.join(root, '.env'), 'AEON_VAULT_MASTER_KEY=abc');
    fs.writeFileSync(path.join(root, 'secrets', 'aeon-keyslots.json'), '{"v":1}');
    fs.writeFileSync(path.join(root, 'Vault', 'blocks', 'security', 'provider_credentials.json'), '{"p":1}');

    const r = exportBundle(deps);
    expect(r.ok).toBe(true);
    expect(r.bundle.files['.env']).toContain('AEON_VAULT_MASTER_KEY');
    expect(r.bundle.files['secrets/aeon-keyslots.json']).toBe('{"v":1}');
    expect(r.bundle.files['vault/provider_credentials.json']).toBe('{"p":1}');
    expect(r.filename).toMatch(/^aeon-credentials-\d{4}-\d{2}-\d{2}\.json$/);
  });

  it('records a missing artifact as null rather than omitting it', () => {
    // A restore needs all three. A key silently absent from the bundle is how
    // someone discovers the gap during recovery, which is the worst moment.
    fs.writeFileSync(path.join(root, '.env'), 'x=1');
    const r = exportBundle(deps);
    expect(r.ok).toBe(true);
    expect(r.bundle.files).toHaveProperty('secrets/aeon-keyslots.json', null);
    expect(r.bundle.files).toHaveProperty('vault/provider_credentials.json', null);
  });

  it('refuses when there is nothing to back up', () => {
    const r = exportBundle(deps);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/nothing to export/i);
    // R-05: an empty file that looks like a backup is worse than being told.
    expect(r.bundle).toBeUndefined();
  });

  it('keeps the restore instructions with the artifact', () => {
    fs.writeFileSync(path.join(root, '.env'), 'x=1');
    const r = exportBundle(deps);
    expect(r.bundle._restore).toMatch(/fresh clone/i);
    expect(r.bundle._warning).toMatch(/never commit/i);
  });
});

describe('the block no longer reaches into private roots', () => {
  const raw = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'blocks', 'settings', 'api', 'settings.js'),
    'utf8',
  );

  // A rule described in prose is not a rule being broken — the same stripper
  // suite-touches-nothing.test.js uses. The first draft of this matched the
  // comment that explains the fix and reported the defect still present.
  // Line comments first: a `//` inside a line can otherwise look block-shaped.
  const src = raw
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  it("settings does not resolve the security block's vault namespace", () => {
    expect(src).not.toMatch(/getVaultFile\(\s*path\.join\(\s*'blocks'\s*,\s*'security'/);
  });

  // Narrowly: no Vault-namespace resolution at all from this block. Settings
  // still calls storage.getLocalRuntimeRegistry() in two places, which is a
  // kernel SERVICE call and not a namespace crossing — an earlier draft of this
  // test banned every dynamic require of storage.js and was asserting style
  // rather than the boundary.
  it('settings resolves no Vault paths of its own', () => {
    expect(src).not.toMatch(/getVaultFile\s*\(/);
  });

  it('settings asks the kernel for the bundle', () => {
    expect(src).toMatch(/credentialBackup\.cjs/);
  });
});
