/**
 * The .env file has ONE path authority, and it is redirectable.
 *
 * CEO, 2026-09-13: ship AEON as a DMG and a Windows installer, so a buyer can
 * download, drag to Applications, and get an icon like any other app.
 *
 * A packaged app installs into a directory it must treat as READ-ONLY.
 * On macOS that is not a convention, it is enforcement: /Applications/AEON.app
 * is code-signed, and a bundle whose contents change after signing fails
 * Gatekeeper's signature check. The user is then told the app "is damaged",
 * which reads as broken software rather than as a policy warning.
 *
 * AEON was measured against that requirement on 2026-09-13. Booting the server
 * with DATA_PATH, VAULT_PATH, AEON_SECRETS_DIR and AEON_WORKSPACE all pointed
 * outside the install wrote NOTHING into the install directory - 828 files,
 * zero modified, .env checksum unchanged. The portable-mode work had already
 * done the hard part.
 *
 * Exactly one gap survived, and only on the first-run path. With no master key
 * present, server.js mints one and persists it to `path.join(ROOT, '.env')` -
 * inside the install. Measured in a throwaway copy with .env deleted: keyslots
 * correctly landed in the redirected secrets dir, and an 87-byte .env was
 * created in the install directory anyway.
 *
 * That write is what this gate closes. The .env path now resolves through a
 * single authority (src/kernel/envFile.cjs) honoring AEON_ENV_FILE, the same
 * shape as AEON_SECRETS_DIR / VAULT_PATH / DATA_PATH already use.
 *
 * Why an authority module and not two patched call sites: services/storage.js
 * carries a comment about seven files that each independently computed their
 * own path into the same folder, "no shared source of truth, and a real risk
 * that moving or renaming it would silently orphan whichever caller nobody
 * remembered to update". server.js and launch.js are two such callers. This
 * file exists so there is never a third.
 *
 * This gate is NOT a claim that the Electron build works - nothing is packaged
 * yet (§08). It asserts one property: AEON can run with every writable root
 * outside its install directory.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// The authority is CommonJS and reads process.env at call time, so each test
// sets the var, calls, and restores. Never assign `= undefined` to an env var:
// that stringifies to "undefined" and is a live defect in this repo's history.
const withEnv = async (vars, fn) => {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

describe('.env has one path authority', () => {
  it('src/kernel/envFile.cjs exists and exports envFilePath', async () => {
    const mod = await import('../src/kernel/envFile.cjs');
    const envFilePath = mod.default?.envFilePath || mod.envFilePath;
    expect(typeof envFilePath).toBe('function');
  });

  it('defaults to <appRoot>/.env when AEON_ENV_FILE is unset', async () => {
    const mod = await import('../src/kernel/envFile.cjs');
    const { envFilePath } = mod.default || mod;
    await withEnv({ AEON_ENV_FILE: null }, () => {
      expect(envFilePath({ appRoot: '/opt/aeon' })).toBe(path.join('/opt/aeon', '.env'));
    });
  });

  it('honors AEON_ENV_FILE as an absolute path', async () => {
    const mod = await import('../src/kernel/envFile.cjs');
    const { envFilePath } = mod.default || mod;
    const target = path.join(os.tmpdir(), 'aeon-userdata', '.env');
    await withEnv({ AEON_ENV_FILE: target }, () => {
      expect(envFilePath({ appRoot: '/opt/aeon' })).toBe(target);
    });
  });

  it('resolves a relative AEON_ENV_FILE against appRoot, never cwd', async () => {
    // Same rule resolveDataRoot() enforces: a launcher started from another
    // directory must not silently relocate the operator's secrets.
    const mod = await import('../src/kernel/envFile.cjs');
    const { envFilePath } = mod.default || mod;
    await withEnv({ AEON_ENV_FILE: 'config/.env' }, () => {
      expect(envFilePath({ appRoot: '/opt/aeon' })).toBe(path.join('/opt/aeon', 'config', '.env'));
    });
  });

  it('ignores an empty or whitespace-only AEON_ENV_FILE', async () => {
    // An unset var in a .bat/.sh launcher commonly arrives as "". Treating that
    // as a path would resolve to appRoot itself and write a directory-shaped
    // target. R-05: fall back loudly to the default, never to garbage.
    const mod = await import('../src/kernel/envFile.cjs');
    const { envFilePath } = mod.default || mod;
    for (const bad of ['', '   ']) {
      await withEnv({ AEON_ENV_FILE: bad }, () => {
        expect(envFilePath({ appRoot: '/opt/aeon' })).toBe(path.join('/opt/aeon', '.env'));
      });
    }
  });

  it('requires an absolute appRoot', async () => {
    const mod = await import('../src/kernel/envFile.cjs');
    const { envFilePath } = mod.default || mod;
    expect(() => envFilePath({ appRoot: 'relative/path' })).toThrow(/absolute/i);
    expect(() => envFilePath({})).toThrow(/absolute/i);
  });
});

describe('no caller computes the .env path by hand', () => {
  it('server.js resolves .env through the authority, not path.join(ROOT, ...)', () => {
    const src = read('server/server.js');
    expect(src).toMatch(/envFile(\.cjs)?['"]\)/);
    // The two historical sites: dotenv config (line ~16) and the first-run
    // key write (line ~53). Neither may name '.env' positionally again.
    const handRolled = src.match(/path\.join\(\s*(ROOT|__dirname[^)]*)\s*,\s*['"]\.env['"]\s*\)/g) || [];
    expect(handRolled).toEqual([]);
  });

  it('launch.js resolves .env through the authority', () => {
    const src = read('launch.js');
    expect(src).toMatch(/envFile(\.cjs)?['"]\)/);
    const handRolled = src.match(/path\.join\(\s*ROOT\s*,\s*['"]\.env['"]\s*\)/g) || [];
    expect(handRolled).toEqual([]);
  });

  it('no OTHER production file computes an .env path itself', () => {
    // The authority module and .env.example handling are the only exceptions.
    const dirs = ['server', 'services', 'security', 'src', 'api', 'scripts'];
    const offenders = [];
    const walk = (dir) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (['node_modules', 'dist', '.git', 'data'].includes(e.name)) continue;
          walk(p);
        } else if (/\.(js|cjs|mjs|jsx)$/.test(e.name)) {
          const rel = path.relative(ROOT, p);
          if (rel === path.join('src', 'kernel', 'envFile.cjs')) continue;
          const src = fs.readFileSync(p, 'utf8');
          // `.env.example` is a template that legitimately lives in the install.
          const hits = (src.match(/path\.join\([^)]*['"]\.env['"]\s*\)/g) || []);
          if (hits.length) offenders.push(`${rel}: ${hits.join(', ')}`);
        }
      }
    };
    for (const d of dirs) walk(path.join(ROOT, d));
    expect(offenders).toEqual([]);
  });
});

describe('the install directory is not a writable root', () => {
  it('every writable root AEON uses is redirectable by env var', () => {
    // The five roots. Four were already redirectable before this change; the
    // fifth (.env) is what the desktop build blocked on.
    const storage = read('services/storage.js');
    expect(storage).toMatch(/process\.env\.VAULT_PATH/);
    expect(storage).toMatch(/process\.env\.DATA_PATH/);
    expect(storage).toMatch(/process\.env\.AEON_WORKSPACE/);
    expect(read('src/kernel/vault.cjs')).toMatch(/process\.env\.AEON_SECRETS_DIR/);
    // The authority reads AEON_ENV_FILE off an INJECTABLE env (ctx.env ||
    // process.env), so assert the var it honors, not the expression shape.
    expect(read('src/kernel/envFile.cjs')).toMatch(/AEON_ENV_FILE/);
  });

  it('the first-run key write targets the resolved path, not the install root', () => {
    const src = read('server/server.js');
    // Find the first-run block and confirm the variable it writes to comes
    // from the authority. Asserting on behaviour of the write, not its prose.
    const firstRun = src.slice(src.indexOf('AEON_VAULT_MASTER_KEY'));
    expect(firstRun).toMatch(/writeFileSync\(\s*envFile/);
  });
});
