/**
 * memory_core from the terminal — what an operator sees after /remember, and
 * whether the memory can be found again.
 *
 * Audit 2026-09-23, on an isolated home with a stub model:
 *   - /remember answered {ok, memory:{…}, normalized} with no `text`, so the
 *     chip printed the record as a JSON block. Saying the same thing twice
 *     returned the SAME shape with `deduped:true` — nothing new was saved and
 *     nothing said so. "my preferred invoice terms…" was stored as "The
 *     operator's preferred invoice terms…" and the operator was never told.
 *   - A memory saved at 08:40 was not found by /recall until the next Vault
 *     scan (boot, nightly, or a manual /index-brain): the store writes a
 *     Vault file and never asked for it to be indexed. vaultSync — the other
 *     kernel writer into the Vault — does ask.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createRequire } from 'module';

process.env.AEON_SECRETS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-memory-cmds-secrets-'));

const require = createRequire(import.meta.url);
const memoryFactory = require('../src/blocks/memory_core/api/memory.cjs');
const commandRegistryFactory = require('../src/kernel/commandRegistry.cjs');
const { describeCommandOutput, describeDispatchOutcome, CHIP_STATUS } = await import('../src/utils/commandOutcome.js');

let root, servers, savedPort, base, requestIndex;
const listen = (app) => new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
});

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-memory-cmds-'));
  servers = [];
  requestIndex = vi.fn();
  const app = express();
  app.use(express.json());
  app.use('/api', memoryFactory({ VAULT_ROOT: path.join(root, 'Vault'), kernelLLM: null, requestIndex }));
  app.use('/api', commandRegistryFactory({ blockReadiness: {}, isVercel: false }).router);
  const h = await listen(app);
  servers.push(h.server);
  savedPort = process.env.PORT;
  process.env.PORT = String(h.port);
  base = `http://127.0.0.1:${h.port}/api`;
});

afterEach(() => {
  for (const s of servers) { try { s.close(); } catch {} }
  if (savedPort === undefined) delete process.env.PORT; else process.env.PORT = savedPort;
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

async function dispatch(cmd, arg = '') {
  const r = await fetch(`${base}/commands/dispatch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd, arg }),
  });
  const body = await r.json();
  return { status: r.status, body, chip: describeCommandOutput(body), outcome: describeDispatchOutcome({ status: r.status, data: body }) };
}

describe('/remember says what it saved', () => {
  it('a sentence, not the record as JSON', async () => {
    const r = await dispatch('/remember', 'Northwind pilot with the dispatch team is on 2026-10-06');
    expect(r.outcome.chipStatus).toBe(CHIP_STATUS.OK);
    expect(r.chip).not.toMatch(/```json/);
    expect(r.chip).toMatch(/Saved to memory/);
    expect(r.chip).toMatch(/Northwind pilot with the dispatch team is on 2026-10-06/);
  });

  it('saying it again saves nothing, and says so', async () => {
    await dispatch('/remember', 'Northwind pilot with the dispatch team is on 2026-10-06');
    const r = await dispatch('/remember', 'Northwind pilot with the dispatch team is on 2026-10-06');
    expect(r.body.data.deduped).toBe(true);
    expect(r.chip).toMatch(/Already in memory/);
    expect(r.chip).not.toMatch(/Saved to memory/);
  });

  it('a first-person fact is reworded, and the chip shows what was stored', async () => {
    const r = await dispatch('/remember', 'my preferred invoice terms are net 15');
    expect(r.chip).toMatch(/The operator's preferred invoice terms are net 15/);
    expect(r.chip).toMatch(/reworded/i);
  });
});

describe('a saved memory can be recalled without waiting for the next scan', () => {
  it('add, edit and delete each ask the kernel to index the Vault', async () => {
    const add = await (await fetch(`${base}/memory/add`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Diesel averaged $3.91 in Q3' }),
    })).json();
    expect(requestIndex).toHaveBeenCalledTimes(1);
    expect(requestIndex.mock.calls[0][0]).toMatchObject({ blockId: 'memory_core' });

    await fetch(`${base}/memory/${add.memory.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Diesel averaged $3.93 in Q3' }),
    });
    await fetch(`${base}/memory/${add.memory.id}`, { method: 'DELETE' });
    expect(requestIndex).toHaveBeenCalledTimes(3);
  });

  it('a duplicate writes nothing, so it asks for nothing', async () => {
    const body = JSON.stringify({ text: 'Diesel averaged $3.91 in Q3' });
    const post = () => fetch(`${base}/memory/add`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    await post(); await post();
    expect(requestIndex).toHaveBeenCalledTimes(1);
  });
});
