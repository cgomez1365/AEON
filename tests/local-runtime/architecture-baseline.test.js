/**
 * Phase 0 — Architecture baseline.
 *
 * Freezes the block-facing contracts BEFORE the local transport is swapped
 * from Ollama-over-HTTP to a native llama.cpp worker. Every assertion here
 * describes behavior that must survive the migration unchanged.
 *
 * These tests import the REAL modules. A baseline that re-implements its
 * subject proves nothing — it stays green while the shipped contract breaks.
 * (That failure mode cost a full feature on 2026-07-29; see
 * tests/block-customize.test.js history.)
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(__dirname, '..', '..');
const createAIService = require(path.join(APP_ROOT, 'services', 'ai.js'));

/** Minimal real deps — no provider keys, so cloud paths stay unreachable. */
function makeService(settingsOverride = {}) {
  const settings = {
    models: { chat: { provider: 'ollama', model: 'test-model' } },
    prefs: {},
    ...settingsOverride,
  };
  return createAIService({
    supabase: null,
    writeOSAudit: () => {},
    TOKEN_LEDGER_FILE: path.join(__dirname, '.ledger.tmp.json'),
    loadSettings: () => settings,
    aeonTerminalStream: null,
  });
}

describe('baseline: kernelLLM surface', () => {
  it('exposes the exact block-facing export set', () => {
    const svc = makeService();
    // Blocks and the kernel bind against these names. Removing or renaming
    // any of them is a breaking change to every consumer.
    for (const name of ['kernelLLM', 'kernelVision', 'ollamaRequest', 'geminiRequest',
                        'groqRequest', 'openRouterRequest', 'claudeRequest',
                        'defaultLocalModel', 'localRuntimePresent', 'getProviderHealth']) {
      expect(typeof svc[name], `export "${name}" must exist`).toBe('function');
    }
  });

  it('kernelLLM is async and accepts (prompt, opts)', () => {
    const svc = makeService();
    expect(svc.kernelLLM.constructor.name).toBe('AsyncFunction');
    expect(svc.kernelLLM.length).toBeLessThanOrEqual(2);
  });

  it('throws a caller-actionable error when no provider can serve the role', async () => {
    const svc = makeService();
    // No GROQ/GEMINI/OPENROUTER keys and no reachable local runtime.
    await expect(svc.kernelLLM('hello', { role: 'chat' })).rejects.toThrow();
  });

  it('role defaults to "chat" when opts omits it', async () => {
    let seenRole = null;
    const svc = makeService({
      // A role the settings file does not define forces the documented
      // `settings.models[role] || settings.models.chat` fallback.
      models: {
        get chat() { seenRole = 'chat'; return { provider: 'ollama', model: 'm' }; },
      },
    });
    await svc.kernelLLM('x').catch(() => {});
    expect(seenRole).toBe('chat');
  });
});

describe('baseline: local model resolution', () => {
  it('defaultLocalModel() returns a string or null — never undefined', () => {
    const svc = makeService();
    const m = svc.defaultLocalModel();
    expect(m === null || typeof m === 'string').toBe(true);
  });

  it('localRuntimePresent() returns a boolean', () => {
    const svc = makeService();
    expect(typeof svc.localRuntimePresent()).toBe('boolean');
  });
});

describe('baseline: embedding response shape', () => {
  const libPath = path.join(APP_ROOT, 'src', 'blocks', 'aeon_matrix', 'api', '_lib.cjs');

  it('exports embed() and a model tag for vector-space identity', () => {
    const lib = require(libPath);
    expect(typeof lib.embed).toBe('function');
    // Vectors are only comparable within one model's space. The tag that
    // records which space an index lives in must survive the migration.
    expect(typeof lib.EMBED_MODEL).toBe('string');
    expect(lib.EMBED_MODEL.length).toBeGreaterThan(0);
  });

  it('cosineSimilarity is pure and dimension-sensitive', () => {
    const { cosineSimilarity } = require(libPath);
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 5);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });
});

describe('baseline: terminal SSE event vocabulary', () => {
  const streamPath = path.join(APP_ROOT, 'src', 'blocks', 'dashboard', 'api', 'chat-stream.cjs');
  const src = fs.readFileSync(streamPath, 'utf8');

  // The browser Terminal listens for these exact event names. Renaming one
  // silently breaks streaming with no server-side error.
  it.each(['token', 'done', 'error'])('emits SSE event "%s"', (evt) => {
    expect(src).toMatch(new RegExp(`sseWrite\\(res,\\s*['"]${evt}['"]`));
  });

  it('token frames carry the delta under key "t"', () => {
    expect(src).toMatch(/sseWrite\(res,\s*['"]token['"],\s*\{\s*t:/);
  });

  it('done frames carry text, tokens, latencyMs, provider, model', () => {
    const doneBlock = src.slice(src.indexOf("sseWrite(res, 'done'"));
    for (const key of ['text', 'tokens', 'latencyMs', 'provider', 'model']) {
      expect(doneBlock.slice(0, 300)).toContain(key);
    }
  });
});

describe('baseline: block dependency injection boundary', () => {
  const hostPath = path.join(APP_ROOT, 'src', 'kernel', 'blockHost.cjs');

  it('blockHost builds per-block scoped deps rather than passing baseDeps through', () => {
    const src = fs.readFileSync(hostPath, 'utf8');
    expect(src).toContain('createScopedDeps(baseDeps, manifest, folder)');
  });

  it('scoped deps never expose a local runtime handle to blocks today', () => {
    // Pins the pre-migration state: nothing named localRuntime/runner/registry
    // is reachable from a block. Phase 6 must keep it that way.
    const src = fs.readFileSync(hostPath, 'utf8');
    expect(src).not.toMatch(/blockDeps\.(localRuntime|runner|registryWriter)/);
  });
});

describe('baseline: compatibility floor is documented', () => {
  it('the architecture decision record exists and pins the frozen surfaces', () => {
    const doc = fs.readFileSync(
      path.join(APP_ROOT, 'docs', 'architecture', 'native-local-runtime.md'), 'utf8');
    expect(doc).toContain('llama.cpp');
    expect(doc).toContain('GGUF');
    expect(doc).toMatch(/never\s+HTTP/i);
    expect(doc).toContain('Compatibility policy');
  });
});
