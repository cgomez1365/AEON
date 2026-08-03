/**
 * BO-A4a — two provider registries, one truth.
 *
 * services/ai.js answered "is this provider configured?" from process.env and
 * from key-pool snapshots taken at module load. src/kernel/endpoints.cjs
 * answered the same question from the endpoint registry, which is backed by the
 * vault.
 *
 * On the operator's machine every provider key in .env is BLANK. The Groq key
 * lives in the vault and reaches process.env only through
 * hydrateEnvFromVault() — which is async and invoked at module load WITHOUT
 * await. That is a real window, and it is observable: /core/provider-health
 * calls isConfigured(), and settings fetches provider-health on mount. A read
 * landing inside the window reports a configured provider as unconfigured.
 *
 * These tests drive the REAL kernel predicate against a REAL registry file.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// AEON_SECRETS_DIR must be set BEFORE the require — endpoints.cjs resolves its
// registry path at module scope. (The isolation rule learned the hard way:
// tests must not touch the live install.)
const tempSecrets = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-provider-truth-'));
process.env.AEON_SECRETS_DIR = tempSecrets;

const endpoints = require('../src/kernel/endpoints.cjs');
const REG_FILE = path.join(tempSecrets, 'aeon-endpoints.json');

const writeRegistry = (reg) => fs.writeFileSync(REG_FILE, JSON.stringify(reg, null, 2));

const registry = (eps) => ({ endpoints: eps, roles: {} });

afterAll(() => { try { fs.rmSync(tempSecrets, { recursive: true, force: true }); } catch {} });
afterEach(() => { try { fs.rmSync(REG_FILE, { force: true }); } catch {} });

describe('isProviderConfigured reads the registry, not the environment', () => {
  it('reports configured when the registry holds a keyed endpoint, with a BLANK env', () => {
    // This is the operator's actual machine state: .env empty, key in vault.
    const saved = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
    try {
      writeRegistry(registry([
        { id: 'groq-1', provider: 'groq', auth_ref: 'vault:groq', reachable_from: ['local'], models: [] },
      ]));
      expect(endpoints.isProviderConfigured('groq')).toBe(true);
    } finally {
      if (saved !== undefined) process.env.GROQ_API_KEY = saved;
    }
  });

  it('reports NOT configured for an endpoint with no key reference', () => {
    // Registered but keyless is not configured — that distinction is the
    // whole point of auth_ref.
    writeRegistry(registry([
      { id: 'groq-1', provider: 'groq', auth_ref: null, reachable_from: ['local'], models: [] },
    ]));
    expect(endpoints.isProviderConfigured('groq')).toBe(false);
  });

  it('does not confuse one provider for another', () => {
    writeRegistry(registry([
      { id: 'gem-1', provider: 'gemini', auth_ref: 'vault:gemini', reachable_from: ['local'], models: [] },
    ]));
    expect(endpoints.isProviderConfigured('gemini')).toBe(true);
    expect(endpoints.isProviderConfigured('groq')).toBe(false);
  });

  it('answers false rather than throwing when no registry exists at all', () => {
    expect(() => endpoints.isProviderConfigured('groq')).not.toThrow();
    expect(endpoints.isProviderConfigured('groq')).toBe(false);
  });

  it('answers false rather than throwing on a corrupt registry', () => {
    fs.writeFileSync(REG_FILE, '{ not json');
    expect(() => endpoints.isProviderConfigured('groq')).not.toThrow();
    expect(endpoints.isProviderConfigured('groq')).toBe(false);
  });
});

describe('services/ai.js consults that one truth', () => {
  const src = fs.readFileSync(require.resolve('../services/ai.js'), 'utf8');

  it('isConfigured falls back to the registry rather than trusting env alone', () => {
    // The defect was env-only. If this assertion ever fails, the boot window
    // is back and provider-health can lie again.
    expect(src).toMatch(/isProviderConfigured/);
  });

  it('hydration is still what populates the env cache — this is a fallback, not a rewrite', () => {
    // BO-A4 explicitly does NOT redesign provider routing. The cache path must
    // survive; only the wrong answer when the cache is cold is removed.
    expect(src).toMatch(/hydrateEnvFromVault/);
    expect(src).toMatch(/process\.env\.GROQ_API_KEY/);
  });
});
