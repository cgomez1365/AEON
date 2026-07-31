import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const endpoints = require('../src/kernel/endpoints.cjs');
const buildUsb = require('../scripts/build-usb.js');

// BO-USB — portable/USB mode. AEON must run entirely off removable media on a
// host with nothing installed, write nothing to that host, and never reach for
// the network. These tests pin the behaviours that make that true.
describe('portable mode detection (BO-USB)', () => {
  const original = process.env.AEON_PORTABLE;
  afterEach(() => {
    if (original === undefined) delete process.env.AEON_PORTABLE;
    else process.env.AEON_PORTABLE = original;
  });

  it('is off unless AEON_PORTABLE is exactly "true"', () => {
    delete process.env.AEON_PORTABLE;
    expect(endpoints.isPortable()).toBe(false);
    process.env.AEON_PORTABLE = '1';
    expect(endpoints.isPortable()).toBe(false);
    process.env.AEON_PORTABLE = 'yes';
    expect(endpoints.isPortable()).toBe(false);
  });

  it('is on when AEON_PORTABLE=true', () => {
    process.env.AEON_PORTABLE = 'true';
    expect(endpoints.isPortable()).toBe(true);
  });
});


describe('role resolution in portable mode (BO-USB)', () => {
  const originalPortable = process.env.AEON_PORTABLE;
  afterEach(() => {
    if (originalPortable === undefined) delete process.env.AEON_PORTABLE;
    else process.env.AEON_PORTABLE = originalPortable;
  });

  // The point: a USB install carries no cloud keys, so the normal registry
  // path would fail every role lookup with an error the owner cannot act on
  // while offline. Portable mode answers locally instead.
  it('resolves every role to local runtime with no registry and no keys', async () => {
    process.env.AEON_PORTABLE = 'true';
    for (const role of ['chat', 'router', 'vision', 'anything-at-all']) {
      const r = await endpoints.resolveForRole(role, null);
      expect(r.ok).toBe(true);
      expect(r.provider).toBe('local');
      expect(r.via).toBe('direct');
      expect(r.apiKey).toBeNull();
      expect(r.role).toBe(role);
    }
  });

  it('returns model from native LR registry (null when no models installed)', async () => {
    process.env.AEON_PORTABLE = 'true';
    const r = await endpoints.resolveForRole('chat', null);
    // model is either null (no models installed in test env) or a string id
    expect(r.model === null || typeof r.model === 'string').toBe(true);
  });

  it('never returns a cloud provider while portable', async () => {
    process.env.AEON_PORTABLE = 'true';
    const r = await endpoints.resolveForRole('chat', null);
    expect(['groq', 'openai', 'gemini', 'claude', 'grok', 'openrouter']).not.toContain(r.provider);
  });
});

describe('secrets directory portability (BO-USB)', () => {
  // vault.cjs already honored AEON_SECRETS_DIR; endpoints.cjs did not, so on a
  // portable install the vault followed the drive while the endpoint registry
  // stayed on the host. Both must resolve through the same env var.
  it('endpoints.cjs and vault.cjs agree on AEON_SECRETS_DIR', () => {
    const endpointsSrc = fs.readFileSync(path.join(process.cwd(), 'src/kernel/endpoints.cjs'), 'utf8');
    const vaultSrc = fs.readFileSync(path.join(process.cwd(), 'src/kernel/vault.cjs'), 'utf8');
    expect(endpointsSrc).toMatch(/process\.env\.AEON_SECRETS_DIR/);
    expect(vaultSrc).toMatch(/process\.env\.AEON_SECRETS_DIR/);
  });
});

describe('vault .env protector is relocatable', () => {
  // The .env master key and secrets/aeon-keyslots.json are two halves of one
  // protector. Before this seam existed, AEON_SECRETS_DIR moved only the
  // keyslot half, so `npm test` reissued a key straight into the developer's
  // real .env — rotating the live AEON_VAULT_MASTER_KEY and orphaning anything
  // sealed under the previous one. Regression guard.
  it('resolves the .env write target through AEON_ENV_FILE', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/kernel/vault.cjs'), 'utf8');
    expect(src).toMatch(/process\.env\.AEON_ENV_FILE/);
    // writeEnvKey must go through the seam, not rebuild the path itself.
    const fn = src.slice(src.indexOf('function writeEnvKey'), src.indexOf('function writeEnvKey') + 400);
    expect(fn).not.toMatch(/path\.join\(APP_ROOT,\s*'\.env'\)/);
  });
});

