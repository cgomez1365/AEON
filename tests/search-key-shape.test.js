/**
 * A search key that cannot go in a header is unset, not a crash (2026-09-28:
 * Orion showed "Web could not be searched — Invalid character in header
 * content [\"X-API-KEY\"]" for a .env comment stored as SERPER_API_KEY).
 * No network: a rejected key returns before any request is made.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const search = require('../services/search.js')({ writeOSAudit() {}, kernelLLM: null });
const saved = { ...process.env };
afterEach(() => { for (const k of ['SERPER_API_KEY', 'BRAVE_API_KEY', 'TAVILY_API_KEY']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('malformed search keys', () => {
  it.each([
    ['SERPER_API_KEY', 'fetchSerperSearch', '# optional — google results'],
    ['BRAVE_API_KEY', 'fetchBraveSearch', 'key with space'],
    ['TAVILY_API_KEY', 'fetchTavilySearch', 'tvly-abc\n'],
  ])('%s set to a non-key is skipped, not thrown', async (name, fn, value) => {
    process.env[name] = value;
    await expect(search[fn]('q', 'test', 5)).resolves.toBeNull();
  });
});
