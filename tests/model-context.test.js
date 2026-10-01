/**
 * modelContext — the provider's real context window, asked for and cached.
 *
 * describeRole used to report 8,192 for every cloud model, and every memory,
 * skill and recall budget is a fraction of that number: a 1,000,000-token
 * model got ~980 tokens of memory. modelContext asks the provider's /models
 * catalogue instead. These tests pin what it reads, where it sends the key,
 * how long it trusts an answer, and that every failure is a quiet null.
 *
 * No real network: a local http server on 127.0.0.1, or a stubbed fetch.
 * No shared state: each test gets its own DATA_PATH and a fresh module
 * instance (the cache path and the in-memory copy are per instance).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MC_PATH = path.join(ROOT, 'src', 'kernel', 'modelContext.cjs');

const savedModule = require.cache[MC_PATH];
const savedDataPath = process.env.DATA_PATH;
const temps = [];

function tempDir(tag = 'aeon-model-context-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), tag));
  temps.push(d);
  return d;
}

/** A fresh module bound to `dataPath`, optionally with a seeded cache file. */
function load(dataPath = path.join(tempDir(), 'data'), seed = null) {
  if (seed) {
    fs.mkdirSync(dataPath, { recursive: true });
    fs.writeFileSync(path.join(dataPath, 'model-context.json'), typeof seed === 'string' ? seed : JSON.stringify(seed));
  }
  process.env.DATA_PATH = dataPath;
  delete require.cache[MC_PATH];
  const mod = require(MC_PATH);
  process.env.DATA_PATH = savedDataPath;
  return mod;
}

// ── A fake catalogue server ──────────────────────────────────────────
function fakeServer(handler) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url, headers: req.headers });
    handler(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server, hits, base: `http://127.0.0.1:${server.address().port}/v1`,
      close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }),
    }));
  });
}
const json = (body, status = 200) => (req, res) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

const NEMO = 'nvidia/nemotron-3-ultra-550b-a55b:free';
const MINI = 'openai/gpt-4o-mini';
const OPENROUTER_ROWS = { data: [{ id: NEMO, context_length: 1000000 }, { id: MINI, context_length: 128000 }] };

const servers = [];
async function serve(handler) {
  const s = await fakeServer(handler);
  servers.push(s);
  return s;
}

const realFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  while (servers.length) await servers.pop().close();
});
afterAll(() => {
  if (savedModule) require.cache[MC_PATH] = savedModule; else delete require.cache[MC_PATH];
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const readCache = (mc) => JSON.parse(fs.readFileSync(mc.CACHE_FILE, 'utf8'));

// ── windowFromRow ────────────────────────────────────────────────────
describe('windowFromRow reads the window a catalogue row reports', () => {
  const mc = load();

  it('reads each provider\'s field name', () => {
    for (const field of ['context_length', 'context_window', 'max_input_tokens', 'inputTokenLimit', 'max_context_length', 'n_ctx']) {
      expect(mc.windowFromRow({ id: 'm', [field]: 131072 }), field).toBe(131072);
    }
  });

  it('falls back to OpenRouter\'s top_provider copy, but the top level wins', () => {
    expect(mc.windowFromRow({ top_provider: { context_length: 200000 } })).toBe(200000);
    expect(mc.windowFromRow({ context_length: 1000000, top_provider: { context_length: 8000 } })).toBe(1000000);
  });

  it('skips a field out of range instead of giving up on the row', () => {
    expect(mc.windowFromRow({ context_length: 512, context_window: 32768 })).toBe(32768);
    expect(mc.windowFromRow({ context_length: 10000000 })).toBeNull();
  });

  it('accepts numeric strings and rounds fractions down', () => {
    expect(mc.windowFromRow({ context_length: '131072' })).toBe(131072);
    expect(mc.windowFromRow({ context_length: 131072.9 })).toBe(131072);
  });

  it('gives null for rows with no window, and for anything not an object', () => {
    expect(mc.windowFromRow({ id: 'x' })).toBeNull();
    expect(mc.windowFromRow({ context_length: 0 })).toBeNull();
    for (const row of [0, null, undefined, 'model-id', 131072]) expect(mc.windowFromRow(row)).toBeNull();
  });

  it('accepts its own bounds', () => {
    expect(mc.MIN_SANE).toBe(1024);
    expect(mc.MAX_SANE).toBe(4000000);
    expect(mc.windowFromRow({ context_length: 1024 })).toBe(1024);
    expect(mc.windowFromRow({ context_length: 4000000 })).toBe(4000000);
    expect(mc.windowFromRow({ context_length: 1023 })).toBeNull();
    expect(mc.windowFromRow({ context_length: 4000001 })).toBeNull();
  });

  it('trusts a known window for 30 days', () => {
    expect(mc.TTL_MS).toBe(30 * DAY);
  });
});

// ── lookup: guards ───────────────────────────────────────────────────
describe('lookup — what it refuses to ask about', () => {
  it('local, or a missing provider or model: null, no fetch, no file', async () => {
    const mc = load();
    const spy = vi.fn(realFetch);
    globalThis.fetch = spy;
    expect(await mc.lookup({ provider: 'local', model: 'qwen' })).toBeNull();
    expect(await mc.lookup({ provider: 'openrouter' })).toBeNull();
    expect(await mc.lookup({ model: NEMO })).toBeNull();
    expect(await mc.lookup()).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    expect(fs.existsSync(mc.CACHE_FILE)).toBe(false);
  });
});

// ── lookup: OpenAI-compatible catalogue ──────────────────────────────
describe('lookup — an OpenAI-compatible catalogue', () => {
  let mc;
  let fake;
  beforeEach(async () => {
    mc = load();
    fake = await serve(json(OPENROUTER_ROWS));
  });

  it('returns the window and caches every model the one request listed', async () => {
    expect(await mc.lookup({ provider: 'openrouter', model: NEMO, base_url: fake.base })).toBe(1000000);
    expect(fake.hits).toHaveLength(1);
    expect(fake.hits[0]).toMatchObject({ method: 'GET', url: '/v1/models' });

    const disk = readCache(mc);
    expect(disk.schema).toBe(1);
    expect(disk.models[`openrouter|${NEMO}`]).toMatchObject({ tokens: 1000000 });
    expect(disk.models[`openrouter|${MINI}`]).toMatchObject({ tokens: 128000 });
    expect(typeof disk.models[`openrouter|${MINI}`].at).toBe('number');

    // Siblings came with the first request.
    expect(await mc.lookup({ provider: 'openrouter', model: NEMO, base_url: fake.base })).toBe(1000000);
    expect(await mc.lookup({ provider: 'openrouter', model: MINI, base_url: fake.base })).toBe(128000);
    expect(fake.hits).toHaveLength(1);

    expect(mc.peek('openrouter', MINI)).toBe(128000);
    expect(mc.peek('openrouter', 'nobody/knows')).toBeNull();
  });

  it('does not double the slash after a base_url that ends in one', async () => {
    await mc.lookup({ provider: 'openrouter', model: NEMO, base_url: `${fake.base}/` });
    expect(fake.hits[0].url).toBe('/v1/models');
  });

  it('sends a Bearer key only when there is one', async () => {
    await mc.lookup({ provider: 'openrouter', model: NEMO, base_url: fake.base, apiKey: 'sk-test' });
    expect(fake.hits[0].headers.authorization).toBe('Bearer sk-test');

    const mc2 = load();
    await mc2.lookup({ provider: 'openrouter', model: NEMO, base_url: fake.base });
    expect(fake.hits[1].headers).not.toHaveProperty('authorization');
  });

  it('reads a bare top-level array of rows', async () => {
    const bare = await serve(json([{ id: 'm-bare', context_window: 65536 }]));
    expect(await mc.lookup({ provider: 'custom', model: 'm-bare', base_url: bare.base })).toBe(65536);
  });
});

// ── lookup: misses and expiry ────────────────────────────────────────
describe('lookup — misses, expiry, and failures that stay quiet', () => {
  it('records a model the catalogue does not list, and does not ask again for six hours', async () => {
    const fake = await serve(json(OPENROUTER_ROWS));
    const mc = load();
    expect(await mc.lookup({ provider: 'openrouter', model: 'absent/model', base_url: fake.base })).toBeNull();
    const miss = readCache(mc).models['openrouter|absent/model'];
    expect(miss.tokens).toBeNull();
    expect(typeof miss.at).toBe('number');
    expect(miss.why).toMatch(/list/);
    expect(await mc.lookup({ provider: 'openrouter', model: 'absent/model', base_url: fake.base })).toBeNull();
    expect(fake.hits).toHaveLength(1);
  });

  it('asks again once a miss is older than six hours', async () => {
    const fake = await serve(json(OPENROUTER_ROWS));
    const dataPath = path.join(tempDir(), 'data');
    const mc = load(dataPath, { schema: 1, models: { [`openrouter|${NEMO}`]: { tokens: null, at: Date.now() - 7 * HOUR, why: 'old' } } });
    expect(await mc.lookup({ provider: 'openrouter', model: NEMO, base_url: fake.base })).toBe(1000000);
    expect(fake.hits).toHaveLength(1);
  });

  it('trusts a known window for 29 days and re-checks it at 31', async () => {
    const fake = await serve(json(OPENROUTER_ROWS));
    const young = load(undefined, { schema: 1, models: { [`openrouter|${NEMO}`]: { tokens: 262144, at: Date.now() - 29 * DAY } } });
    expect(await young.lookup({ provider: 'openrouter', model: NEMO, base_url: fake.base })).toBe(262144);
    expect(fake.hits).toHaveLength(0);

    const old = load(undefined, { schema: 1, models: { [`openrouter|${NEMO}`]: { tokens: 262144, at: Date.now() - 31 * DAY } } });
    expect(await old.lookup({ provider: 'openrouter', model: NEMO, base_url: fake.base })).toBe(1000000);
    expect(fake.hits).toHaveLength(1);
  });

  it('treats an entry with no timestamp as expired', async () => {
    const fake = await serve(json(OPENROUTER_ROWS));
    const mc = load(undefined, { schema: 1, models: { [`openrouter|${NEMO}`]: { tokens: 262144 } } });
    expect(await mc.lookup({ provider: 'openrouter', model: NEMO, base_url: fake.base })).toBe(1000000);
    expect(fake.hits).toHaveLength(1);
  });

  const failures = {
    'a 500': json({ error: 'boom' }, 500),
    'a 401': json({ error: 'bad key sk-secret' }, 401),
    'a body that is not JSON': (req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>nope</html>'); },
    'a JSON null': json('null'),
  };
  for (const [name, handler] of Object.entries(failures)) {
    it(`${name}: null, silent, and recorded as a miss`, async () => {
      const fake = await serve(handler);
      const mc = load();
      const spies = ['log', 'info', 'warn', 'error', 'debug'].map(m => vi.spyOn(console, m));
      const out = vi.spyOn(process.stdout, 'write');
      const err = vi.spyOn(process.stderr, 'write');
      await expect(mc.lookup({ provider: 'openrouter', model: NEMO, base_url: fake.base, apiKey: 'sk-secret' })).resolves.toBeNull();
      for (const s of [...spies, out, err]) expect(s).not.toHaveBeenCalled();
      expect(readCache(mc).models[`openrouter|${NEMO}`]).toMatchObject({ tokens: null });
    });
  }

  it('a refused connection: null, silent, and recorded as a miss', async () => {
    // Bind a port, then free it, so nothing is listening there.
    const gone = await fakeServer(json({}));
    const base = gone.base;
    await gone.close();
    const mc = load();
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    await expect(mc.lookup({ provider: 'openrouter', model: NEMO, base_url: base })).resolves.toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(readCache(mc).models[`openrouter|${NEMO}`]).toMatchObject({ tokens: null });
  });

  it('a server that never answers is abandoned after ~8 seconds, and the request is aborted', async () => {
    let closed;
    const socketClosed = new Promise(r => { closed = r; });
    const fake = await serve((req) => { req.socket.on('close', () => closed()); });
    const mc = load();
    const t0 = Date.now();
    expect(await mc.lookup({ provider: 'openrouter', model: NEMO, base_url: fake.base })).toBeNull();
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(7500);
    expect(took).toBeLessThan(11000);
    await socketClosed; // resolves only if the client really dropped the request
  }, 20000);

  it('an OK reply in a shape it does not know is an empty catalogue', async () => {
    const fake = await serve(json({ object: 'list', results: [{ id: NEMO, context_length: 1000000 }] }));
    const mc = load();
    expect(await mc.lookup({ provider: 'openrouter', model: NEMO, base_url: fake.base })).toBeNull();
    expect(readCache(mc).models[`openrouter|${NEMO}`].why).toMatch(/list/);
  });

  it('a custom provider with no address is never fetched', async () => {
    const mc = load();
    const spy = vi.fn(realFetch);
    globalThis.fetch = spy;
    expect(await mc.lookup({ provider: 'custom', model: 'anything' })).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    expect(readCache(mc).models['custom|anything']).toMatchObject({ tokens: null });
  });
});

// ── lookup: provider-specific requests ───────────────────────────────
describe('lookup — where each provider is asked, and how the key travels', () => {
  const stub = (body) => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    return calls;
  };

  it('Gemini: always Google\'s own host, key URL-encoded in the query, "models/" stripped', async () => {
    const calls = stub({ models: [{ name: 'models/gemini-flash-latest', inputTokenLimit: 1048576 }] });
    const mc = load();
    const got = await mc.lookup({ provider: 'gemini', model: 'gemini-flash-latest', base_url: 'http://127.0.0.1:9/v1', apiKey: 'k&1' });
    expect(got).toBe(1048576);
    expect(calls).toHaveLength(1);
    const u = new URL(calls[0].url);
    expect(u.hostname).toBe('generativelanguage.googleapis.com');
    expect(u.pathname).toMatch(/\/models$/);
    expect(calls[0].url).toContain('key=k%261');
    expect(u.searchParams.get('key')).toBe('k&1');
  });

  for (const provider of ['claude', 'anthropic']) {
    it(`${provider}: x-api-key and anthropic-version, max_input_tokens`, async () => {
      const fake = await serve(json({ data: [{ id: 'claude-x', max_input_tokens: 200000 }] }));
      const mc = load();
      expect(await mc.lookup({ provider, model: 'claude-x', base_url: fake.base, apiKey: 'ant-key' })).toBe(200000);
      expect(fake.hits[0].url).toBe('/v1/models');
      expect(fake.hits[0].headers['x-api-key']).toBe('ant-key');
      expect(fake.hits[0].headers['anthropic-version']).toBe('2023-06-01');
    });
  }

  it('groq, openrouter, openai and grok default to their public bases', async () => {
    // endpoints.cjs makes its secrets dir at require time: point it at a temp
    // dir first (suite-touches-nothing), then read its public bases.
    const savedSecrets = process.env.AEON_SECRETS_DIR;
    process.env.AEON_SECRETS_DIR = tempDir('aeon-model-context-secrets-');
    const { PROVIDER_TRANSPORT } = require('../src/kernel/endpoints.cjs');
    process.env.AEON_SECRETS_DIR = savedSecrets;
    for (const provider of ['groq', 'openrouter', 'openai', 'grok']) {
      const calls = stub({ data: [] });
      const mc = load();
      await mc.lookup({ provider, model: 'm' });
      expect(calls, provider).toHaveLength(1);
      expect(calls[0].url, provider).toBe(`${PROVIDER_TRANSPORT[provider].base}/models`);
    }
  });

  it('never follows a redirect, so the key cannot be carried elsewhere', async () => {
    const elsewhere = await serve(json(OPENROUTER_ROWS));
    const fake = await serve((req, res) => { res.writeHead(302, { Location: `${elsewhere.base}/models` }); res.end(); });
    const mc = load();
    expect(await mc.lookup({ provider: 'openrouter', model: NEMO, base_url: fake.base, apiKey: 'sk-test' })).toBeNull();
    expect(fake.hits).toHaveLength(1);
    expect(elsewhere.hits).toHaveLength(0);
  });
});

// ── Cache robustness ─────────────────────────────────────────────────
describe('the cache file', () => {
  for (const [name, seed] of [['invalid JSON', '{ not json'], ['JSON without models', { schema: 1 }]]) {
    it(`${name} reads as empty and is rewritten as a valid cache`, async () => {
      const fake = await serve(json(OPENROUTER_ROWS));
      const mc = load(undefined, seed);
      expect(await mc.lookup({ provider: 'openrouter', model: NEMO, base_url: fake.base })).toBe(1000000);
      expect(readCache(mc)).toMatchObject({ schema: 1, models: { [`openrouter|${NEMO}`]: { tokens: 1000000 } } });
    });
  }

  it('a data root that cannot be created costs nothing but the file', async () => {
    const fake = await serve(json(OPENROUTER_ROWS));
    const dir = tempDir();
    const blocker = path.join(dir, 'a-file');
    fs.writeFileSync(blocker, 'x');
    const mc = load(path.join(blocker, 'data'));
    expect(await mc.lookup({ provider: 'openrouter', model: NEMO, base_url: fake.base })).toBe(1000000);
    expect(await mc.lookup({ provider: 'openrouter', model: NEMO, base_url: fake.base })).toBe(1000000);
    expect(fake.hits).toHaveLength(1);
  });

  it('requiring the module creates nothing', () => {
    const dir = tempDir();
    const dataPath = path.join(dir, 'data');
    const mc = load(dataPath);
    expect(mc.CACHE_FILE).toBe(path.join(dataPath, 'model-context.json'));
    expect(fs.existsSync(dataPath)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(mc.peek('openrouter', NEMO)).toBeNull(); // a read creates nothing either
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
