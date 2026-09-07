/**
 * /model-pull on a catalogue model installs through AEON's own installer.
 *
 * Found by the CEO: `/model-pull qwen3-1.7b-q8` resolved the id and then 503'd
 * for want of huggingface-cli or Python — tools the local installer (the same
 * path as the Cookbook "Local models" button, SHA-256 verified) never needed.
 * Only a raw org/repo should go through Hugging Face tooling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const createCookbookRouter = require('../src/blocks/cookbook/api/index.cjs');

let root, servers, installers, registry;
const listen = (router) => new Promise((resolve) => {
  const a = express(); a.use(express.json()); a.use('/api', router);
  const server = a.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
});
const post = async (port, route, body) => {
  const r = await fetch(`http://127.0.0.1:${port}/api${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-pull-'));
  servers = [];
  installers = {
    runtime: { installRuntime: vi.fn(async () => ({ runtimeId: 'llamacpp-stub' })) },
    model: { installModel: vi.fn(async () => ({ ok: true })), listCatalog: () => [] },
  };
  registry = { file: path.join(root, 'data', 'local-runtime', 'local-runtime.json'), activeRuntime: () => null, readyModels: () => [], modelsForCapability: () => [] };
});
afterEach(() => { for (const s of servers) { try { s.close(); } catch {} } try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

async function mount() {
  const router = createCookbookRouter({
    isVercel: false, VAULT_ROOT: root, DATA_ROOT: path.join(root, 'data'), getDataFile: (n) => path.join(root, 'data', n),
    getLocalRuntimeRegistry: () => registry, localInstallers: installers, writeOSAudit: () => {},
  });
  const h = await listen(router); servers.push(h.server); return h.port;
}

describe('/model-pull with a catalogue id', () => {
  it('starts the local installer and never reaches for Hugging Face tooling', async () => {
    const port = await mount();
    const r = await post(port, '/model/download', { repo_id: 'nomic-embed-text-q8' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.session_id).toMatch(/^local-install-/);
    expect(r.body.model).toBe('nomic-embed-text-q8');
    expect(r.body.text).toMatch(/Downloading Nomic Embed/);
    expect(r.body.text).toMatch(/MB/);                                   // 146 MB, not "0.15 GB"
    await new Promise(res => setTimeout(res, 20));
    expect(installers.model.installModel).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'nomic-embed-text-q8' }));
  });

  it('installs the engine first when none is present, and says so', async () => {
    const port = await mount();
    const r = await post(port, '/model/download', { repo_id: 'qwen3-1.7b-q8' });
    expect(r.body.needsRuntime).toBe(true);
    expect(r.body.text).toMatch(/installing the local AI engine first/);
    await new Promise(res => setTimeout(res, 20));
    expect(installers.runtime.installRuntime).toHaveBeenCalledOnce();
    expect(installers.model.installModel).toHaveBeenCalledOnce();
  });

  it('skips the engine when one is already installed', async () => {
    registry.activeRuntime = () => ({ id: 'llamacpp-b10216' });
    const port = await mount();
    const r = await post(port, '/model/download', { repo_id: 'qwen3-1.7b-q8' });
    expect(r.body.needsRuntime).toBe(false);
    await new Promise(res => setTimeout(res, 20));
    expect(installers.runtime.installRuntime).not.toHaveBeenCalled();
  });

  it('accepts the display name shown in Cookbook too', async () => {
    const port = await mount();
    const r = await post(port, '/model/download', { repo_id: 'Nomic Embed Text v1.5 (Q8_0)' });
    expect(r.status).toBe(200);
    expect(r.body.model).toBe('nomic-embed-text-q8');
  });

  it('still names the remedy when nothing in the catalogue matches', async () => {
    const port = await mount();
    const r = await post(port, '/model/download', { repo_id: 'not a model at all' });
    expect(r.status).toBe(400);
    expect(r.body.accepts).toBeTruthy();
  });
});