describe('cloud service in portable mode (BO-USB)', () => {
  // Portable media travels and gets plugged into machines its owner does not
  // control. It must not attach a cloud mirror even if keys somehow exist.
  it('AEON_PORTABLE=true forces local-only without needing AEON_LOCAL_ONLY', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'services/cloud.js'), 'utf8');
    expect(src).toMatch(/AEON_PORTABLE.*===.*'true'/s);
    const localOnlyBlock = src.slice(src.indexOf('const localOnly'), src.indexOf('let supabase'));
    expect(localOnlyBlock).toMatch(/AEON_PORTABLE/);
  });
});

// ── bundle assembly ────────────────────────────────────────────────────────
// These exercise the real exclusion rules from scripts/build-usb.js. A bundle
// is a distributable artifact: if it carries live keys, they travel to every
// machine the drive touches. That makes these security tests, not style tests.
describe('USB bundle exclusion rules (BO-USB)', () => {
  // The real rules from the real bundler — a copy here could drift out of
  // sync with the script and pass while the shipped bundle leaked.
  const excluded = (p) => buildUsb.shouldExclude(p);

  it('excludes everything that carries credentials or personal state', () => {
    for (const p of [
      '.env', '.env.local',
      'secrets/aeon-vault.json', 'secrets/aeon-keyslots.json',
      'db/chat_log.json', 'db/token_ledger.json',
      'data/writer/draft.md',
      '.git/config',
    ]) expect(excluded(p), `${p} must not ship`).toBe(true);
  });

  it('keeps everything the bundle needs to boot', () => {
    for (const p of [
      'server.cjs', 'package.json', 'server/server.js',
      'services/storage.js', 'src/kernel/vault.cjs',
      'src/blocks/cookbook/block.manifest.json',
      'dist/index.html', 'tools/aeon-cli.cjs',
      '.env.example', 'db/aeon_vault_schema.sql',
    ]) expect(excluded(p), `${p} must ship`).toBe(false);
  });

  // .env is excluded but .env.example and .env.usb are templates and must not
  // be caught by the same rule — a too-greedy pattern would strip the template
  // the launcher depends on.
  it('does not over-match env templates', () => {
    expect(excluded('.env.example')).toBe(false);
    expect(excluded('.env.usb')).toBe(false);
    expect(excluded('.env')).toBe(true);
  });

  it('excludes tests but not source that merely mentions them', () => {
    expect(excluded('tests/vault.test.js')).toBe(true);
    expect(excluded('src/kernel/testHarness.js')).toBe(false);
  });
});

describe('generated .env.usb contract (BO-USB)', () => {
  // Generated by the real writer, so the contract is checked against what
  // actually ships. The launcher substitutes __USB_ROOT__ at boot; it cannot
  // be baked in, because the same drive mounts at E:\ on one machine and
  // /Volumes/AEON on the next.
  let envUsb;
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-usb-env-'));
    buildUsb.writeEnvUsb(dir, { model: 'qwen3:8b' });
    envUsb = fs.readFileSync(path.join(dir, '.env.usb'), 'utf8');
  });
  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it('sets the portable flags the runtime branches on', () => {
    expect(envUsb).toMatch(/^AEON_PORTABLE=true$/m);
    expect(envUsb).toMatch(/^AEON_MODE=usb$/m);
    expect(envUsb).toMatch(/^AEON_LOCAL_ONLY=1$/m);
  });

  it('routes every state path through the drive root token', () => {
    // OLLAMA_MODELS became AEON_LOCAL_MODELS_DIR when the bundle stopped
    // shipping a second, system-wide model daemon (N10). The invariant is
    // unchanged: every state path is drive-relative.
    for (const key of ['DATA_PATH', 'VAULT_PATH', 'AEON_SECRETS_DIR', 'AEON_WORKSPACE', 'AEON_LOCAL_MODELS_DIR']) {
      const line = envUsb.match(new RegExp(`^${key}=(.*)$`, 'm'));
      expect(line, `${key} missing`).toBeTruthy();
      expect(line[1], `${key} must be drive-relative`).toContain('__USB_ROOT__');
    }
  });

  it('hardcodes no host-absolute path', () => {
    for (const line of envUsb.split('\n')) {
      const value = line.split('=').slice(1).join('=');
      expect(value, line).not.toMatch(/^[A-Za-z]:[\\/]/);
      expect(value, line).not.toMatch(/^\/(Users|home|Volumes)\//);
    }
  });

  it('carries no cloud credentials', () => {
    for (const forbidden of [
      'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY',
      'GEMINI_PAID_KEY', 'OPENAI_API_KEY', 'GROQ_API_KEY', 'ANTHROPIC_API_KEY',
    ]) expect(envUsb).not.toMatch(new RegExp(`^${forbidden}=.+`, 'm'));
  });

  it('substitution produces real absolute paths for both platform shapes', () => {
    for (const root of ['E:/', '/Volumes/AEON']) {
      const resolved = envUsb.replace(/__USB_ROOT__/g, root.replace(/\/$/, ''));
      expect(resolved).not.toContain('__USB_ROOT__');
      const dataPath = resolved.match(/^DATA_PATH=(.*)$/m)[1];
      expect(dataPath.startsWith(root.replace(/\/$/, ''))).toBe(true);
    }
  });
});

