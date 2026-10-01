/**
 * The privacy notice states the largest automatic data flow AEON has (A066,
 * review 2026-09-30).
 *
 * Indexing the Vault sends every indexed document to whatever serves the
 * `embed` role. With no local embedder installed and no role assigned, the
 * kernel auto-picks the first keyed endpoint and any model on it that looks
 * like an embedder ("add a key → it just works"). So adding one cloud key can
 * upload the Vault in the background. The first PRIVACY.md left that out while
 * listing smaller flows. These tie the notice's sentence to the resolver's
 * real behaviour, so neither can change without the other.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// Isolate BEFORE the require — endpoints.cjs and the local runtime resolve
// their paths at module scope. No live install is read, nothing is fetched.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-legal-embed-'));
process.env.AEON_HOME = path.join(tmp, 'home');
process.env.AEON_SECRETS_DIR = path.join(tmp, 'secrets');
process.env.AEON_ENV_FILE = path.join(tmp, '.env');
delete process.env.AEON_PORTABLE;
fs.mkdirSync(process.env.AEON_HOME, { recursive: true });
fs.mkdirSync(process.env.AEON_SECRETS_DIR, { recursive: true });

const endpoints = require('../src/kernel/endpoints.cjs');

afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

describe('privacy notice: Vault indexing over a cloud embedder', () => {
  it('says that adding a key can send the whole Vault to that provider, and how to keep it local', () => {
    const p = read('PRIVACY.md');
    expect(p).toMatch(/Indexing your Vault \(the Embedding role\)/);
    expect(p).toMatch(/whole text, piece by piece/);
    expect(p).toMatch(/at startup, once a night, and whenever you add or change a file or memory/);
    expect(p).toMatch(/picks the first provider you have added a key for/);
    expect(p).toMatch(/install a local embedding model in Cookbook/);
  });

  it('the resolver really does pick a keyed cloud embedder unasked when nothing local is installed', async () => {
    // A fresh install where the operator added one OpenAI key and assigned no roles.
    fs.writeFileSync(path.join(process.env.AEON_SECRETS_DIR, 'aeon-endpoints.json'), JSON.stringify({
      endpoints: [{
        id: 'ep-openai', provider: 'openai', base_url: 'https://api.openai.com/v1',
        auth_ref: 'vault:openai', reachable_from: ['local'],
        models: ['gpt-4o-mini', 'text-embedding-3-small'],
      }],
      roles: {},
    }));
    const r = await endpoints.resolveForRole('embed');
    expect(r.ok).toBe(true);
    expect(r.provider).toBe('openai');
    expect(r.model).toBe('text-embedding-3-small');
  });

  it('the indexer sends a long document whole, window by window, on boot and nightly', () => {
    const ingest = read('src/blocks/aeon_matrix/api/ingest.cjs');
    expect(ingest).toMatch(/embedFn\(text\.slice\(w\.s, w\.e\)/);
    expect(ingest).toMatch(/NIGHTLY_HOUR/);
    expect(read('server/server.js')).toMatch(/Boot auto-sync/);
  });
});
