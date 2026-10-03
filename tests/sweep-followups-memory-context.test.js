/**
 * Unreadable is not empty, in the kernel too (sweep C12, the half outside
 * memory_core).
 *
 * memory_core's own routes answer 503 for a damaged memories.json. The chat
 * path does not use them: chat-stream calls the kernel's buildMemoryContext,
 * whose reader ended in `catch { return []; }`. A store cut short by an unplug
 * or left with a trailing comma by a hand edit injected 0 memories into every
 * turn, the turn's meta said "🧠 0", and /core/state reported 0 memories, with
 * nothing logged anywhere. Only a missing file is an empty store now; anything
 * else is reported as an error, never as 0.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const kernelContext = require('../src/kernel/context.cjs');
const createCoreRouter = require('../src/kernel/routers/core.cjs');

let vault, memFile;
beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-sweep-memctx-'));
  memFile = path.join(vault, 'Agents', 'Aeon', 'memory', 'memories.json');
  fs.mkdirSync(path.dirname(memFile), { recursive: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(vault, { recursive: true, force: true }); });

const MEM = [{ id: 'm1', text: 'The operator invoices on net 15 terms.', category: 'fact', pinned: true, timestamp: 1 }];

describe('the chat path\'s memory reader', () => {
  it('a damaged store is an error with the file named, not zero memories', () => {
    fs.writeFileSync(memFile, JSON.stringify(MEM).slice(0, -3)); // cut short
    const out = kernelContext.buildMemoryContext('what are my terms?', { vaultRoot: vault });
    expect(out.count).toBe(0);
    expect(out.memoryError).toMatch(/memory store .*memories\.json is unreadable/);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/^\[MEMORY\] .*unreadable/));
  });

  it('a missing store is simply empty, and a readable one loads', () => {
    expect(kernelContext.buildMemoryContext('hi', { vaultRoot: vault }).memoryError).toBeNull();
    fs.writeFileSync(memFile, JSON.stringify(MEM));
    const out = kernelContext.buildMemoryContext('what are my terms?', { vaultRoot: vault });
    expect(out.memoryError).toBeNull();
    expect(out.count).toBe(1);
  });

  it('the streaming chat reports it with the turn', () => {
    const src = fs.readFileSync(path.join(path.dirname(require.resolve('../src/kernel/context.cjs')), '..', 'blocks', 'dashboard', 'api', 'chat-stream.cjs'), 'utf8');
    expect(src).toMatch(/memoryError: mem\.memoryError \|\| null/);
  });
});

describe('/core/state', () => {
  async function state() {
    const app = express();
    app.use('/core', createCoreRouter({
      _blockRegistry: [], _blockReadiness: {}, _loadSettings: () => ({}), _llmTelemetry: { totalCalls: 0, totalTokens: 0 },
      getDailyCost: () => 0, isVercel: false, fs, path, _skippedRoutes: [], VAULT_ROOT: vault,
    }));
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    try { return await (await fetch(`http://127.0.0.1:${server.address().port}/core/state`)).json(); }
    finally { server.close(); }
  }

  it('a damaged store reports the error and no count', async () => {
    fs.writeFileSync(memFile, '[{"id":"m1",}]');
    const s = await state();
    expect(s.memory.count).toBeNull();
    expect(s.memory.error).toMatch(/unreadable/);
  });

  it('a readable store reports its count', async () => {
    fs.writeFileSync(memFile, JSON.stringify(MEM));
    expect((await state()).memory).toEqual({ count: 1 });
  });
});

describe('Memory Core\'s screen', () => {
  // A reload that fails (the store turned unreadable after an Edit Mode save)
  // kept the list the earlier load showed, with edit, pin and delete on it,
  // under the "not loaded" alert.
  it('drops the list it showed when a reload fails', () => {
    const src = fs.readFileSync(path.join(path.dirname(require.resolve('../src/kernel/context.cjs')), '..', 'blocks', 'memory_core', 'index.jsx'), 'utf8')
      .replace(/^\s*\/\/.*$/gm, '');
    // The load now follows the selected agent tab ([scoped]) and also drops
    // the token summary — still everything it showed (2026-10-02).
    const load = src.slice(src.indexOf('const load = useCallback('), src.indexOf('}, [', src.indexOf('const load = useCallback(')));
    expect(load).toMatch(/const failed = \(why\) => \{ setMemories\(\[\]\);[^}]*setLoadError\(why\); \};/);
    expect(load).not.toMatch(/setLoadError\((d\.error|`the memory store did not load: )/);
  });
});
