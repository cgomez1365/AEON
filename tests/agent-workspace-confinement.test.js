/**
 * An agent's working files (scratchpad, handoffs, artifacts) stay inside its
 * own folder in the Vault, and nothing it reads from them crosses the Local
 * only line.
 *
 * Found in the 3.3.0 security review (round 2): vault_read refused a link out
 * of the Vault, but the working files were opened with a plain path.join, so
 * a link named scratchpad.md, handoffs/ or artifacts/ carried a Local only
 * agent's memory or a file from outside the Vault into a Roulette agent's
 * system prompt (which can go to a cloud model), and artifact_save wrote
 * outside the Vault. Also: Memory Core's 503 handed the model this
 * computer's absolute path, and an agent whose agent.json cannot be read
 * (private, to vaultPrivacy) was served as Roulette.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const agents = require('../src/kernel/agents.cjs');
const ws = require('../src/kernel/agentWorkspace.cjs');
const agentTools = require('../src/kernel/agentTools.cjs');
const vaultPrivacy = require('../src/kernel/vaultPrivacy.cjs');
const createMemoryRouter = require('../src/blocks/memory_core/api/memory.cjs');

const noWin = it.skipIf(process.platform === 'win32');
let vault;
let outside;
const servers = [];
const listen = (app) => new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => { servers.push(s); resolve(`http://127.0.0.1:${s.address().port}`); });
});
const all = () => agents.list(vault, { withStats: false });
const get = (n) => agents.get(vault, n, all());
const toolbox = (name) => agentTools.createToolbox({ vaultRoot: vault, agent: get(name), agents: all(), contextTokens: 32768 });
const SECRET = 'QUILL-PRIVATE-7731';
const HOSTSECRET = 'HOST-FILE-OUTSIDE-VAULT-4410';

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-ws-conf-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-ws-conf-out-'));
  agents.create(vault, { name: 'Ledger', persona: 'Keeps the books.' });
  agents.create(vault, { name: 'Quill', persona: 'Drafts letters.', privacy: 'local-only', model: { provider: 'local', model: 'q4' } });
  const qmem = path.join(vault, 'Agents', 'Quill', 'memory');
  fs.mkdirSync(qmem, { recursive: true });
  fs.writeFileSync(path.join(qmem, 'memories.json'), JSON.stringify([{ id: 'q1', text: SECRET, active: true }]));
  fs.writeFileSync(path.join(outside, 'host.txt'), HOSTSECRET);
});
afterEach(() => {
  fs.rmSync(vault, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});
afterAll(() => { for (const s of servers) { try { s.close(); } catch {} } });

describe('working files reached through a link are never followed', () => {
  noWin('a scratchpad.md linked to a Local only agent\'s memory is not put in a Roulette agent\'s prompt', async () => {
    fs.symlinkSync(path.join(vault, 'Agents', 'Quill', 'memory', 'memories.json'), path.join(vault, 'Agents', 'Ledger', 'scratchpad.md'));
    const o = await toolbox('Ledger').run({ ok: true, tool: 'vault_read', args: { path: 'Agents/Ledger/scratchpad.md' } });
    expect(o.text).not.toContain(SECRET);
    const block = ws.promptBlock(vault, get('Ledger'));
    expect(block.text).not.toContain(SECRET);
    // Said, not silent: the heading names the refusal.
    expect(block.text).toMatch(/scratchpad\.md is a link/);
    expect(() => ws.readScratchpad(vault, get('Ledger'))).toThrow(/is a link/);
  });

  noWin('a scratchpad.md linked outside the Vault is not put in the prompt', () => {
    fs.symlinkSync(path.join(outside, 'host.txt'), path.join(vault, 'Agents', 'Ledger', 'scratchpad.md'));
    expect(ws.promptBlock(vault, get('Ledger')).text).not.toContain(HOSTSECRET);
  });

  noWin('a handoffs/ folder linked to a Local only agent\'s handoffs is not put in a Roulette prompt', () => {
    const qh = path.join(vault, 'Agents', 'Quill', 'handoffs');
    fs.mkdirSync(qh, { recursive: true });
    fs.writeFileSync(path.join(qh, '2026-10-03T10-00-00Z.md'), `---\ncreated: 2026-10-03T10:00:00Z\n---\n${SECRET}\n`);
    fs.symlinkSync(qh, path.join(vault, 'Agents', 'Ledger', 'handoffs'));
    const block = ws.promptBlock(vault, get('Ledger'));
    expect(block.text).not.toContain(SECRET);
    expect(block.handoffAt).toBeNull();
    expect(ws.listHandoffs.bind(null, vault, get('Ledger'))).toThrow(/is a link/);
  });

  noWin('one handoff file linked elsewhere is skipped, the real ones still count', () => {
    const own = path.join(vault, 'Agents', 'Ledger', 'handoffs');
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, '2026-10-01T10-00-00Z.md'), '---\ncreated: 2026-10-01T10:00:00Z\n---\nLEDGER-OWN-HANDOFF\n');
    fs.symlinkSync(path.join(outside, 'host.txt'), path.join(own, '2026-10-03T10-00-00Z.md'));
    const block = ws.promptBlock(vault, get('Ledger'));
    expect(block.text).not.toContain(HOSTSECRET);
    expect(block.text).toContain('LEDGER-OWN-HANDOFF');
  });

  noWin('artifact_save never writes outside the Vault through a linked artifacts/ folder', async () => {
    fs.symlinkSync(outside, path.join(vault, 'Agents', 'Ledger', 'artifacts'));
    const o = await toolbox('Ledger').run({ ok: true, tool: 'artifact_save', args: { name: 'Escape', content: 'written by a model' } });
    expect(fs.readdirSync(outside).filter((n) => n.endsWith('.md'))).toEqual([]);
    expect(o.status).not.toBe('ok');
    expect(o.text).not.toContain(outside);
  });

  noWin('an agent folder that is itself a link is not written through', async () => {
    const real = path.join(vault, 'Agents', 'Ledger');
    const moved = path.join(outside, 'LedgerReal');
    fs.renameSync(real, moved);
    fs.symlinkSync(moved, real);
    const o = await toolbox('Ledger').run({ ok: true, tool: 'scratchpad_write', args: { content: 'hello' } });
    expect(o.status).not.toBe('ok');
    expect(fs.existsSync(path.join(moved, 'scratchpad.md'))).toBe(false);
  });

  noWin('scratchpad_write append never copies a linked file from outside the Vault into the Vault', async () => {
    fs.symlinkSync(path.join(outside, 'host.txt'), path.join(vault, 'Agents', 'Ledger', 'scratchpad.md'));
    const o = await toolbox('Ledger').run({ ok: true, tool: 'scratchpad_write', args: { mode: 'append', content: 'x' } });
    expect(o.status).not.toBe('ok');
    const st = fs.lstatSync(path.join(vault, 'Agents', 'Ledger', 'scratchpad.md'));
    const now = st.isSymbolicLink() ? '' : fs.readFileSync(path.join(vault, 'Agents', 'Ledger', 'scratchpad.md'), 'utf8');
    expect(now).not.toContain(HOSTSECRET);
    expect(fs.readFileSync(path.join(outside, 'host.txt'), 'utf8')).toBe(HOSTSECRET);
  });

  it('ordinary working files still work (no link anywhere)', async () => {
    const tb = toolbox('Ledger');
    expect((await tb.run({ ok: true, tool: 'scratchpad_write', args: { content: 'plain note' } })).status).toBe('ok');
    expect((await tb.run({ ok: true, tool: 'artifact_save', args: { name: 'Plan', content: 'body' } })).status).toBe('ok');
    expect(ws.promptBlock(vault, get('Ledger')).text).toContain('plain note');
    expect(fs.existsSync(path.join(vault, 'Agents', 'Ledger', 'artifacts', 'plan.md'))).toBe(true);
  });
});

describe('errors a model reads carry no host path', () => {
  it('memory_save against an unreadable store does not hand the model this computer\'s absolute path', async () => {
    const memDir = path.join(vault, 'Agents', 'Ledger', 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'memories.json'), '{ not json');
    const app = express();
    app.use(express.json());
    app.use('/api', createMemoryRouter({ VAULT_ROOT: vault, TERMINAL_HISTORY_FILE: null }));
    const saved = process.env.AEON_KERNEL_URL;
    process.env.AEON_KERNEL_URL = await listen(app);
    try {
      const o = await toolbox('Ledger').run({ ok: true, tool: 'memory_save', args: { text: 'The operator likes tea' } });
      expect(o.status).toBe('error');
      expect(o.text).not.toContain(vault);
      expect(o.text).not.toContain(fs.realpathSync(vault));
      expect(o.text).not.toContain(os.tmpdir());
      expect(o.text).toMatch(/Agents\/Ledger\/memory\/memories\.json/);
    } finally {
      if (saved === undefined) delete process.env.AEON_KERNEL_URL; else process.env.AEON_KERNEL_URL = saved;
    }
  });
});

describe('an agent whose agent.json cannot be read is treated as Local only', () => {
  it('a chat with it is Local only, and its scratchpad never rides a cloud call', () => {
    fs.writeFileSync(path.join(vault, 'Agents', 'Quill', 'agent.json'), '{ broken');
    fs.writeFileSync(path.join(vault, 'Agents', 'Quill', 'scratchpad.md'), SECRET);
    const quill = get('Quill');
    expect(quill.error).toBeTruthy();
    expect(vaultPrivacy.withheld(vault, 'Agents/Quill/scratchpad.md')).toBe('local-only-agent');
    const opts = agents.callOptions(quill);
    expect(opts.localOnly).toBe(true);
    expect(opts.localOnlyReason).toMatch(/could not be read/);
    // Its own notes go only into a Local only call.
    expect(ws.promptBlock(vault, quill, { localOnly: false }).text).not.toContain(SECRET);
    expect(ws.promptBlock(vault, quill).text).toContain(SECRET);
  });

  it('a Roulette agent whose folder vaultPrivacy withholds gets no working files in a cloud call', () => {
    // agent.json says roulette in memory, but the disk now says Local only
    // (the operator switched it a moment ago): the disk wins.
    const ledger = get('Ledger');
    fs.writeFileSync(path.join(vault, 'Agents', 'Ledger', 'scratchpad.md'), 'LEDGER-NOTE');
    const rec = JSON.parse(fs.readFileSync(path.join(vault, 'Agents', 'Ledger', 'agent.json'), 'utf8'));
    fs.writeFileSync(path.join(vault, 'Agents', 'Ledger', 'agent.json'), JSON.stringify({ ...rec, privacy: 'local-only' }));
    const block = ws.promptBlock(vault, ledger);
    expect(block.text).not.toContain('LEDGER-NOTE');
    expect(block.text).toMatch(/Local only/);
  });
});
