import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const blockStandard = require('../src/kernel/blockStandard.cjs');

describe('installed block storage declarations', () => {
  it('gives every installed block an explicit unindexed local store and memory mode', () => {
    for (const folder of blockStandard.listBlockFolders()) {
      const manifest = blockStandard.normalizeManifest(folder);
      expect(manifest.manifestVersion).toBe('1.1.0');
      expect(manifest.contract.storage.local.indexed).toBe(false);
      expect(['operational', 'ephemeral']).toContain(manifest.contract.storage.local.retention);
      expect(['scoped', 'compatibility']).toContain(manifest.contract.storage.access);
      expect(['none', 'summary', 'document']).toContain(manifest.contract.memory.mode);
      expect(manifest.contract.memory.indexed).toBe(manifest.contract.memory.mode !== 'none');
    }
  });
});
