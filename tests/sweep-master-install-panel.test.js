/**
 * Master → Install, against what the server really mounts and answers.
 *
 * 2026-09-28 sweep (C01/C02/C07): the panel shipped fetching
 * /blocks/store/source and POSTing /blocks/store/install. Nothing has ever
 * been mounted there — the store router lives at /api/store — so the GET got
 * the SPA's index.html and the panel said the store could not be reached, and
 * every install was an Express 404. tests/master-install-panel.test.js only
 * imported the pure helpers, so CI stayed green. This checks every path the
 * panel fetches against server.js's mounts and the block manifests, then
 * drives the panel's own store calls through the real router.
 *
 * C04: the section chooser read blockLayout off the top of GET /api/settings
 * (it lives at settings.blockLayout), started from an empty layout, and wrote
 * that back through a route that replaces the whole layout — erasing every
 * section the operator had made. Driven here against the real settings routes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Before any module that resolves a home, a secrets dir or a .env.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-master-install-'));
process.env.AEON_HOME = path.join(tmp, 'home');
process.env.AEON_SECRETS_DIR = path.join(tmp, 'secrets');
process.env.AEON_ENV_FILE = path.join(tmp, '.env');
for (const d of [process.env.AEON_HOME, process.env.AEON_SECRETS_DIR]) fs.mkdirSync(d, { recursive: true });
const savedStore = process.env.AEON_STORE;

const express = require('express');
const AdmZip = require('adm-zip');
const { sha256 } = require('../src/kernel/storeSource.cjs');
const panel = await import('../src/blocks/master/InstallPanel.jsx');
const { BLOCKS } = await import('../src/kernel/blockRegistry.js');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const panelSrc = read('src/blocks/master/InstallPanel.jsx');
const serverSrc = read('server/server.js');

// Every fetch the panel makes, as "METHOD /path".
const fetched = [...panelSrc.matchAll(/fetch\(\s*'([^']+)'(?:\s*,\s*\{\s*method:\s*'(\w+)')?/g)]
  .map((m) => `${(m[2] || 'GET').toUpperCase()} ${m[1]}`);
const fetchedPath = (re) => (fetched.find((f) => re.test(f)) || '').replace(/^\w+ /, '');

// What the server answers: each kernel router at the prefix server.js mounts
// it on, plus every route a block manifest declares (gen-block-routes keeps
// those equal to the block's api code).
function servedRoutes() {
  const out = new Set();
  const files = {};
  for (const m of serverSrc.matchAll(/const (\w+) = require\('(\.\.\/src\/kernel\/routers\/[\w.-]+\.cjs)'\)/g)) {
    files[m[1]] = path.join(ROOT, 'server', m[2]);
  }
  for (const m of serverSrc.matchAll(/app\.use\(\s*'([^']+)'\s*,[^;]*?\b(\w+)\s*\)\s*;/g)) {
    if (!files[m[2]]) continue;
    for (const r of fs.readFileSync(files[m[2]], 'utf8').matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) {
      out.add(`${r[1].toUpperCase()} ${m[1]}${r[2]}`);
    }
  }
  for (const d of fs.readdirSync(path.join(ROOT, 'src/blocks'))) {
    const mf = path.join(ROOT, 'src/blocks', d, 'block.manifest.json');
    if (!fs.existsSync(mf)) continue;
    for (const r of JSON.parse(fs.readFileSync(mf, 'utf8')).routes || []) out.add(`${String(r.method).toUpperCase()} ${r.path}`);
  }
  return out;
}

const ID = 'zz_master_panel_probe';
function makeStore(dir) {
  const zip = new AdmZip();
  zip.addFile(`${ID}/block.manifest.json`, Buffer.from(JSON.stringify({ id: ID, name: ID, label: 'Panel Probe', version: '1.2.0', route: `/${ID}` })));
  zip.addFile(`${ID}/index.jsx`, Buffer.from('export default () => null;\n'));
  const buf = zip.toBuffer();
  fs.mkdirSync(path.join(dir, 'cartridges'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'cartridges', `${ID}-1.2.0.aeon`), buf);
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify({ store: 'Probe Store', items: [
    { file: `${ID}-1.2.0.aeon`, id: ID, version: '1.2.0', label: 'Panel Probe', tier: 1, warnings: [], sha256: sha256(buf) },
  ] }));
}

let server, base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // The store router at the prefix server.js gives it — not a copy of it.
  const storeMount = serverSrc.match(/app\.use\(\s*'([^']+)'\s*,\s*storeRouter\s*\)/)[1];
  app.use(storeMount, require('../src/kernel/routers/store.cjs')({
    // What buildPipeline.submitBuild answers for a block that goes live.
    pipeline: { submitBuild: async () => ({ ok: true, stage: 'live' }) },
  }));
  const settingsService = require('../services/settings.js');
  require('../src/blocks/settings/api/settings.js')(app, {
    cloudCredentials: settingsService.createCloudCredentialStore({ file: path.join(tmp, 'cloud.json') }),
    providerCredentials: settingsService.createProviderCredentialStore({ file: path.join(tmp, 'provider.json') }),
    supabase: null,
  });
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (savedStore === undefined) delete process.env.AEON_STORE; else process.env.AEON_STORE = savedStore;
  delete process.env.AEON_ENV_FILE;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Master → Install calls what the server serves', () => {
  it('every path the panel fetches is one the server mounts', () => {
    const served = servedRoutes();
    // The reader must see real routes, or "not served" would prove nothing.
    expect(served.has('GET /api/store/source')).toBe(true);
    expect(served.has('POST /api/settings/block-layout')).toBe(true);
    expect(fetched.length).toBeGreaterThanOrEqual(3);
    for (const f of fetched) expect(served.has(f), `${f} is fetched but nothing serves it`).toBe(true);
  });

  it('lists the store and installs from it through the real store router', async () => {
    const dir = path.join(tmp, 'store');
    makeStore(dir);
    process.env.AEON_STORE = dir;

    const list = await fetch(base + fetchedPath(/^GET .*store\/source$/));
    expect(list.status).toBe(200);
    const catalog = await list.json();
    expect(catalog.configured).toBe(true);
    expect(catalog.items.map((i) => i.id)).toEqual([ID]);

    const cls = panel.classifySource(ID);
    const r = await fetch(base + fetchedPath(/^POST .*store\/install$/), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cls.body),
    });
    expect(r.status).toBe(200);
    // The label and version the operator sees come from the route's answer.
    expect(panel.installOutcome(await r.json(), cls)).toEqual({ id: ID, label: 'Panel Probe', detail: 'v1.2.0', queued: false });
  });

  it('an install by link takes its id from the route, and a queued one is not called installed', () => {
    const cls = panel.classifySource('https://store.example/zz_x-2.0.0.aeon');
    const d = { ok: true, stage: 'queued', blockId: 'zz_x', purchase: { id: 'zz_x', label: 'Zed X', version: '2.0.0' } };
    expect(panel.installOutcome(d, cls)).toEqual({ id: 'zz_x', label: 'Zed X', detail: 'v2.0.0', queued: true });
  });

  it('collects no licence key while the install route reads none', () => {
    // If the store route learns to check a key, the field comes back with it.
    expect(read('src/kernel/store.cjs')).not.toMatch(/licen[cs]e/i);
    expect(panelSrc).not.toMatch(/licenceKey/);
  });
});

describe('Master → Install files a block without erasing the operator\'s sections', () => {
  const seed = {
    overrides: { reports: 'client_work', tasks: 'tools' },
    customGroups: { client_work: { label: 'Client Work', icon: 'briefcase', order: 20 } },
    groupOverrides: { tools: { label: 'Utilities' }, content: { hidden: true } },
  };

  it('reads the saved layout where GET /api/settings puts it, and writes it all back', async () => {
    require('../services/settings.js').saveSettings({ blockLayout: seed });
    const layout = panel.layoutFromSettings(await (await fetch(`${base}/api/settings`)).json());
    expect(layout).toEqual(seed);

    const r = await fetch(`${base}/api/settings/block-layout`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(panel.placeBlock(layout, 'zz_new', 'tools')),
    });
    expect(r.status).toBe(200);
    const after = panel.layoutFromSettings(await (await fetch(`${base}/api/settings`)).json());
    expect(after).toEqual({ ...seed, overrides: { ...seed.overrides, zz_new: 'tools' } });
  });

  it('a section named again is reused, not reset', () => {
    const next = panel.placeBlock(seed, 'zz_new', 'client_work', 'Client Work');
    expect(next.customGroups.client_work).toEqual(seed.customGroups.client_work);
    expect(panel.placeBlock(seed, 'zz_new', 'payroll', 'Payroll').customGroups.payroll).toEqual({ label: 'Payroll', icon: 'custom', order: 50 });
    expect(seed.overrides.zz_new).toBeUndefined(); // the input is not mutated
  });

  it('an answer that is not the settings reply is not a layout (nothing gets written from it)', () => {
    expect(panel.layoutFromSettings({})).toBeNull();
    expect(panel.layoutFromSettings({ error: 'UNAUTHORIZED_SESSION' })).toBeNull();
    // The shape the chooser used to read: blockLayout at the top level.
    expect(panel.layoutFromSettings({ blockLayout: seed })).toBeNull();
    // A settings file with no layout yet is a real, empty one.
    expect(panel.layoutFromSettings({ settings: {} })).toEqual({ overrides: {}, customGroups: {}, groupOverrides: {} });
  });

  it('offers the sidebar\'s sections: renamed, custom, never hidden, never Unsorted', () => {
    const defaults = [...new Set(BLOCKS.filter((b) => b.uiMode !== 'headless').map((b) => b.group))];
    expect(defaults.length).toBeGreaterThanOrEqual(2);
    const [renamed, hidden, ...rest] = defaults;
    const choices = panel.sectionChoices({
      overrides: {},
      customGroups: { client_work: { label: 'Client Work' } },
      groupOverrides: { [renamed]: { label: 'Renamed' }, [hidden]: { hidden: true } },
    });
    const ids = choices.map((c) => c.id);
    expect(choices).toContainEqual({ id: 'client_work', name: 'Client Work' });
    expect(choices).toContainEqual({ id: renamed, name: 'Renamed' });
    expect(ids).not.toContain(hidden);
    expect(ids).not.toContain('unsorted');
    for (const g of rest) expect(ids).toContain(g);
  });
});

// Review follow-ups. The helpers above are pure; nothing tied SectionChooser
// to them — the gap that let the original erasure through (the old test file
// imported only pure helpers). No DOM here, so its body is read.
describe('Master → Install, wired as the helpers say', () => {
  const code = panelSrc.replace(/^\s*\/\/.*$/gm, '');
  const chooser = code.slice(code.indexOf('function SectionChooser('), code.indexOf('export const labelise'));

  it('SectionChooser reads the layout through layoutFromSettings and writes through placeBlock', () => {
    expect(chooser).toMatch(/const bl = layoutFromSettings\(d\);/);
    expect(chooser.indexOf('placeBlock(layout, blockId, groupId, customLabel)'))
      .toBeLessThan(chooser.indexOf("fetch('/api/settings/block-layout'"));
    expect(chooser).not.toMatch(/\.blockLayout \|\|/);
  });

  it('every fetch carries the self-reported header — its refusals are shown inline, not also bannered', () => {
    const calls = [...code.matchAll(/fetch\('[^']+'(?:,\s*\{[^}]*\}[^)]*)?\)/g)].map((m) => m[0]);
    expect(calls.length).toBe(4);
    for (const c of calls) expect(c, c).toMatch(/SELF_REPORTED/);
    expect(code).toMatch(/const SELF_REPORTED = \{ 'x-aeon-self-reported': '1' \};/);
  });

  it('says the block lands stopped, and that its screen needs a build — not that AEON starts it', () => {
    expect(code).not.toMatch(/starts it, and opens its screens/);
    expect(code).toMatch(/It then lands stopped/);
    expect(chooser).toMatch(/start it in Settings → Blocks\. \$\{UI_NOTE\}/);
    expect(code).toMatch(/npm run build/);
  });

  it('a hidden section named again is shown again, so the block is not sent to Unsorted', () => {
    const [hiddenDefault] = [...new Set(BLOCKS.filter((b) => b.uiMode !== 'headless').map((b) => b.group))];
    const layout = {
      overrides: {}, customGroups: { mine: { label: 'Mine' } },
      groupOverrides: { [hiddenDefault]: { hidden: true, label: 'Renamed' }, mine: { hidden: true } },
    };
    const a = panel.placeBlock(layout, 'zz_new', hiddenDefault);
    expect(a.groupOverrides[hiddenDefault]).toEqual({ label: 'Renamed' });
    expect(panel.sectionChoices(a).map((c) => c.id)).toContain(hiddenDefault);
    const b = panel.placeBlock(layout, 'zz_new', 'mine', 'Mine');
    expect(b.groupOverrides.mine).toBeUndefined();
    expect(panel.sectionChoices(b)).toContainEqual({ id: 'mine', name: 'Mine' });
    expect(layout.groupOverrides.mine).toEqual({ hidden: true }); // the input is not mutated
  });
});
