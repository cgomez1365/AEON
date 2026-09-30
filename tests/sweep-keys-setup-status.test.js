/**
 * C21 — setup-status reads .env the way the server does, and the live
 * process wins.
 *
 * `{ ...process.env, ...parseEnvFile() }` spread the template's empty
 * `GROQ_API_KEY=` placeholders over the keys the vault had hydrated, so on an
 * install whose keys live in connections the First-time setup wizard said "no
 * API keys" forever. The hand parser also kept "   # comment" as a value and
 * matched no CRLF line; GET /api/settings's twin called `KEY=""` configured.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-sweep-setup-'));
process.env.AEON_HOME = path.join(tmp, 'home');
process.env.AEON_SECRETS_DIR = path.join(tmp, 'secrets');
process.env.AEON_ENV_FILE = path.join(tmp, '.env');
fs.mkdirSync(process.env.AEON_SECRETS_DIR, { recursive: true });

const ANY = ['GROQ_API_KEY', 'GEMINI_FREE_KEY_1', 'GEMINI_PAID_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY'];
const saved = Object.fromEntries(ANY.map((k) => [k, process.env[k]]));

const express = require('express');
const settingsService = require('../services/settings.js');
const mount = require('../src/blocks/settings/api/settings.js');

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  mount(app, {
    cloudCredentials: settingsService.createCloudCredentialStore({ file: path.join(tmp, 'cloud.json') }),
    providerCredentials: settingsService.createProviderCredentialStore({ file: path.join(tmp, 'provider.json') }),
    supabase: null,
  });
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(() => { for (const k of ANY) delete process.env[k]; });
afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  delete process.env.AEON_ENV_FILE;
  fs.rmSync(tmp, { recursive: true, force: true });
});

// The drive's .env: every anyOf key present and empty.
const BARE = [
  'AEON_VAULT_MASTER_KEY=x',
  'GROQ_API_KEY=',
  'OPENROUTER_API_KEY=',
  'GEMINI_PAID_KEY=',
  'GEMINI_FREE_KEY_1=',
  'OPENAI_API_KEY=',
  'ANTHROPIC_API_KEY=',
  '',
].join('\n');
// The template's shape, with a doc comment after one placeholder.
const TEMPLATE = BARE.replace('ANTHROPIC_API_KEY=', 'ANTHROPIC_API_KEY=   # console.anthropic.com');
const status = () => fetch(`${base}/api/settings/setup-status`).then((r) => r.json());

describe('GET /api/settings/setup-status', () => {
  it('an empty .env placeholder does not hide a key the running process holds', async () => {
    fs.writeFileSync(process.env.AEON_ENV_FILE, BARE);
    expect((await status()).steps.apiKeys).toBe(false);
    process.env.OPENROUTER_API_KEY = 'sk-or-hydrated-from-vault';
    const s = await status();
    expect(s.steps.apiKeys).toBe(true);
    expect(s.groups.apiKeys.configured).toBe(true);
  });

  it('a placeholder holding only "# comment" is not a key', async () => {
    fs.writeFileSync(process.env.AEON_ENV_FILE, TEMPLATE);
    expect((await status()).steps.apiKeys).toBe(false);
  });

  it('a key typed into a CRLF .env since boot still counts', async () => {
    fs.writeFileSync(process.env.AEON_ENV_FILE, 'GROQ_API_KEY=\r\nOPENAI_API_KEY=sk-typed-since-boot\r\n');
    expect((await status()).steps.apiKeys).toBe(true);
  });
});

describe('GET /api/settings envKeys', () => {
  it('reads CRLF lines, and KEY="" is missing', async () => {
    fs.writeFileSync(process.env.AEON_ENV_FILE, 'GROQ_API_KEY=gsk_x\r\nOPENAI_API_KEY=""\r\nexport ANTHROPIC_API_KEY=sk-ant-x\r\n');
    const { envKeys } = await fetch(`${base}/api/settings`).then((r) => r.json());
    expect(envKeys.GROQ_API_KEY).toBe('configured');
    expect(envKeys.OPENAI_API_KEY).toBe('missing');
    expect(envKeys.ANTHROPIC_API_KEY).toBe('configured');
  });
});
