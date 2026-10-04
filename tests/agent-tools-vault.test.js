/**
 * The agent read tools and the Vault boundary (src/kernel/vaultPath.cjs,
 * src/kernel/agentTools.cjs vault_read / vault_list).
 *
 * A path a model writes is untrusted — a document it read can tell it to open
 * "../../.ssh/id_rsa". Every path is confined to the Vault before any file is
 * opened; what the operator withheld in Memory Core (a Local only agent's
 * folder, a switched-off memory) is never readable through a tool.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { resolveInVault } = require('../src/kernel/vaultPath.cjs');
const agentTools = require('../src/kernel/agentTools.cjs');
const agents = require('../src/kernel/agents.cjs');

let vault;
let outside;
const w = (rel, text) => { const f = path.join(vault, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
const call = (tool, args) => ({ ok: true, tool, args });

beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-tools-vault-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-tools-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE SECRET');
});
afterEach(() => {
  fs.rmSync(vault, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe('resolveInVault — refusals before any file is opened', () => {
  it('traversal, absolute, home, NUL, hidden, junk', () => {
    w('Notes/a.md', 'a');
    const code = (p, o) => resolveInVault(vault, p, o).code;
    expect(code('../x')).toBe('traversal');
    expect(code('Notes/../../etc')).toBe('traversal');
    expect(code('Notes/..')).toBe('traversal');
    expect(code('/etc/passwd')).toBe('absolute-path');
    expect(code('C:\\x')).toBe('absolute-path');
    expect(code('c:/x')).toBe('absolute-path');
    expect(code('\\\\host\\x')).toBe('absolute-path');
    expect(code('file:///etc/passwd')).toBe('absolute-path');
    expect(code('~/x')).toBe('absolute-path');
    expect(code('a\0b')).toBe('bad-path');
    expect(code('x'.repeat(600))).toBe('bad-path');
    expect(code(42)).toBe('bad-path');
    expect(code('')).toBe('bad-path');
    expect(code('.removed/x')).toBe('hidden');
    expect(code('Agents/.removed/Old/agent.json')).toBe('hidden');
    expect(code('Notes/.DS_Store')).toBe('hidden');
    expect(code('Notes/._a.md')).toBe('hidden');
    expect(code('Notes/Thumbs.db')).toBe('hidden');
    expect(code('Notes/missing.md')).toBe('not-found');
  });

  it('accepts Vault/ prefixes, backslashes and ./, and the root only when allowed', () => {
    w('Notes/a.md', 'a');
    expect(resolveInVault(vault, 'Vault/Notes/a.md')).toMatchObject({ ok: true, rel: 'Notes/a.md' });
    expect(resolveInVault(vault, 'Notes\\a.md')).toMatchObject({ ok: true, rel: 'Notes/a.md' });
    expect(resolveInVault(vault, './Notes/./a.md')).toMatchObject({ ok: true, rel: 'Notes/a.md' });
    expect(resolveInVault(vault, '', { allowRoot: true })).toMatchObject({ ok: true, rel: '' });
  });

  it.skipIf(process.platform === 'win32')('a symlink inside the Vault that leads out is refused (file and folder)', () => {
    fs.mkdirSync(path.join(vault, 'Notes'), { recursive: true });
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(vault, 'Notes', 'link.txt'));
    fs.symlinkSync(outside, path.join(vault, 'Linked'));
    expect(resolveInVault(vault, 'Notes/link.txt').code).toBe('outside-vault');
    expect(resolveInVault(vault, 'Linked/secret.txt').code).toBe('outside-vault');
    expect(resolveInVault(vault, 'Linked', { allowRoot: true }).code).toBe('outside-vault');
  });
});

describe('vault_read', () => {
  const box = (opts = {}) => agentTools.createToolbox({ vaultRoot: vault, contextTokens: 32768, ...opts });

  it('reads a real PDF (jspdf), Markdown, and refuses a binary', async () => {
    const { jsPDF } = require('jspdf');
    const doc = new jsPDF();
    doc.text('Quarterly totals reconcile to the bank statement', 20, 30);
    fs.mkdirSync(path.join(vault, 'Docs'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'Docs', 'q3.pdf'), Buffer.from(doc.output('arraybuffer')));
    w('Notes/plan.md', '# Plan\nShip the scratchpad.');
    fs.writeFileSync(path.join(vault, 'Docs', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));

    const tb = box();
    const pdf = await tb.run(call('vault_read', { path: 'Docs/q3.pdf' }));
    expect(pdf).toMatchObject({ ok: true, status: 'ok', tool: 'vault_read' });
    expect(pdf.text).toMatch(/Quarterly totals reconcile to the bank statement/);
    expect(pdf.text.startsWith('Docs/q3.pdf — characters 0–')).toBe(true);
    const md = await tb.run(call('vault_read', { path: 'Notes/plan.md' }));
    expect(md.text).toContain('Ship the scratchpad.');
    const bin = await tb.run(call('vault_read', { path: 'Docs/logo.png' }));
    expect(bin).toMatchObject({ ok: false, status: 'error', code: 'unreadable-format' });
    const dir = await tb.run(call('vault_read', { path: 'Docs' }));
    expect(dir).toMatchObject({ ok: false, code: 'bad-path' });
  });

  it('long files come in parts: offset pages on, and the model is told how', async () => {
    const body = Array.from({ length: 2000 }, (_, i) => `line ${i} of the long ledger`).join('\n');
    w('Notes/long.md', body);
    const tb = box();
    const first = await tb.run(call('vault_read', { path: 'Notes/long.md' }));
    expect(first.ok).toBe(true);
    expect(first.truncated).toBe(true);
    expect(first.text.length).toBeLessThanOrEqual(agentTools.LIMITS.RESULT_MAX_CHARS.vault_read);
    const next = Number(/"offset": (\d+)/.exec(first.text)[1]);
    expect(next).toBeGreaterThan(1000);
    const second = await tb.run(call('vault_read', { path: 'Notes/long.md', offset: next }));
    expect(second.text).toContain(`characters ${next.toLocaleString('en-US')}–`);
    expect(second.text).toContain(body.slice(next, next + 40));
  });

  it('refuses a file over the size cap without reading it', async () => {
    const f = w('Docs/huge.txt', '');
    fs.truncateSync(f, agentTools.LIMITS.READ_MAX_BYTES + 1);
    const r = await box().run(call('vault_read', { path: 'Docs/huge.txt' }));
    expect(r).toMatchObject({ ok: false, status: 'refused', code: 'too-large' });
  });

  it.skipIf(process.platform === 'win32')('a symlink out of the Vault is refused, and the outside file never appears', async () => {
    fs.symlinkSync(outside, path.join(vault, 'Linked'));
    const r = await box().run(call('vault_read', { path: 'Linked/secret.txt' }));
    expect(r).toMatchObject({ ok: false, status: 'refused', code: 'outside-vault' });
    expect(r.text).not.toContain('OUTSIDE SECRET');
    expect(r.preview).not.toContain('OUTSIDE SECRET');
  });

  it('saved chats are never readable through a tool', async () => {
    w('Agents/Aeon/chat_sessions/2026-10-01.json', '{"messages":[{"role":"user","content":"private chat"}]}');
    const r = await box().run(call('vault_read', { path: 'Agents/Aeon/chat_sessions/2026-10-01.json' }));
    expect(r).toMatchObject({ ok: false, status: 'refused', code: 'hidden' });
    expect(r.text).not.toContain('private chat');
  });
});

describe('vault_list', () => {
  it('hides OS junk and hidden names, folders first, sizes on files', async () => {
    w('Notes/a.md', 'aaa');
    w('Notes/.DS_Store', 'x');
    w('Notes/._a.md', 'x');
    w('Notes/.obsidian/config', 'x');
    w('Notes/Sub/b.md', 'b');
    const r = await agentTools.createToolbox({ vaultRoot: vault }).run(call('vault_list', { path: 'Notes' }));
    expect(r.ok).toBe(true);
    expect(r.text).toBe('Notes:\nSub/\na.md (3 B)');
    const top = await agentTools.createToolbox({ vaultRoot: vault }).run(call('vault_list', {}));
    expect(top.text).toContain('Notes/');
  });
});

describe('withheld documents are not readable through tools', () => {
  beforeEach(() => {
    agents.create(vault, { name: 'Ledger', persona: 'Keeps the books.' });
    agents.create(vault, { name: 'Quill', persona: 'Drafts private letters.', privacy: 'local-only' });
    // Ledger: one memory on, one switched Off (with its .md mirror).
    w('Agents/Ledger/memory/memories.json', JSON.stringify([
      { id: 'on1', text: 'The operator closes the books on the 5th', timestamp: 1 },
      { id: 'off1', text: 'A switched-off note about payroll', active: false, timestamp: 2 },
    ]));
    w('Agents/Ledger/memory/off1.md', '---\nid: off1\nactive: false\n---\n\nA switched-off note about payroll\n');
    w('Agents/Ledger/memory/on1.md', '---\nid: on1\n---\n\nThe operator closes the books on the 5th\n');
    // Quill (Local only): its own memory with one Off, and a scratchpad.
    w('Agents/Quill/memory/memories.json', JSON.stringify([
      { id: 'q1', text: 'Quill drafts in a formal tone', timestamp: 1 },
      { id: 'q2', text: 'A switched-off Quill memory', active: false, timestamp: 2 },
    ]));
    w('Agents/Quill/memory/q2.md', '---\nid: q2\nactive: false\n---\n\nA switched-off Quill memory\n');
    w('Agents/Quill/scratchpad.md', 'Quill private scratchpad line');
  });
  const as = (name) => {
    const all = agents.list(vault, { withStats: false });
    return agentTools.createToolbox({ vaultRoot: vault, agent: agents.get(vault, name, all), agents: all, contextTokens: 32768 });
  };

  it('memory files are never read or listed through tools, Off or on (review round 4)', async () => {
    const tb = as('aeon');
    // One answer for every file in a memory folder, so none tells a model
    // that a switched-off memory exists.
    for (const f of ['off1.md', 'on1.md', 'memories.json']) {
      const r = await tb.run(call('vault_read', { path: `Agents/Ledger/memory/${f}` }));
      expect(r).toMatchObject({ ok: false, status: 'refused', code: 'hidden' });
      expect(r.text).not.toMatch(/switched.off/i);
    }
    expect(await tb.run(call('vault_list', { path: 'Agents/Ledger/memory' }))).toMatchObject({ ok: false, status: 'refused', code: 'hidden' });
    expect((await tb.run(call('vault_list', { path: 'Agents/Ledger' }))).text).not.toMatch(/memory/);
  });

  it('a Roulette caller cannot read a Local only agent\'s folder, nor see it exists', async () => {
    const tb = as('Ledger');
    const r = await tb.run(call('vault_read', { path: 'Agents/Quill/scratchpad.md' }));
    // The terminal sees the real reason (code); the model reads exactly what
    // a missing path gives it (status and text), so it learns nothing.
    expect(r).toMatchObject({ ok: false, status: 'error', code: 'local-only-agent' });
    expect(r.text).not.toContain('private scratchpad');
    const missing = await tb.run(call('vault_read', { path: 'Agents/Nobody/scratchpad.md' }));
    expect(missing.status).toBe(r.status);
    expect(r.text).toBe(missing.text.replace('Agents/Nobody/', 'Agents/Quill/'));
    // Mis-cased, as macOS and exFAT would open it.
    expect((await tb.run(call('vault_read', { path: 'agents/quill/scratchpad.md' }))).code).toBe('local-only-agent');
    const list = await tb.run(call('vault_list', { path: 'Agents' }));
    expect(list.ok).toBe(true);
    expect(list.text).toContain('Ledger/');
    expect(list.text).not.toContain('Quill');
    expect((await tb.run(call('vault_list', { path: 'Agents/Quill' }))).code).toBe('local-only-agent');
  });

  it('a Local only caller reads its own scratchpad, but not its own memory files', async () => {
    const tb = as('Quill');
    const pad = await tb.run(call('vault_read', { path: 'Agents/Quill/scratchpad.md' }));
    expect(pad.ok).toBe(true);
    expect(pad.text).toContain('Quill private scratchpad line');
    expect(await tb.run(call('vault_read', { path: 'Agents/Quill/memory/q2.md' }))).toMatchObject({ ok: false, code: 'hidden' });
    expect(await tb.run(call('vault_read', { path: 'Agents/Quill/memory/memories.json' }))).toMatchObject({ ok: false, code: 'hidden' });
  });
});