describe('launcher line endings (BO-USB)', () => {
  let target;
  beforeEach(() => {
    target = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-usb-launchers-'));
  });
  afterEach(() => {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
  });

  // Not cosmetic. cmd.exe mis-parses an LF-only .bat, and a stray CR turns a
  // shebang into "#!/usr/bin/env bash\r" — bash reports "bad interpreter".
  it('writes CRLF batch and LF shell launchers', () => {
    buildUsb.writeLaunchers(target, 'v22.14.0');

    const bat = fs.readFileSync(path.join(target, 'LAUNCH.bat'), 'latin1');
    expect(bat).toContain('\r\n');
    expect(bat).toContain('__USB_ROOT__');
    expect(bat).toMatch(/AEON_PORTABLE/);

    for (const name of ['launch.sh', 'launch.command']) {
      const sh = fs.readFileSync(path.join(target, name), 'latin1');
      expect(sh, `${name} must not contain CR`).not.toContain('\r');
      expect(sh.startsWith('#!')).toBe(true);
      expect(sh).toContain('__USB_ROOT__');
    }
  });

  it('points the mac launcher at mac runtimes, not linux', () => {
    buildUsb.writeLaunchers(target, 'v22.14.0');

    const cmd = fs.readFileSync(path.join(target, 'launch.command'), 'utf8');
    expect(cmd).toContain('runtime/node/mac');
    expect(cmd).not.toContain('runtime/node/linux');
  });
});

describe('portable mode binds to loopback (BO-USB)', () => {
  // A USB install runs on a machine, and often a network, its owner does not
  // control. Binding 0.0.0.0 there exposes the API to that LAN — and on a
  // fresh drive no operator account exists yet, so the auth gate is not armed.
  // It also triggers a Windows Firewall prompt that writes a rule outliving
  // the drive. Loopback is the only defensible default for portable media.
  //
  // BO-0 generalised this: every clause above is equally true of a consumer
  // desktop, so loopback is now the default in ALL modes and AEON_BIND is the
  // deliberate opt-out. Asserted through the real resolver rather than by
  // regex over server.js — the behaviour is the contract, not its spelling.
  it('binds loopback when portable', () => {
    const bind = require(path.join(process.cwd(), 'src/kernel/server-utils/bind.cjs'));
    expect(bind.resolveBind({ AEON_PORTABLE: 'true' })).toBe('127.0.0.1');
    expect(bind.isExposed({ AEON_PORTABLE: 'true' })).toBe(false);
  });

  it('binds loopback when NOT portable too', () => {
    const bind = require(path.join(process.cwd(), 'src/kernel/server-utils/bind.cjs'));
    expect(bind.resolveBind({})).toBe('127.0.0.1');
    expect(bind.isExposed({})).toBe(false);
  });

  it('still honours an explicit AEON_BIND opt-out', () => {
    const bind = require(path.join(process.cwd(), 'src/kernel/server-utils/bind.cjs'));
    expect(bind.resolveBind({ AEON_BIND: '0.0.0.0', AEON_PORTABLE: 'true' })).toBe('0.0.0.0');
  });

  it('server.js takes its bind from the authority, not an inline expression', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'server/server.js'), 'utf8');
    expect(src).toMatch(/const BIND = bind\.resolveBind\(\)/);
    expect(src).not.toMatch(/'0\.0\.0\.0'/);
  });

  it('no longer hardcodes 0.0.0.0 at the listen call', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'server/server.js'), 'utf8');
    expect(src).not.toMatch(/app\.listen\(PORT,\s*'0\.0\.0\.0'/);
    expect(src).toMatch(/app\.listen\(PORT,\s*BIND/);
  });
});
