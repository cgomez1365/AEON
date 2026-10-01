/**
 * A006 — the shipped role defaults named a local model the catalog cannot
 * install.
 *
 * src/settings.default.json is copied to a new install's settings on first
 * boot. It assigned grading, creative and agent_worker to local
 * `qwen3-1.7b-q4`; the catalog has `qwen3-1.7b-q8` (its "recommended" starter,
 * the one provisioning installs) and no q4 of that model. A local-only
 * customer who installed the recommended model got
 * `Model "qwen3-1.7b-q4" is not ready` from Resume Grader, Writer and agent
 * workers, and the readiness remedy "install it in Cookbook" could not be
 * followed. Bible §08: an assignment must name something that exists.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'settings.default.json'), 'utf8'));
const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'services', 'local-runtime', 'model-catalog.json'), 'utf8'));
const catalog = Array.isArray(raw) ? raw : (raw.models || Object.values(raw));
const ids = new Set(catalog.map((m) => m.id));

describe('settings.default.json names only installable local models', () => {
  const local = Object.entries(defaults.models || {}).filter(([, m]) => m && m.provider === 'local');

  it('has local roles to check', () => {
    expect(local.length).toBeGreaterThan(0);
  });

  for (const [role, m] of local) {
    it(`${role} → ${m.model} is in the model catalog`, () => {
      expect(ids.has(m.model), `${role} names "${m.model}", which Cookbook cannot install`).toBe(true);
    });
  }

  it('the chat-capable local roles name a chat model, not an embedder', () => {
    for (const [role, m] of local) {
      const entry = catalog.find((c) => c.id === m.model);
      expect(entry && (entry.capabilities || []).includes('chat'), `${role}: ${m.model}`).toBe(true);
    }
  });
});
