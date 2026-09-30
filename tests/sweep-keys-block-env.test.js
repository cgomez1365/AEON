/**
 * S00 — a pack's .env.block cannot turn a template placeholder into a key.
 *
 * mergeBlockEnv hand-parsed the file (inline comments kept, CRLF lines never
 * matched) and filled any central key that was '' — exactly how dotenv leaves
 * the template's `SERPER_API_KEY=   # optional …` placeholders. A pack whose
 * .env.block copied the template set the COMMENT as the key on every boot,
 * where the vault heal could not reach it. Store packs install and update
 * live, so this is one install away.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-sweep-blockenv-'));
process.env.AEON_HOME = path.join(tmp, 'home');
process.env.AEON_BLOCKS_DIR = path.join(tmp, 'blocks');
fs.mkdirSync(path.join(tmp, 'blocks', 'pack'), { recursive: true });

const { mergeBlockEnv } = require('../src/kernel/blockStandard.cjs');

const TOUCHED = ['SERPER_API_KEY', 'OPENROUTER_API_KEY', 'AEON_BIND', 'PACK_BASE_URL', 'PACK_DECLARED', 'PACK_EMPTY', 'PACK_CRLF'];
const saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  delete process.env.AEON_BLOCKS_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('mergeBlockEnv', () => {
  it('fills only block-own settings the process has never seen, as dotenv reads them', () => {
    for (const k of TOUCHED) delete process.env[k];
    process.env.SERPER_API_KEY = '';     // the central template placeholder, as dotenv loads it
    process.env.PACK_DECLARED = '';      // declared empty centrally: central wins
    fs.writeFileSync(path.join(tmp, 'blocks', 'pack', '.env.block'), [
      'SERPER_API_KEY=   # optional — get one at serper.dev',
      'OPENROUTER_API_KEY=sk-or-from-a-pack',
      'AEON_BIND=0.0.0.0',
      'PACK_BASE_URL=https://pack.example/v1   # the pack\'s own service',
      'PACK_DECLARED=from-pack',
      'PACK_EMPTY=   # nothing here',
      'PACK_CRLF="crlf-value"\r',
      '',
    ].join('\n'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const added = mergeBlockEnv('pack');

    expect(added.sort()).toEqual(['PACK_BASE_URL', 'PACK_CRLF']);
    expect(process.env.PACK_BASE_URL).toBe('https://pack.example/v1');
    expect(process.env.PACK_CRLF).toBe('crlf-value');
    expect(process.env.SERPER_API_KEY).toBe('');
    expect(process.env.PACK_DECLARED).toBe('');
    expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
    expect(process.env.AEON_BIND).toBeUndefined();
    expect(process.env.PACK_EMPTY).toBeUndefined();
    expect(warn.mock.calls.join(' ')).toMatch(/pack\/\.env\.block tried to set OPENROUTER_API_KEY, AEON_BIND/);
    expect(warn.mock.calls.join(' ')).not.toContain('sk-or-from-a-pack');
  });
});
