/**
 * 3.3.0 review round 5 — three privacy edges the final review found.
 *
 *  1. An agent's id can resolve to a different agent: a Local only agent
 *     renamed (its id and folder keep the old name) and a Roulette agent that
 *     then takes the old name. Both answer to "quill"; get() must not guess,
 *     and a name may not take another agent's id or folder.
 *  2. vaultPrivacy dropped a leading "Vault/" from every path, so a real
 *     top-level folder named Vault (an older Vault copied in) was judged as a
 *     different path and a Local only agent folder inside it was readable.
 *  3. A round after a tool result was retried trimmed on "too large"; the
 *     trim keeps the system head (it drops the ## TOOLS rules) and the last
 *     user message, which there is the wrapped tool result.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fakeStream, collector } from './helpers/fake-stream.js';

const require = createRequire(import.meta.url);
const agents = require('../src/kernel/agents.cjs');
const agentTools = require('../src/kernel/agentTools.cjs');
const vaultPrivacy = require('../src/kernel/vaultPrivacy.cjs');
const { runAgentTurn } = require('../src/kernel/agentTurn.cjs');

let vault;
beforeEach(() => { vault = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-privacy-r5-')); });
afterEach(() => { try { fs.rmSync(vault, { recursive: true, force: true }); } catch {} });

describe('an agent reference never resolves to the wrong agent', () => {
  it('refuses a name that is another agent\'s id or folder', () => {
    agents.create(vault, { name: 'Quill', privacy: 'local-only' });
    agents.update(vault, 'quill', { name: 'Ranger' });           // id and folder stay "quill"
    agents.create(vault, { name: 'Scout' });
    expect(() => agents.update(vault, 'scout', { name: 'Quill' })).toThrow(/already taken/);
    expect(() => agents.create(vault, { name: 'quill' })).toThrow(/already taken/);
    expect(agents.get(vault, 'quill').name).toBe('Ranger');
  });

  it('two agents that both answer to a word exactly: no guess', () => {
    agents.create(vault, { name: 'Quill', privacy: 'local-only' });
    agents.update(vault, 'quill', { name: 'Ranger' });
    // A collision made before this rule existed (or by hand in Aeon Matrix).
    fs.mkdirSync(path.join(vault, 'Agents', 'Scout', 'memory'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'Agents', 'Scout', 'agent.json'), JSON.stringify({ id: 'scout', name: 'Quill', privacy: 'roulette' }));
    expect(agents.get(vault, 'quill')).toBeNull();
    // Unambiguous references still resolve.
    expect(agents.get(vault, 'ranger').folder).toBe('Quill');
    expect(agents.get(vault, 'scout').folder).toBe('Scout');
  });
});

describe('a real folder named Vault is judged as itself', () => {
  const writeAgent = (rel, privacy) => {
    const dir = path.join(vault, ...rel.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({ name: 'Old Scout', privacy }));
    fs.writeFileSync(path.join(dir, 'notes.md'), 'PRIVATE-R5 notes');
  };

  it('a Local only agent folder inside Vault/ is withheld', () => {
    writeAgent('Vault/Archive/Scout', 'local-only');
    writeAgent('Vault/Agents/Scout', 'local-only');
    expect(vaultPrivacy.withheld(vault, 'Vault/Archive/Scout/notes.md')).toBe('local-only-agent');
    expect(vaultPrivacy.withheld(vault, 'Vault/Agents/Scout/notes.md')).toBe('local-only-agent');
  });

  it('vault_read refuses it like any Local only folder', async () => {
    writeAgent('Vault/Archive/Scout', 'local-only');
    const tb = agentTools.createToolbox({ vaultRoot: vault, contextTokens: 32768 });
    const r = await tb.run({ ok: true, tool: 'vault_read', args: { path: 'Vault/Archive/Scout/notes.md' } });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('PRIVATE-R5');
  });

  it('controls: a shared folder inside Vault/, and the "Vault/<rel>" naming, still work', () => {
    writeAgent('Vault/Archive/Helper', 'roulette');
    expect(vaultPrivacy.withheld(vault, 'Vault/Archive/Helper/notes.md')).toBeNull();
    writeAgent('Agents/Scout', 'local-only');
    expect(vaultPrivacy.withheld(vault, 'Vault/Agents/Scout/notes.md')).toBe('local-only-agent');
    fs.mkdirSync(path.join(vault, 'Notes'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'Notes', 'plan.md'), 'plan');
    expect(vaultPrivacy.withheld(vault, 'Vault/Notes/plan.md')).toBeNull();
    expect(vaultPrivacy.withheld(vault, 'Notes/plan.md')).toBeNull();
  });
});

describe('a round after a tool result is never retried trimmed', () => {
  const block = (obj) => `\`\`\`aeon-tool\n${JSON.stringify(obj)}\n\`\`\`\n`;
  const tooLarge = () => Object.assign(new Error('413 request too large'), { tooLarge: true });

  it('asks the kernel not to trim it, and ends with what was shown plus the reason', async () => {
    fs.mkdirSync(path.join(vault, 'Notes'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'Notes', 'plan.md'), 'Ship on Friday.');
    const tb = agentTools.createToolbox({ vaultRoot: vault, contextTokens: 32768 });
    const f = fakeStream([
      { tokens: ['Let me look. ', block({ tool: 'vault_read', path: 'Notes/plan.md' })] },
      { throw: tooLarge() },
    ]);
    const c = collector();
    const r = await runAgentTurn({ kernelLLM: { stream: f.stream }, messages: [{ role: 'user', content: 'q' }], toolbox: tb, emit: c.emit });
    expect(f.calls[0].opts.noTrimRetry).toBeUndefined();   // the first round may still be trimmed, as before
    expect(f.calls[1].opts.noTrimRetry).toBe(true);
    expect(c.of('notice').some((n) => n.code === 'tool-round-stopped')).toBe(true);
    expect(r.text).toContain('Let me look.');
    expect(r.truncationReason).toMatch(/too large for this model/);
  });

  it('control: any other failure after a tool result still surfaces as an error', async () => {
    fs.mkdirSync(path.join(vault, 'Notes'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'Notes', 'plan.md'), 'Ship on Friday.');
    const tb = agentTools.createToolbox({ vaultRoot: vault, contextTokens: 32768 });
    const f = fakeStream([
      { tokens: [block({ tool: 'vault_read', path: 'Notes/plan.md' })] },
      { throw: new Error('provider down') },
    ]);
    await expect(runAgentTurn({ kernelLLM: { stream: f.stream }, messages: [{ role: 'user', content: 'q' }], toolbox: tb, emit: () => {} }))
      .rejects.toThrow(/provider down/);
  });
});
