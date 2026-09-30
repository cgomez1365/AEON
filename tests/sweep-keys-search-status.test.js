/**
 * C24 — a search key the provider refuses is said out loud, not turned into
 * "no results".
 *
 * The Brave/Serper/Tavily handlers never read res.statusCode: a 401/403 body
 * parsed as JSON with no results, resolved null, and the search fell through to
 * DuckDuckGo with no log and no audit — every search, paying the round trip.
 * Settings kept "● connected" and had no Test for these three. No network here:
 * https.request and fetch are stubbed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-sweep-search-'));
process.env.AEON_HOME = path.join(tmp, 'home');
process.env.AEON_SECRETS_DIR = path.join(tmp, 'secrets');
process.env.AEON_ENV_FILE = path.join(tmp, '.env');
fs.mkdirSync(process.env.AEON_SECRETS_DIR, { recursive: true });

const KEYS = ['TAVILY_API_KEY', 'SERPER_API_KEY', 'BRAVE_API_KEY'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

const https = require('https');
const express = require('express');
const searchModule = require('../services/search.js');
const settingsService = require('../services/settings.js');
const mountSettings = require('../src/blocks/settings/api/settings.js');

const audits = [];
const search = searchModule({ writeOSAudit: (...a) => audits.push(a), kernelLLM: null });

// One fake response per https.request call: { status, body }.
const answer = (replies) => vi.spyOn(https, 'request').mockImplementation((...args) => {
  const onRes = args.find((a) => typeof a === 'function');
  const { status, body } = replies.shift();
  const req = new EventEmitter();
  req.setTimeout = () => req;
  req.write = () => {};
  req.end = () => {
    const res = new EventEmitter();
    res.statusCode = status;
    onRes(res);
    res.emit('data', typeof body === 'string' ? body : JSON.stringify(body));
    res.emit('end');
  };
  return req;
});
const DDG_PAGE = `<a rel="nofollow" href="https://example.org/a" class='result-link'>From DDG</a>
<td class='result-snippet'>fallback answered</td>`;

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  mountSettings(app, {
    cloudCredentials: settingsService.createCloudCredentialStore({ file: path.join(tmp, 'cloud.json') }),
    providerCredentials: settingsService.createProviderCredentialStore({ file: path.join(tmp, 'provider.json') }),
    supabase: null,
  });
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(() => { vi.restoreAllMocks(); audits.length = 0; });
afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  delete process.env.AEON_ENV_FILE;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('a keyed provider that refuses the key', () => {
  it('is audited and logged once, and the key reads as rejected until it changes', async () => {
    process.env.TAVILY_API_KEY = 'tvly-expired-key';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    answer([{ status: 401, body: { detail: { error: 'Unauthorized: missing or invalid API key.' } } },
      { status: 401, body: { detail: { error: 'Unauthorized' } } }]);

    await expect(search.fetchTavilySearch('q', 'cid-1', 5)).resolves.toBeNull();
    await expect(search.fetchTavilySearch('q', 'cid-2', 5)).resolves.toBeNull();

    expect(audits.map((a) => [a[0], a[2], a[4]])).toEqual([
      ['SEARCH_KEY_REJECTED', 401, 'cid-1'], ['SEARCH_KEY_REJECTED', 401, 'cid-2']]);
    expect(audits[0][1]).toMatch(/Tavily answered HTTP 401 — TAVILY_API_KEY was refused/);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).not.toContain('tvly-expired-key');

    expect(searchModule.searchKeyStatus('TAVILY_API_KEY')).toMatchObject({ state: 'rejected', status: 401 });
    process.env.TAVILY_API_KEY = 'tvly-re-entered-key';
    expect(searchModule.searchKeyStatus('TAVILY_API_KEY').state).toBe('ok');
  });

  it('a quoted key (printable, so it passes the shape check) that Serper refuses hands on to DuckDuckGo, on the record', async () => {
    delete process.env.TAVILY_API_KEY;
    delete process.env.BRAVE_API_KEY;
    process.env.SERPER_API_KEY = '"quoted-serper-key"';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    answer([{ status: 403, body: { message: 'Unauthorized.' } }, { status: 200, body: DDG_PAGE }]);
    await expect(search.fetchWebSearch('q', 'cid-3', 5)).resolves.toMatch(/From DDG/);
    expect(audits.map((a) => [a[0], a[2]])).toEqual([['SEARCH_KEY_REJECTED', 403], ['DDG_SEARCH_SUCCESS', 200]]);
  });

  it('another HTTP error is audited as a provider error, not a refused key', async () => {
    process.env.BRAVE_API_KEY = 'BSA-rate-limited';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    answer([{ status: 429, body: { type: 'ErrorResponse' } }]);
    await expect(search.fetchBraveSearch('q', 'cid-4', 5)).resolves.toBeNull();
    expect(audits[0].slice(0, 1)).toEqual(['SEARCH_PROVIDER_ERROR']);
    expect(searchModule.searchKeyStatus('BRAVE_API_KEY').state).toBe('ok');
  });

  it('a 200 with results still returns them', async () => {
    process.env.BRAVE_API_KEY = 'BSA-good';
    answer([{ status: 200, body: { web: { results: [{ title: 'T', description: 'D', url: 'https://example.org' }] } } }]);
    await expect(search.fetchBraveSearch('q', 'cid-5', 5)).resolves.toMatch(/\*\*T\*\*/);
    expect(audits[0][0]).toBe('BRAVE_SEARCH_SUCCESS');
  });
});

