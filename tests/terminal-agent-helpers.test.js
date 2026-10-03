/**
 * The terminal's agent: /agent <name>, a wake that names an agent, and a
 * click in Recent Agent Missions all hand the terminal an agent (2026-10-02).
 * The logic is pure (src/utils/terminalAgent.js); the wiring in the
 * components is pinned with comment-stripped source checks — there is no DOM
 * environment in this suite.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { readStoredAgent, storeAgent, asCurrent, resolveAgentArg, describeAgent, AGENT_KEY, AGENT_SELECT_EVENT } from '../src/utils/terminalAgent.js';

const mem = () => { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; }, _m: m }; };
const AGENTS = [
  { id: 'aeon', name: 'Jarvis', folder: 'Aeon', self: true },
  { id: 'card_scout', name: 'Card Scout', folder: 'Card_Scout', privacy: 'local-only', model: { provider: 'local', model: 'phi4-mini-q4' } },
  { id: 'card_ledger', name: 'Card Ledger', folder: 'Card_Ledger' },
  { id: 'orion', name: 'Orion', folder: 'Orion', sharedMemory: false },
];

describe('terminalAgent helpers', () => {
  it('remembers the current agent per browser, and forgets it on the way back', () => {
    const s = mem();
    expect(readStoredAgent(s)).toBeNull();
    storeAgent(s, { id: 'orion', name: 'Orion', extra: 'dropped' });
    expect(JSON.parse(s._m[AGENT_KEY])).toEqual({ id: 'orion', name: 'Orion' });
    expect(readStoredAgent(s)).toEqual({ id: 'orion', name: 'Orion' });
    storeAgent(s, null);
    expect(readStoredAgent(s)).toBeNull();
    s.setItem(AGENT_KEY, '{broken');
    expect(readStoredAgent(s)).toBeNull();
    expect(readStoredAgent(null)).toBeNull();
  });

  it('the operator\'s own AEON is "no agent" to the terminal', () => {
    expect(asCurrent(AGENTS[0])).toBeNull();
    expect(asCurrent(AGENTS[3])).toEqual({ id: 'orion', name: 'Orion' });
  });

  it('/agent <arg>: id, name, one word; off / aeon / your AEON\'s name go back', () => {
    expect(resolveAgentArg('orion', AGENTS).agent.id).toBe('orion');
    expect(resolveAgentArg('Card Scout', AGENTS).agent.id).toBe('card_scout');
    expect(resolveAgentArg('scout', AGENTS).agent.id).toBe('card_scout');
    for (const back of ['off', 'aeon', 'self', 'jarvis']) expect(resolveAgentArg(back, AGENTS).back).toBe(true);
    expect(resolveAgentArg('card', AGENTS).error).toMatch(/could be Card Scout or Card Ledger/);
    expect(resolveAgentArg('ghost', AGENTS).error).toMatch(/No agent called "ghost"/);
    expect(resolveAgentArg('', AGENTS).error).toMatch(/Name an agent/);
  });

  it('describes an agent in words: model, privacy, memory', () => {
    expect(describeAgent(AGENTS[1])).toBe('Card Scout — local · phi4-mini-q4, local only (its chats and its own memory never go to a cloud model); its own memory plus the shared memory.');
    expect(describeAgent(AGENTS[3])).toBe('Orion — the model Settings picks; its own memory only.');
    // The operator's own AEON holds the shared memory, which Roulette agents
    // may still read — so Local only promises its chats, not its memory.
    expect(describeAgent({ ...AGENTS[0], privacy: 'local-only' })).toMatch(/local only \(its chats never go to a cloud model\)/);
  });
});

describe('wiring', () => {
  const src = (p) => fs.readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const term = src('../src/components/Terminal2.jsx');

  it('the terminal handles /agent itself and sends the agent with chat, saves, distils and the close beacon', () => {
    expect(term).toMatch(/cmdToken === '\/agent'/);
    expect(term).toMatch(/fetch\('\/api\/agents'/);
    expect(term).toMatch(/role: 'chat', \.\.\.agentBody\(\)/);
    expect(term).toMatch(/autoSaved, \.\.\.agentBody\(\)/);
    expect(term).toMatch(/messages: liveTurns\(feedRef\.current \|\| \[\]\), \.\.\.agentBody\(\)/);
    expect(term).toMatch(/agent: agentRef\.current\?\.id \|\| null/);
  });

  it('the terminal follows the server when a wake hands the turn to an agent', () => {
    expect(term).toMatch(/if \(payload\.agent\)/);
    expect(term).toMatch(/setAgent\(payload\.agent\)/);
  });

  it('Recent Agent Missions and Memory Core hand the terminal an agent by event', () => {
    expect(AGENT_SELECT_EVENT).toBe('aeon:agent-select');
    expect(term).toMatch(/addEventListener\(AGENT_SELECT_EVENT/);
    const fleet = src('../src/blocks/fleet_control/index.jsx');
    expect(fleet).toMatch(/RECENT AGENT MISSIONS/);
    expect(fleet).not.toMatch(/VP MISSIONS/);
    expect(fleet).toMatch(/new CustomEvent\(AGENT_SELECT_EVENT/);
    expect(fleet).toMatch(/fetch\('\/api\/agents'/);
    expect(src('../src/blocks/memory_core/index.jsx')).toMatch(/new CustomEvent\(AGENT_SELECT_EVENT/);
  });
});
