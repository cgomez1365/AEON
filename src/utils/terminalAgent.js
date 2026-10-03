// Which agent the terminal is talking to — pure helpers (injected storage),
// so the logic is testable without a DOM. The agents themselves live in the
// Vault (src/kernel/agents.cjs); the terminal only remembers which one is
// current, per browser, so a reload keeps the conversation partner.

export const AGENT_KEY = 'aeon_terminal_agent';
// Fired by anything that wants to hand the terminal an agent — Recent Agent
// Missions, Memory Core. detail: { id, name }.
export const AGENT_SELECT_EVENT = 'aeon:agent-select';
const BACK = new Set(['off', 'aeon', 'self', 'vp', 'none', 'exit']);

// The operator's own AEON's agent id (agents.cjs SELF_ID).
export const SELF_AGENT_ID = 'aeon';

/**
 * The agent a feed turn was with, for its `agent` tag: the current agent, or
 * the operator's own AEON. A turn tagged with an agent set to Local only is
 * left out of what goes to another agent's model (agents.cjs shareableTurns).
 */
export function turnAgentId(current) {
  return current && typeof current.id === 'string' ? current.id : SELF_AGENT_ID;
}

/** The stored agent ({ id, name }), or null for the operator's own AEON. */
export function readStoredAgent(storage) {
  try {
    const raw = storage && storage.getItem(AGENT_KEY);
    const a = raw ? JSON.parse(raw) : null;
    return a && typeof a.id === 'string' && typeof a.name === 'string' ? { id: a.id, name: a.name } : null;
  } catch { return null; }
}

export function storeAgent(storage, agent) {
  try {
    if (!storage) return;
    if (agent) storage.setItem(AGENT_KEY, JSON.stringify({ id: agent.id, name: agent.name }));
    else storage.removeItem(AGENT_KEY);
  } catch { /* a convenience, not a record */ }
}

/** Anything naming the operator's own AEON is "no agent" to the terminal. */
export function asCurrent(agent) {
  return agent && !agent.self ? { id: agent.id, name: agent.name } : null;
}

/**
 * What `/agent <arg>` means, given the list from GET /api/agents:
 *   { back: true }          — off / aeon / self: return to the operator's AEON
 *   { agent }               — one agent matched (id, name, or one word of a name)
 *   { error }               — none or several matched, said in words
 */
export function resolveAgentArg(arg, agents = []) {
  const text = String(arg ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!text) return { error: 'Name an agent: /agent <name>. /agent alone lists them.' };
  const self = agents.find((a) => a && a.self);
  if (BACK.has(text) || (self && self.name.toLowerCase() === text)) return { back: true, agent: self || null };
  const exact = agents.filter((a) => a && (a.id === text || String(a.name).toLowerCase() === text || String(a.folder || '').toLowerCase() === text));
  if (exact.length === 1) return exact[0].self ? { back: true, agent: exact[0] } : { agent: exact[0] };
  const byWord = agents.filter((a) => a && String(a.name).toLowerCase().split(' ').some((w) => w === text || w.startsWith(text)));
  if (byWord.length === 1) return byWord[0].self ? { back: true, agent: byWord[0] } : { agent: byWord[0] };
  if (byWord.length > 1) return { error: `"${arg}" could be ${byWord.map((a) => a.name).join(' or ')} — say which.` };
  return { error: `No agent called "${arg}". /agent lists them; create one in Memory Core.` };
}

/** One line about an agent for the feed: its model and privacy, in words. */
export function describeAgent(a) {
  if (!a) return '';
  const model = a.model && a.model.provider ? `${a.model.provider}${a.model.model ? ` · ${a.model.model}` : ''}` : 'the model Settings picks';
  // The operator's own AEON holds the shared memory, which an agent set to
  // Roulette may still read and send to its model — so for it, only the chats.
  const privacy = a.privacy !== 'local-only' ? ''
    : a.self ? ', local only (its chats never go to a cloud model)'
      : ', local only (its chats and its own memory never go to a cloud model)';
  const shared = a.sharedMemory === false ? 'its own memory only' : 'its own memory plus the shared memory';
  return `${a.name} — ${model}${privacy}; ${shared}.`;
}