describe('Settings reports it', () => {
  it('providers/nervous-system do not call a refused search key connected', async () => {
    process.env.TAVILY_API_KEY = 'tvly-refused-again';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    answer([{ status: 401, body: {} }]);
    await search.fetchTavilySearch('q', 'cid-6', 5);

    const checks = await fetch(`${base}/api/settings/providers`).then((r) => r.json());
    expect(checks.tavily).toBe(false);
    const ns = await fetch(`${base}/api/settings/nervous-system`).then((r) => r.json());
    expect(ns.providers.tavily).toMatchObject({ configured: true, connected: false });
    expect(ns.providers.tavily.reason).toMatch(/Tavily refused this key \(HTTP 401\)/);
  });

  // Settings' mount posts test-provider/<id> (no body) for every provider
  // /providers marks true, to fetch model lists. For a search provider that
  // would spend a paid search on every open; it must not reach the network.
  it('the plain call Settings makes on open spends no search', async () => {
    process.env.TAVILY_API_KEY = 'tvly-live-key';
    process.env.SERPER_API_KEY = 'serper-live-key';
    process.env.BRAVE_API_KEY = 'BSA-live-key';
    const realFetch = globalThis.fetch;
    const calls = [];
    vi.stubGlobal('fetch', async (url, init) => {
      if (String(url).startsWith(base)) return realFetch(url, init);
      calls.push(String(url));
      return new Response('{}', { status: 200 });
    });
    const httpsCalls = vi.spyOn(https, 'request');
    try {
      for (const id of ['tavily', 'serper', 'brave']) {
        const r = await realFetch(`${base}/api/settings/test-provider/${id}`, { method: 'POST' }).then((x) => x.json());
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/no model list/);
      }
      expect(calls).toEqual([]);
      expect(httpsCalls).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it('Test on tavily/serper/brave, asked for by name, asks the provider and names a refusal', async () => {
    process.env.SERPER_API_KEY = 'serper-dead-key';
    const realFetch = globalThis.fetch;
    const calls = [];
    vi.stubGlobal('fetch', async (url, init) => {
      if (String(url).startsWith(base)) return realFetch(url, init);
      calls.push(String(url));
      return new Response('{"message":"Unauthorized."}', { status: 403 });
    });
    try {
      const r = await realFetch(`${base}/api/settings/test-provider/serper`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ probe: true }),
      }).then((x) => x.json());
      expect(calls).toEqual(['https://google.serper.dev/search']);
      expect(r).toMatchObject({ ok: false, status: 403 });
      expect(r.error).toMatch(/Serper refused the key \(HTTP 403\)/);
      expect(searchModule.searchKeyStatus('SERPER_API_KEY').state).toBe('rejected');
    } finally { vi.unstubAllGlobals(); }
  });
});
