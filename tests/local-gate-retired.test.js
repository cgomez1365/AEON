/**
 * BO-H1c + BO-H7 — the removed local-confirmation gate stays removed, and an
 * expected pre-auth 401 is not reported as a failure.
 *
 * These are regression tests for claims, not for features. The gate was
 * removed in BO-2; what survived was a hardcoded `true`, a fabricated approval
 * window, six consumers of an error flag nothing could raise, a pref that was
 * written but never read, and UI copy telling the operator local models
 * "require /allow-local confirmation". §08: a claim in the product must be
 * true of the product.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const src = (rel) => read(rel).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ''); // strip comments

const { shouldBannerResponse } = await import('../src/utils/interceptorPolicy.js');

describe('the local-confirmation gate is gone, not hidden', () => {
  it('services/ai.js no longer hardcodes a confirmation that always passes', () => {
    const s = src('services/ai.js');
    expect(s).not.toMatch(/isLocalConfirmed/);
    expect(s).not.toMatch(/confirmLocal/);
  });

  it('provider-health no longer publishes localConfirmed', () => {
    expect(src('src/kernel/routers/core.cjs')).not.toMatch(/localConfirmed/);
  });

  it('nothing consumes needsLocalConfirm — it had no producer', () => {
    for (const f of [
      'src/kernel/routers/ai.cjs',
      'src/blocks/writer/api/writer.js',
      'src/blocks/aeon_matrix/components/SecondBrainVisualizer.jsx',
    ]) {
      expect(src(f), f).not.toMatch(/needsLocalConfirm/);
    }
  });

  it('no UI claims local models need confirmation', () => {
    const settings = read('src/blocks/settings/index.jsx');
    expect(settings).not.toMatch(/require .*allow-local confirmation/i);
    expect(settings).not.toMatch(/allow_local_llm/);
  });

  it('the dead pref is out of the shipped defaults', () => {
    expect(src('services/settings.js')).not.toMatch(/allow_local_llm/);
  });

  it('/api/system/allow-local still answers, and says it is a no-op', () => {
    const core = read('src/kernel/routers/core.cjs');
    expect(core).toMatch(/allow-local/);        // older scripts still call it
    expect(core).toMatch(/noop:\s*true/);       // and it no longer fakes approval
  });
});

describe('BO-H7b — a 401 without a session is the gate working', () => {
  const base = { url: '/api/build/ide-mode', ok: false, status: 401 };

  it('does not banner a 401 when nobody is signed in', () => {
    expect(shouldBannerResponse({ ...base, hasSession: false })).toBe(false);
  });

  it('DOES banner a 401 that arrives with a session — that one is real', () => {
    expect(shouldBannerResponse({ ...base, hasSession: true })).toBe(true);
  });

  it('defaults to bannering, so a caller that forgets the flag fails loud', () => {
    expect(shouldBannerResponse({ ...base })).toBe(true);
  });

  it('still ignores 401s on auth routes regardless of session state', () => {
    for (const hasSession of [true, false]) {
      expect(shouldBannerResponse({ url: '/api/auth/login', ok: false, status: 401, hasSession })).toBe(false);
    }
  });

  it('a 500 still banners with no session — only 401 is the expected case', () => {
    expect(shouldBannerResponse({ url: '/api/build/queue', ok: false, status: 500, hasSession: false })).toBe(true);
  });

  it('428 stays a confirmation gate, not an error', () => {
    expect(shouldBannerResponse({ url: '/api/os/run', ok: false, status: 428, hasSession: true })).toBe(false);
  });
});

describe('BO-H7a — the IDE-mode poll waits for a session', () => {
  it('App.jsx gates the poll on a session and re-reads it per call', () => {
    const app = read('src/App.jsx');
    expect(app).toMatch(/function hasSessionToken\(\)/);
    expect(app).toMatch(/if \(stopped \|\| !hasSessionToken\(\)\) return;/);
    // Read at call time, not captured at mount — otherwise signing in never
    // starts the poll without a reload.
    expect(app).toMatch(/hasSession: hasSessionToken\(\)/);
  });
});

describe('BO-H2b — the block panel reports a failed read', () => {
  it('no longer swallows every fetch error into an empty panel', () => {
    const s = read('src/blocks/settings/index.jsx');
    expect(s).toMatch(/Could not read block status/);
    expect(s).toMatch(/setLoadError/);
  });
});
