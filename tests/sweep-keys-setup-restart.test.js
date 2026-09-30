/**
 * C30 — the First-time setup wizard's "Restart AEON now" says what AEON
 * answered.
 *
 * doRestart fired POST /api/settings/restart inside `try {} catch {}`, never
 * read the answer, and a second later toasted "AEON is restarting — reload in
 * ~15s". Under npm start / npm run server / an older launcher the route
 * refuses (501, a reason and a remedy) and the server never goes down; busy
 * was never cleared, so every wizard button stayed disabled.
 *
 * The node test environment cannot render the wizard. So: the route's real
 * refusal goes through the helper the wizard now uses (requestRestart, the one
 * the header's RESTART already uses) and comes back as "not restarting" with
 * the remedy; and the wizard's source is checked to use it and to clear busy.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { requestRestart } from '../src/utils/restartRequest.js';

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-sweep-restart-'));
const ENV_NAMES = ['AEON_HOME', 'AEON_SECRETS_DIR', 'AEON_ENV_FILE', 'AEON_SUPERVISED', 'PM2_HOME', 'NODEMON'];
const saved = Object.fromEntries(ENV_NAMES.map((k) => [k, process.env[k]]));
process.env.AEON_HOME = path.join(tmp, 'home');
process.env.AEON_SECRETS_DIR = path.join(tmp, 'secrets');
process.env.AEON_ENV_FILE = path.join(tmp, '.env');
for (const k of ['AEON_SUPERVISED', 'PM2_HOME', 'NODEMON']) delete process.env[k];
fs.mkdirSync(process.env.AEON_SECRETS_DIR, { recursive: true });

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
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
afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the wizard\'s restart', () => {
  it('an unsupervised AEON\'s refusal comes back as "not restarting", with the remedy', async () => {
    if (fs.existsSync(path.join(ROOT, 'restart.bat'))) return; // a relauncher here would really restart
    const seen = [];
    const r = await requestRestart((url, init) => { seen.push(url); return fetch(`${base}/api/settings/restart`, init); });
    expect(r.restarting).toBe(false);
    expect(r.message).toMatch(/cannot restart itself in this launch mode/);
    expect(r.message).toMatch(/start it again with your normal launcher/);
    expect(seen).toHaveLength(1);
  });

  it('SetupWizard reads the answer and clears busy on a refusal', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'blocks', 'settings', 'index.jsx'), 'utf8');
    const start = src.indexOf('function SetupWizard(');
    const body = src.slice(start, src.indexOf('\nfunction ', start + 1));
    const doRestart = body.slice(body.indexOf('const doRestart'), body.indexOf('if (!status) return null;'));
    expect(doRestart).toMatch(/await requestRestart\(/);
    expect(doRestart).toMatch(/if \(!r\.restarting\) \{ setBusy\(false\);/);
    expect(doRestart).not.toMatch(/catch \{\}/);
    expect(doRestart).not.toMatch(/reload in ~15s/);
  });
});
