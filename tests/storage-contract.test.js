import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const storage = require('../services/storage.js');
const { createBlockStorage } = require('../src/kernel/blockStorage.cjs');
const { validateManifest } = require('../src/kernel/staging.cjs');
const ingestFactory = require('../src/blocks/aeon_matrix/api/ingest.cjs');

describe('Vault and block storage contract', () => {
  let tempDir;
  let originalFetch;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-storage-test-'));
    originalFetch = global.fetch;
    global.fetch = vi.fn().mockRejectedValue(new Error('embedding unavailable in unit test'));
  });

  afterEach(() => {
    global.fetch = originalFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('keeps a block inside its own local and Vault namespaces', () => {
    expect(storage.getBlockVaultFile('writer', 'notes/one.md')).toContain(path.join('Vault', 'blocks', 'writer', 'notes', 'one.md'));
    expect(() => storage.getBlockDataFile('writer', '../outside.json')).toThrow(/escapes/);
  });

  it('writes ordinary state locally and declared memory to the Vault', () => {
    const dataRoot = path.join(tempDir, 'data');
    const vaultRoot = path.join(tempDir, 'Vault', 'blocks');
    const indexed = [];
    const blockStorage = createBlockStorage({
      blockId: 'briefing',
      contract: {
        permissions: { filesystem: 'write' },
        storage: { type: 'json', scope: 'block', local: { indexed: false, retention: 'operational' } },
        memory: { mode: 'document', indexed: true, userConfigurable: true },
      },
      getBlockDataFile: (id, rel = '') => path.resolve(dataRoot, id, rel),
      getBlockVaultFile: (id, rel = '') => path.resolve(vaultRoot, id, rel),
      vaultSync: vi.fn(),
      requestIndex: (change) => indexed.push(change),
    });

    const localFile = blockStorage.writeData('reports/run.json', '{"ok":true}');
    const memoryFile = blockStorage.writeMemoryDocument('notes/decision.md', '# Decision\n\nKeep this long enough to index.');

    expect(localFile).toContain(path.join('data', 'briefing', 'reports'));
    expect(memoryFile).toContain(path.join('Vault', 'blocks', 'briefing', 'notes'));
    expect(indexed).toEqual([{ blockId: 'briefing', kind: 'document', path: 'notes/decision.md' }]);
  });

  it('indexes Vault-relative paths and never scans operational data', async () => {
    const vaultRoot = path.join(tempDir, 'Vault');
    const dataRoot = path.join(tempDir, 'data');
    const memoryFile = path.join(vaultRoot, 'blocks', 'briefing', 'decision.md');
    fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
    fs.writeFileSync(memoryFile, '# Long-term decision\n\nThis is durable user memory and should be indexed.', 'utf8');
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(path.join(dataRoot, 'transient.md'), 'This operational file must not enter the Matrix index.', 'utf8');
    const restricted = path.join(vaultRoot, 'blocks', 'security', 'credentials.json');
    fs.mkdirSync(path.dirname(restricted), { recursive: true });
    fs.writeFileSync(restricted, '{"ciphertext":"this Vault security record must never be indexed"}', 'utf8');

    const router = ingestFactory({ isVercel: false, VAULT_ROOT: vaultRoot, DATA_ROOT: dataRoot });
    await router.runSecondBrainScan();

    const index = JSON.parse(fs.readFileSync(path.join(dataRoot, 'vault_index.json'), 'utf8'));
    expect(index.documents['blocks/briefing/decision.md']).toBeTruthy();
    expect(index.documents['transient.md']).toBeUndefined();
    expect(index.documents['blocks/security/credentials.json']).toBeUndefined();
  });

  it('rejects a v1.1 block that tries to index its local data', () => {
    const manifest = {
      manifestVersion: '1.1.0', id: 'bad_block', label: 'Bad', route: '/bad', version: '1.0.0',
      contract: {
        permissions: { filesystem: 'write', network: 'none' },
        storage: { type: 'json', scope: 'block', local: { indexed: true, retention: 'operational' }, access: 'scoped' },
        memory: { mode: 'none', indexed: false, userConfigurable: false },
      },
    };
    expect(validateManifest(manifest)).toContain('v1.1 requires contract.storage.local.indexed=false');
  });
});
