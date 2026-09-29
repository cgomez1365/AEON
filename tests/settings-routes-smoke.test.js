/**
 * Every Settings GET route answers without a crash in its own code.
 *
 * 2026-09-28: removing a dead route (fefde03) also removed parseEnvFile and
 * ENV_GROUPS, which GET /api/settings/setup-status still used. Every
 * Settings load then showed "[API FAILED] /api/settings/setup-status —
 * Internal Core Error" and the first-time setup panel. Nothing called that
 * route in the suite, so CI stayed green. This calls all of them.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-settings-smoke-'));
process.env.AEON_HOME = path.join(tmp, 'home');
process.env.AEON_SECRETS_DIR = path.join(tmp, 'secrets');
process.env.AEON_ENV_FILE = path.join(tmp, '.env');
fs.mkdirSync(process.env.AEON_SECRETS_DIR, { recursive: true });

const express = require('express');
const settingsService = require('../services/settings.js');
const manifest = require('../src/blocks/settings/block.manifest.json');
const api = ['settings.js', 'connections.js', 'connectivity.js', 'model-scan.js']
  .map((f) => require(`../src/blocks/settings/api/${f}`));

afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); delete process.env.AEON_ENV_FILE; });

// Routes that reach a live network service are left out: they are not what
// this gate is about, and a test must not call out.
const NETWORK = /test-provider|model-scan|discover|scan|provider-models|free-models/;
const gets = manifest.routes
  .filter((r) => r.method === 'GET' && !r.path.includes(':') && !NETWORK.test(r.path))
  .map((r) => r.path);

describe('Settings GET routes', () => {
  it.each(gets)('%s does not crash on a missing name', async (route) => {
    const app = express();
    app.use(express.json());
    const deps = {
      cloudCredentials: settingsService.createCloudCredentialStore({ file: path.join(tmp, 'cloud.json') }),
      providerCredentials: settingsService.createProviderCredentialStore({ file: path.join(tmp, 'provider.json') }),
      supabase: null,
    };
    for (const mount of api) { try { mount(app, deps); } catch { /* optional module */ } }
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${route}`);
      const body = await res.text();
      expect(body, `${route} → ${res.status}`).not.toMatch(/is not defined|is not a function|Cannot read properties of undefined/);
      expect(res.status, `${route}: ${body.slice(0, 200)}`).not.toBe(500);
    } finally { server.close(); }
  });
});
