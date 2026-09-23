/**
 * A rate limit is a rate limit, all the way to the caller (agent C2, 2026-09-23).
 *
 *   - POST /api/ai answered a rate-limited chain with HTTP 500 — an internal
 *     fault — so a block could not tell "wait a minute" from "something broke".
 *   - The chain's own message read "…could not serve either: " with nothing
 *     after it: `'…either: ' + list || 'none configured'` binds the `||` to the
 *     whole string, which is never empty.
 */
import { describe, expect, it } from 'vitest';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

async function post(kernelLLM) {
  const app = express();
  app.use(express.json());
  app.use('/api/ai', require('../src/kernel/routers/ai.cjs')({ kernelLLM, kernelVision: async () => '' }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/ai`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'hi' }),
    });
    return { status: res.status, body: await res.json() };
  } finally { server.close(); }
}

describe('POST /api/ai', () => {
  it('a rate-limited chain answers 429 and says it is temporary', async () => {
    const r = await post(async () => { const e = new Error('groq is rate-limited right now (HTTP 429).'); e.rateLimited = true; e.retryable = true; throw e; });
    expect(r.status).toBe(429);
    expect(r.body.retryable).toBe(true);
  });
  it('nothing configured stays 503, a fault stays 500', async () => {
    expect((await post(async () => { const e = new Error('none'); e.noProviderAvailable = true; throw e; })).status).toBe(503);
    expect((await post(async () => { throw new Error('boom'); })).status).toBe(500);
  });
});

// The chain-exhausted message is checked behaviourally in
// tests/openrouter-empty-responses.test.js (a rate-limited sole provider).
