import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const endpoints = require('../src/kernel/endpoints.cjs');

// BO7 — the LM Studio host default lives in exactly one place (endpoints.cjs)
// and is env-overridable; Settings resolves through it rather than hardcoding.
describe('LM Studio endpoint resolution (BO7)', () => {
  const original = process.env.LMSTUDIO_HOST;
  afterEach(() => {
    if (original === undefined) delete process.env.LMSTUDIO_HOST;
    else process.env.LMSTUDIO_HOST = original;
  });

  it('defaults to localhost:1234 when no override is configured', () => {
    delete process.env.LMSTUDIO_HOST;
    expect(endpoints.lmStudioHost()).toBe('http://localhost:1234');
  });

  it('honors a configured LMSTUDIO_HOST override (host and port)', () => {
    process.env.LMSTUDIO_HOST = 'http://192.168.1.50:4321';
    expect(endpoints.lmStudioHost()).toBe('http://192.168.1.50:4321');
  });
});
