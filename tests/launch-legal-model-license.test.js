/**
 * A catalogue model's license is shown before its download starts (A074).
 *
 * The catalogue recorded a license for every model and nothing displayed it:
 * a Cookbook row was a name, a size and an Install button, and /model-pull
 * printed only the size. Using Llama or Gemma means accepting Meta's or
 * Google's terms; their own downloads ask first, and the public copies the
 * catalogue downloads never do. These tests check the license reaches the
 * Cookbook row data and the /model-pull text, with the licensor's own terms
 * linked for Llama and Gemma. No network: installers are stubs.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-legal-lic-'));
process.env.AEON_HOME = path.join(tmp, 'home');
process.env.AEON_SECRETS_DIR = path.join(tmp, 'home', 'secrets');
process.env.AEON_ENV_FILE = path.join(tmp, 'home', '.env');
fs.mkdirSync(process.env.AEON_SECRETS_DIR, { recursive: true });

const createCookbookRouter = require('../src/blocks/cookbook/api/index.cjs');
const catalog = require('../services/local-runtime/model-catalog.json').models;
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

const byId = (id) => catalog.find(m => m.id === id);
const GATED = ['llama3-8b-q4', 'llama32-1b-q8', 'llama32-3b-q4', 'gemma2-2b-q4'];

describe('modelLicense — every catalogue model', () => {
  it('is exported for the route and this test', () => {
    expect(typeof createCookbookRouter.modelLicense).toBe('function');
  });

  it('names a license and links it, for every entry', () => {
    for (const m of catalog) {
      const lic = createCookbookRouter.modelLicense(m);
      expect(lic.name, m.id).toBeTruthy();
      expect(lic.url, m.id).toMatch(/^https:\/\//);
    }
  });

  it('Llama and Gemma say whose terms using them accepts, and link the licensor, not the re-host', () => {
    const want = {
      'llama3-8b-q4': ['Meta', 'Llama 3.1 Community License', /huggingface\.co\/meta-llama\//],
      'llama32-1b-q8': ['Meta', 'Llama 3.2 Community License', /huggingface\.co\/meta-llama\//],
      'llama32-3b-q4': ['Meta', 'Llama 3.2 Community License', /huggingface\.co\/meta-llama\//],
      'gemma2-2b-q4': ['Google', 'Gemma Terms of Use', /^https:\/\/ai\.google\.dev\/gemma\/terms$/],
    };
    for (const id of GATED) {
      const lic = createCookbookRouter.modelLicense(byId(id));
      const [licensor, name, url] = want[id];
      expect(lic.requiresAcceptance, id).toBe(true);
      expect(lic.licensor, id).toBe(licensor);
      expect(lic.name, id).toBe(name);
      expect(lic.url, id).toMatch(url);
      expect(lic.url, id).not.toMatch(/bartowski/);
      expect(lic.policyUrl, id).toMatch(/^https:\/\//);
      expect(lic.notice, id).toMatch(new RegExp(`accepting ${licensor}'s`));
    }
  });

  it('Apache and MIT models carry no acceptance notice', () => {
    for (const m of catalog.filter(x => !GATED.includes(x.id))) {
      const lic = createCookbookRouter.modelLicense(m);
      expect(lic.requiresAcceptance, m.id).toBe(false);
      expect(lic.notice, m.id).toBeNull();
      expect(lic.name, m.id).toBe(m.license);
    }
  });

  it('a Llama the table does not know still says Meta\'s terms apply', () => {
    const lic = createCookbookRouter.modelLicense({ id: 'llama9-1b', displayName: 'Llama 9 1B', license: 'Llama 9', licenseUrl: 'https://example.invalid/l9' });
    expect(lic.requiresAcceptance).toBe(true);
    expect(lic.notice).toMatch(/Meta/);
    expect(lic.url).toBe('https://example.invalid/l9');
  });
});

// ── Through the routes ───────────────────────────────────────────────────────
let root, servers, installers, registry;
const listen = (router) => new Promise((resolve) => {
  const a = express(); a.use(express.json()); a.use('/api', router);
  const server = a.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
});
async function mount() {
  const router = createCookbookRouter({
    isVercel: false, VAULT_ROOT: root, DATA_ROOT: path.join(root, 'data'), getDataFile: (n) => path.join(root, 'data', n),
    getLocalRuntimeRegistry: () => registry, localInstallers: installers, writeOSAudit: () => {},
  });
  const h = await listen(router); servers.push(h.server); return h.port;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(tmp, 'root-'));
  servers = [];
  installers = {
    runtime: { installRuntime: vi.fn(async () => ({ runtimeId: 'llamacpp-stub' })) },
    model: { installModel: vi.fn(async () => ({ ok: true })), listCatalog: () => [] },
  };
  registry = { file: path.join(root, 'data', 'local-runtime', 'local-runtime.json'), activeRuntime: () => null, readyModels: () => [], modelsForCapability: () => [] };
});
afterEach(() => { for (const s of servers) { try { s.close(); } catch {} } });

describe('the license reaches the operator before the download', () => {
  it('GET /cookbook/local/catalog gives every row its license', async () => {
    const port = await mount();
    const r = await fetch(`http://127.0.0.1:${port}/api/cookbook/local/catalog`);
    const body = await r.json();
    expect(body.ok).toBe(true);
    const rows = [...(body.shown || []), ...(body.hidden || [])];
    expect(rows.length).toBe(catalog.length);
    for (const m of rows) {
      expect(m.licenseTerms, m.id).toBeTruthy();
      expect(m.licenseTerms.name, m.id).toBeTruthy();
    }
    const gemma = rows.find(m => m.id === 'gemma2-2b-q4');
    expect(gemma.licenseTerms.requiresAcceptance).toBe(true);
    expect(gemma.licenseTerms.url).toBe('https://ai.google.dev/gemma/terms');
  });

  it('/model-pull of a Llama model prints its license and Meta\'s terms', async () => {
    const port = await mount();
    const r = await fetch(`http://127.0.0.1:${port}/api/model/download`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo_id: 'llama32-1b-q8' }),
    });
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.text).toMatch(/License: Llama 3\.2 Community License \(https:\/\/huggingface\.co\/meta-llama\//);
    expect(body.text).toMatch(/accepting Meta's Llama 3\.2 Community License/);
    expect(body.text).toMatch(/Acceptable Use Policy: https:\/\//);
    expect(body.licenseTerms.requiresAcceptance).toBe(true);
  });

  it('/model-pull of an Apache model prints the license and no acceptance notice', async () => {
    const port = await mount();
    const r = await fetch(`http://127.0.0.1:${port}/api/model/download`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo_id: 'qwen3-1.7b-q8' }),
    });
    const body = await r.json();
    expect(body.text).toMatch(/License: Apache-2\.0 \(https:\/\//);
    expect(body.text).not.toMatch(/accepting/);
  });

  it('the Cookbook row renders the license and the notice next to Install', () => {
    // No DOM in this suite (vitest environment: node); this pins the wiring.
    const jsx = fs.readFileSync(path.join(path.dirname(require.resolve('../src/blocks/cookbook/api/index.cjs')), '..', 'index.jsx'), 'utf8');
    const row = jsx.slice(jsx.indexOf('{fitShown.map(m =>'), jsx.indexOf('installLocalModel(m.id)'));
    expect(row).toMatch(/m\.licenseTerms\.url/);
    expect(row).toMatch(/m\.licenseTerms\.name/);
    expect(row).toMatch(/m\.licenseTerms\?\.notice/);
    expect(row).toMatch(/m\.licenseTerms\.policyUrl/);
  });
});
