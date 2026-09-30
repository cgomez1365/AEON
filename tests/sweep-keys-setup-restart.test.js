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

  // Review follow-up: /api/health is Host OS's route. With Host OS stopped or
  // removed, or a relaunch that never boots, the wait polled forever with
  // every wizard button disabled and nothing said.
  it('the wait after a restart gives up, says where to look, and counts any answer once AEON was down', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'blocks', 'settings', 'index.jsx'), 'utf8');
    const start = src.indexOf('function SetupWizard(');
    const body = src.slice(start, src.indexOf('\nfunction ', start + 1));
    const doRestart = body.slice(body.indexOf('const doRestart'), body.indexOf('if (!status) return null;'));
    expect(doRestart).toMatch(/if \(Date\.now\(\) - started > RESTART_WAIT_MS\) \{\s*setBusy\(false\);/);
    expect(doRestart).toMatch(/Check the window AEON was started from/);
    expect(doRestart).toMatch(/h\.ok \|\| \(sawDown && h\.status !== 502 && h\.status !== 504\)/);
    expect(src).toMatch(/const RESTART_WAIT_MS = \d+;/);
  });
});

describe('Settings key screens report a refused save and a refused key', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'blocks', 'settings', 'index.jsx'), 'utf8');
  const fn = (name) => { const i = src.indexOf(`function ${name}(`); return src.slice(i, src.indexOf('\nfunction ', i + 1)); };

  it('Web Search: a save the route refused is not "Saved", and a refused key is not "no key"', () => {
    const panel = fn('SearchKeysPanel');
    expect(panel).toMatch(/if \(!r\.ok\) \{[\s\S]*?showToast\(d\?\.error \? `Not saved — \$\{d\.error\}`/);
    expect(panel.indexOf('if (!r.ok)')).toBeLessThan(panel.indexOf('setSaved(true)'));
    expect(panel).toMatch(/p\.configured && p\.connected === false/);
    expect(panel).toMatch(/'⚠ key not working'/);
    expect(src).toMatch(/<SearchKeysPanel providers=\{providers\} nervousSystem=\{nervousSystem\}/);
  });

  it('Account identities: a refused key save shows the route\'s reason', () => {
    expect(fn('AccountIdentities')).toMatch(/showToast\(d\?\.error \? `Not saved — \$\{d\.error\}` : `Save failed \(HTTP \$\{r\.status\}\)`, 'error'\)/);
  });

  it('Export backup needs no password field before an account exists', () => {
    const exp = fn('ExportCredentialsButton');
    expect(exp).toMatch(/fetch\('\/api\/auth\/status'\)/);
    expect(exp).toMatch(/disabled=\{busy \|\| \(hasAccount && !password\)\}/);
    expect(exp).toMatch(/No account yet — this computer only\./);
  });
});
