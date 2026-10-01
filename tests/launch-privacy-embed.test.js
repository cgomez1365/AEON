/**
 * Settings → Models → Local only covers embedding too (audit A072 review).
 *
 * services/ai.js honours settings.local_only for every chat, research and
 * vision call, but embedding goes through src/kernel/embed.cjs, which did not
 * read it. The Vault scan embeds every document and /ask and /converse embed
 * each query, so with Local only on and a hosted embedder assigned, all of
 * that still left the machine. kernelEmbed now refuses a non-local embedder
 * while Local only is on, with the remedy; off (the default) is unchanged.
 *
 * Drives the REAL kernelEmbed against a REAL registry and settings file in
 * temp dirs. fetch is a stub that records every host and answers a vector.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODS = [
  path.join(ROOT, 'src', 'kernel', 'embed.cjs'),
  path.join(ROOT, 'src', 'kernel', 'endpoints.cjs'),
  path.join(ROOT, 'services', 'settings.js'),
  path.join(ROOT, 'services', 'storage.js'),
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-embed-local-only-'));
const saved = {
  secrets: process.env.AEON_SECRETS_DIR, settingsFile: process.env.AEON_SETTINGS_FILE,
  portable: process.env.AEON_PORTABLE,
};
// Set BEFORE the require: endpoints.cjs and storage.js resolve paths at module scope.
process.env.AEON_SECRETS_DIR = path.join(tmp, 'secrets');
process.env.AEON_SETTINGS_FILE = path.join(tmp, 'aeon-settings.json');
delete process.env.AEON_PORTABLE;
fs.mkdirSync(process.env.AEON_SECRETS_DIR, { recursive: true });
const REG_FILE = path.join(process.env.AEON_SECRETS_DIR, 'aeon-endpoints.json');

const savedCache = Object.fromEntries(MODS.map((p) => [p, require.cache[p]]));
for (const p of MODS) delete require.cache[p];

const realFetch = globalThis.fetch;
const hosts = [];
let kernelEmbed;

const writeSettings = (s) => fs.writeFileSync(process.env.AEON_SETTINGS_FILE, JSON.stringify(s));
const useEmbedder = (base_url) => fs.writeFileSync(REG_FILE, JSON.stringify({
  endpoints: [{ id: 'emb', provider: 'custom', base_url, reachable_from: ['local'], models: ['text-embedding-3-small'], rpm_limit: 0 }],
  roles: { embed: { endpoint_id: 'emb', model: 'text-embedding-3-small' } },
}));

beforeAll(() => {
  globalThis.fetch = async (url) => {
    hosts.push(new URL(String(url?.url || url)).hostname);
    return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  ({ kernelEmbed } = require(MODS[0]));
});

afterAll(() => {
  globalThis.fetch = realFetch;
  for (const [p, mod] of Object.entries(savedCache)) { if (mod) require.cache[p] = mod; else delete require.cache[p]; }
  for (const [k, env] of [['secrets', 'AEON_SECRETS_DIR'], ['settingsFile', 'AEON_SETTINGS_FILE'], ['portable', 'AEON_PORTABLE']]) {
    if (saved[k] === undefined) delete process.env[env]; else process.env[env] = saved[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => { hosts.length = 0; });

describe('embedding under Local only', () => {
  it('off (the default): a hosted embedder is used, as before', async () => {
    writeSettings({ models: {}, local_only: false });
    useEmbedder('https://embeddings.example.net/v1');
    const r = await kernelEmbed('a private passage');
    expect(r.vector).toEqual([0.1, 0.2, 0.3]);
    expect(hosts).toEqual(['embeddings.example.net']);
  });

  it('on: a hosted embedder is refused with the remedy, and nothing is sent', async () => {
    writeSettings({ models: {}, local_only: true });
    useEmbedder('https://embeddings.example.net/v1');
    const err = await kernelEmbed('a private passage').then(() => null, (e) => e);
    expect(err, 'the passage was embedded by a hosted endpoint').toBeInstanceOf(Error);
    expect(err).toMatchObject({ code: 'local_only', embedFailure: true });
    expect(err.message).toMatch(/Local only is on/);
    expect(err.action).toMatch(/Cookbook/);
    expect(hosts).toEqual([]);
  });

  it('on: an embedder on this machine or the LAN is still used', async () => {
    writeSettings({ models: {}, local_only: true });
    for (const base of ['http://127.0.0.1:1234/v1', 'http://192.168.1.20:8080/v1']) {
      useEmbedder(base);
      const r = await kernelEmbed('a private passage');
      expect(r.vector).toEqual([0.1, 0.2, 0.3]);
    }
    expect(hosts).toEqual(['127.0.0.1', '192.168.1.20']);
  });
});
