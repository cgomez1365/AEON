/**
 * 3.3.0 review round 5 — three privacy edges the final review found.
 *
 *  1. An agent's id can resolve to a different agent: a Local only agent
 *     renamed (its id and folder keep the old name) and a Roulette agent that
 *     then takes the old name. Both answer to "quill". An id or folder wins
 *     over a name (stored references are ids, and callers read "no agent" as
 *     your own AEON, so a clash must resolve, never come back null); a name,
 *     or the folder a new name gets, may not be another agent's name, id or
 *     folder.
 *  2. vaultPrivacy dropped a leading "Vault/" from every path, so a real
 *     top-level folder named Vault (an older Vault copied in) was judged as a
 *     different path and a Local only agent folder inside it was readable.
 *  3. A round after a tool result was retried trimmed on "too large"; the
 *     trim keeps the system head (it drops the ## TOOLS rules) and the last
 *     user message, which there is the wrapped tool result. (It still falls
 *     back to the next provider: tests/tool-round-fallback-r5.test.js.)
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
const ingestMod = require('../src/blocks/aeon_matrix/api/ingest.cjs');
const { resolveAgentArg } = await import('../src/utils/terminalAgent.js');

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

  it('a clash made before this rule (or by hand): the id wins, in the kernel and the terminal', () => {
    agents.create(vault, { name: 'Quill', privacy: 'local-only' });
    agents.update(vault, 'quill', { name: 'Ranger' });
    fs.mkdirSync(path.join(vault, 'Agents', 'Scout', 'memory'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'Agents', 'Scout', 'agent.json'), JSON.stringify({ id: 'scout', name: 'Quill', privacy: 'roulette' }));
    // "quill" is the Local only agent's id: it reaches that agent, never the
    // Roulette one, and never "no agent" (which callers read as your own AEON).
    const got = agents.get(vault, 'quill');
    expect(got.folder).toBe('Quill');
    expect(got.privacy).toBe('local-only');
    expect(resolveAgentArg('quill', agents.list(vault, { withStats: false })).agent.id).toBe('quill');
    expect(agents.get(vault, 'ranger').folder).toBe('Quill');
    expect(agents.get(vault, 'scout').folder).toBe('Scout');
  });

  it('refuses a new agent whose folder would be another agent\'s name', () => {
    agents.create(vault, { name: 'Rover' });
    agents.update(vault, 'rover', { name: 'Jose' });
    expect(() => agents.create(vault, { name: 'José', privacy: 'local-only' })).toThrow(/already taken/);
    expect(() => agents.create(vault, { name: 'Jose.' })).toThrow(/already taken/);
    expect(agents.get(vault, 'jose').folder).toBe('Rover');
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

  it('the Vault scan never indexes or embeds it (the path that leaked)', async () => {
    writeAgent('Vault/Archive/Scout', 'local-only');
    writeAgent('Vault/Archive/Helper', 'roulette');
    fs.writeFileSync(path.join(vault, 'Vault', 'Archive', 'Helper', 'notes.md'), 'Shared helper notes: the bike shop opens at nine on weekdays.');
    ingestMod._resetStores();
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-privacy-r5-data-'));
    const embedded = [];
    const embed = async (text) => { embedded.push(String(text)); return { vector: [1, 0, 0], model: 'stub' }; };
    await ingestMod({ isVercel: false, VAULT_ROOT: vault, DATA_ROOT: data, embed }).runSecondBrainScan();
    const indexed = Object.keys(JSON.parse(fs.readFileSync(path.join(data, 'vault_index.json'), 'utf8')).documents);
    expect(embedded.join('\n')).not.toContain('PRIVATE-R5');
    expect(indexed.some((p) => p.includes('Archive/Scout'))).toBe(false);
    expect(indexed.some((p) => p.includes('Archive/Helper/notes.md'))).toBe(true);   // control
    fs.rmSync(data, { recursive: true, force: true });
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
    expect(f.calls[1].opts.continuation).toBeUndefined();  // not a continuation: it still falls back
    expect(c.of('notice').some((n) => n.code === 'tool-round-stopped')).toBe(true);
    expect(r.text).toContain('Let me look.');
    expect(r.truncationReason).toMatch(/too large for this model/);
  });

  it('with nothing shown before the tool, it is an error, not an empty answer', async () => {
    fs.mkdirSync(path.join(vault, 'Notes'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'Notes', 'plan.md'), 'Ship on Friday.');
    const tb = agentTools.createToolbox({ vaultRoot: vault, contextTokens: 32768 });
    const f = fakeStream([{ tokens: [block({ tool: 'vault_read', path: 'Notes/plan.md' })] }, { throw: tooLarge() }]);
    await expect(runAgentTurn({ kernelLLM: { stream: f.stream }, messages: [{ role: 'user', content: 'q' }], toolbox: tb, emit: () => {} }))
      .rejects.toThrow(/too large/);
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
