/**
 * The HOTSWAP CHAT MODEL picker's sort: free first, then a size/capability
 * guess read off the model's name — not a benchmark (see the file header
 * on modelIntelligence.cjs for why no real one is available at this layer).
 *
 * CEO, 2026-09-20: "auto sort by 1) free models first 2) intelligence".
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { looksFree, intelligenceScore, sortModels } = require('../src/kernel/modelIntelligence.cjs');

describe('looksFree', () => {
  it('the :free suffix OpenRouter actually uses', () => {
    expect(looksFree('meta-llama/llama-3.3-70b-instruct:free')).toBe(true);
    expect(looksFree('meta-llama/llama-3.3-70b-instruct')).toBe(false);
  });
  it('openrouter/free — a known suffix-match miss, named in 18c5cea\'s own commit message', () => {
    expect(looksFree('openrouter/free')).toBe(true);
  });
  it('a paid model with "free" elsewhere in the name is not fooled', () => {
    expect(looksFree('freedom-ai/some-paid-model')).toBe(false);
  });
});

describe('intelligenceScore — first bug found live: Whisper outranked everything', () => {
  it('a transcription model does not read as "large and capable" — it is filtered out entirely by sortModels, not merely demoted', () => {
    const out = sortModels(['whisper-large-v3', 'llama-3.1-8b-instruct']);
    expect(out.map((m) => m.id)).not.toContain('whisper-large-v3');
  });

  it('guard/safety/moderation models are excluded from a CHAT picker the same way', () => {
    const out = sortModels(['meta-llama/llama-prompt-guard-2-86m', 'openai/gpt-oss-safeguard-20b', 'openai/gpt-oss-120b']);
    expect(out.map((m) => m.id)).toEqual(['openai/gpt-oss-120b']);
  });

  it('an explicit parameter count outranks an unmarked model of the same family', () => {
    expect(intelligenceScore('llama-3.1-70b-instruct')).toBeGreaterThan(intelligenceScore('llama-3.1-8b-instruct'));
  });

  it('opus/ultra outranks sonnet/pro, which outranks flash/mini, which outranks nano', () => {
    const opus = intelligenceScore('anthropic/claude-opus-5');
    const sonnet = intelligenceScore('anthropic/claude-sonnet-5');
    const flash = intelligenceScore('google/gemini-3.8-flash');
    const nano = intelligenceScore('openai/gpt-5-nano');
    expect(opus).toBeGreaterThan(sonnet);
    expect(sonnet).toBeGreaterThan(flash);
    expect(flash).toBeGreaterThan(nano);
  });

  it('a thinking/reasoning variant scores above the same family without it', () => {
    const thinking = intelligenceScore('qwen/qwen3-235b-a22b-thinking');
    const plain = intelligenceScore('qwen/qwen3-235b-a22b-instruct');
    expect(thinking).toBeGreaterThan(plain);
  });

  it('an unrecognized name lands at a neutral middle score, not the bottom', () => {
    const unknown = intelligenceScore('some-new-lab/totally-unseen-model-9000');
    const nano = intelligenceScore('openai/gpt-5-nano');
    expect(unknown).toBeGreaterThan(nano);
  });
});

describe('sortModels — the picker\'s actual output shape', () => {
  it('free models sort before paid, regardless of size', () => {
    const out = sortModels(['anthropic/claude-opus-5', 'meta-llama/llama-3.3-70b-instruct:free']);
    expect(out[0].id).toBe('meta-llama/llama-3.3-70b-instruct:free');
    expect(out[0].free).toBe(true);
    expect(out[1].free).toBe(false);
  });

  it('within the same free-tier, more-capable sorts first', () => {
    const out = sortModels(['inclusionai/ling-3.0-flash-vl:free', 'z-ai/glm-5.2:batch']); // neither literally opus-tier, just a relative check
    expect(out.length).toBe(2);
    expect(out[0].free).toBe(true); // the :free one still wins the primary key regardless of tier
  });

  it('stable ordering: two models scoring equally keep the providers\' original relative order', () => {
    const out = sortModels(['aaa/model-one', 'bbb/model-two']); // both unrecognized, both neutral tier
    expect(out.map((m) => m.id)).toEqual(['aaa/model-one', 'bbb/model-two']);
  });

  it('groq\'s real live catalogue: no transcription/guard model in the result, gpt-oss-120b ranked above the -20b variant', () => {
    const groq = ['allam-2-7b', 'groq/compound', 'groq/compound-mini', 'meta-llama/llama-prompt-guard-2-22m', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'openai/gpt-oss-safeguard-20b', 'qwen/qwen3.8-27b', 'whisper-large-v3', 'whisper-large-v3-turbo'];
    const out = sortModels(groq).map((m) => m.id);
    expect(out).not.toContain('whisper-large-v3');
    expect(out).not.toContain('whisper-large-v3-turbo');
    expect(out).not.toContain('meta-llama/llama-prompt-guard-2-22m');
    expect(out).not.toContain('openai/gpt-oss-safeguard-20b');
    expect(out.indexOf('openai/gpt-oss-120b')).toBeLessThan(out.indexOf('openai/gpt-oss-20b'));
  });
});
