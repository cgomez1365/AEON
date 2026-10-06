/**
 * modelAfterProviderSwitch — the browser half of the stale-model fix.
 *
 * Switching a role's provider must not carry the old provider's model along
 * (src/kernel/modelQuery.js). It is pure, so it is tested without a DOM.
 * It restates the kernel's non-chat pattern because a browser module cannot
 * import a .cjs file; the parity test below is what keeps the two equal.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { modelAfterProviderSwitch, NON_CHAT_MODEL_RE as BROWSER_NON_CHAT_RE } from '../src/kernel/modelQuery.js';

const require = createRequire(import.meta.url);
// endpoints.cjs creates its secrets dir at module scope, so this is set before the require.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-model-switch-'));
process.env.AEON_SECRETS_DIR = path.join(tmp, 'secrets');
const endpoints = require('../src/kernel/endpoints.cjs');

afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('modelAfterProviderSwitch', () => {
  it('keeps the current model when the new provider lists it', () => {
    expect(modelAfterProviderSwitch(['a', 'b'], 'b', 'chat')).toBe('b');
  });

  it('replaces a model the new provider does not list with its first chat model', () => {
    expect(modelAfterProviderSwitch(['a', 'b'], 'gemini-flash-latest', 'chat')).toBe('a');
  });

  it('skips non-chat families when picking', () => {
    const groq = ['canopylabs/orpheus-arabic-saudi', 'meta-llama/llama-prompt-guard-2-22m', 'whisper-large-v3', 'openai/gpt-oss-20b'];
    expect(modelAfterProviderSwitch(groq, 'gemini-flash-latest', 'chat')).toBe('openai/gpt-oss-20b');
  });

  it('falls back to the first listed model when every one is non-chat', () => {
    expect(modelAfterProviderSwitch(['whisper-large-v3', 'orpheus-tts'], 'x', 'chat')).toBe('whisper-large-v3');
  });

  it('picks an embedding model for the embed role, or nothing', () => {
    expect(modelAfterProviderSwitch(['gpt-4o', 'text-embedding-3-small'], 'gpt-4o-mini', 'embed')).toBe('text-embedding-3-small');
    expect(modelAfterProviderSwitch(['gpt-4o'], 'gpt-4o-mini', 'embed')).toBe('');
  });

  it.each([[[]], [undefined], [null]])('returns the current model untouched when the list is %j (unknown is not wrong)', (list) => {
    expect(modelAfterProviderSwitch(list, 'kept', 'chat')).toBe('kept');
  });

  it('copes with a current model that is not set', () => {
    expect(modelAfterProviderSwitch(['a'], undefined, 'chat')).toBe('a');
  });
});

describe('the browser copy of the non-chat pattern', () => {
  it('is the kernel\'s, character for character', () => {
    expect(BROWSER_NON_CHAT_RE.source).toBe(endpoints.NON_CHAT_MODEL_RE.source);
    expect(BROWSER_NON_CHAT_RE.flags).toBe(endpoints.NON_CHAT_MODEL_RE.flags);
  });
});
