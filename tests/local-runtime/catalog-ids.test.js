/**
 * BO-D2e root cause 3 — the operator is shown one vocabulary and required
 * to use another.
 *
 * OBSERVED (2026-08-05, and reproduced live 2026-08-06):
 *   /model-pull tinyllama                        → "Invalid repo_id"
 *   /model-pull Mistral 7B Instruct v0.3 (Q4_K_M) → "Invalid repo_id"
 *
 * The second is Cookbook's OWN display name. And the command's description
 * advertises catalogue ids — "/model-pull qwen3-1.7b-q4 (curated catalog) or
 * org/repo (HuggingFace)" — while /model/download validated against a strict
 * org/repo regex that rejects every catalogue id ever shown.
 *
 * Drives the real catalogue. Nothing is re-implemented inline.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { resolveModelIdentifier, repoFromUrl } = require('../../services/local-runtime/catalog-ids.cjs');
const raw = require('../../services/local-runtime/model-catalog.json');

const catalog = Array.isArray(raw) ? raw : raw.models;

describe('every identifier the operator is shown resolves', () => {
  it('a catalogue id resolves — the form the help text promises', () => {
    const r = resolveModelIdentifier('qwen3-1.7b-q8', catalog);
    expect(r.ok).toBe(true);
    expect(r.repoId).toMatch(/^[^/]+\/[^/]+$/);
    expect(r.via).toBe('catalog-id');
  });

  it('a display name resolves — the form Cookbook actually shows', () => {
    const entry = catalog.find(m => m.id === 'mistral-7b-v03-q4');
    const r = resolveModelIdentifier(entry.displayName, catalog);
    expect(r.ok).toBe(true);
    expect(r.via).toBe('display-name');
  });

  it('EVERY catalogue entry resolves by both of its own names', () => {
    // The gate that stops this regressing one model at a time.
    for (const m of catalog) {
      const byId = resolveModelIdentifier(m.id, catalog);
      const byName = resolveModelIdentifier(m.displayName, catalog);
      expect(byId.ok, `${m.id} did not resolve by id`).toBe(true);
      expect(byName.ok, `${m.displayName} did not resolve by display name`).toBe(true);
      expect(byId.repoId).toBe(byName.repoId);
    }
  });

  it('is forgiving about case, spaces and punctuation', () => {
    const entry = catalog.find(m => m.id === 'qwen3-1.7b-q8');
    for (const variant of [entry.displayName.toUpperCase(), entry.id.replace(/-/g, ' '), ` ${entry.id} `]) {
      expect(resolveModelIdentifier(variant, catalog).ok, variant).toBe(true);
    }
  });

  it('a real org/repo still passes straight through', () => {
    const r = resolveModelIdentifier('Qwen/Qwen3-1.7B-GGUF', catalog);
    expect(r.ok).toBe(true);
    expect(r.repoId).toBe('Qwen/Qwen3-1.7B-GGUF');
    expect(r.via).toBe('repo-id');
  });
});

describe('what it will not do is guess', () => {
  it('an unknown name is refused, but with the near-misses', () => {
    // "tinyllama" was a dead end. It should at least point somewhere.
    const r = resolveModelIdentifier('tinyllama', catalog);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not a catalogue model|HuggingFace/i);
    expect(Array.isArray(r.suggestions)).toBe(true);
  });

  it('suggests the right model for a partial name', () => {
    const r = resolveModelIdentifier('mistral', catalog);
    expect(r.ok).toBe(false);
    expect(r.suggestions.map(s => s.id)).toContain('mistral-7b-v03-q4');
  });

  it('empty input says so plainly', () => {
    expect(resolveModelIdentifier('', catalog).ok).toBe(false);
    expect(resolveModelIdentifier(null, catalog).error).toMatch(/no model/i);
  });

  it('does not accept a single bare word as a repository', () => {
    expect(resolveModelIdentifier('notamodel', catalog).ok).toBe(false);
  });
});

describe('repo derivation', () => {
  it('reads org/repo out of a HuggingFace URL', () => {
    expect(repoFromUrl('https://huggingface.co/Qwen/Qwen3-1.7B-GGUF/resolve/main/x.gguf'))
      .toBe('Qwen/Qwen3-1.7B-GGUF');
  });

  it('returns null for anything else, rather than a wrong guess', () => {
    expect(repoFromUrl('https://example.com/a/b/c')).toBeNull();
    expect(repoFromUrl('')).toBeNull();
  });
});
