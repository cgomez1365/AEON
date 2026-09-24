/**
 * Who can the operator talk to?
 *
 * Distinct from `agents.json` next door, which lists PROVIDERS — Groq, Gemini,
 * local, Claude. Those are engines. These are personas: the Council members the
 * operator wrote, plus AEON itself.
 *
 * The point is cost. Asking "who is available" should not load the memory core:
 * a roster is a handful of names and one line each, perhaps 120 tokens, where
 * the full memory read behind a wake phrase is thousands. Knowing who you can
 * call and calling them are separate acts, and only the second should be paid
 * for — the same split that makes `/matrix list` cheap next to `/matrix`.
 *
 * Names are matched loosely on purpose. The operator says "aeon shield come
 * online"; the Council member is stored as "1. Protocol & Header Forensics
 * Specialist". A roster nobody can address by the name they would actually say
 * is a roster nobody uses.
 *
 * Kernel module: relative requires only, no reach into services/.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = process.env.DATA_PATH || require('./aeonHome.cjs').roots({ appRoot: ROOT }).data;
const COUNCIL_FILE = path.join(DATA_DIR, 'council', 'members.json');

// AEON itself is always callable and is not stored in any file.
const SELF = {
  id: 'aeon',
  name: 'Aeon',
  role: 'The operator\'s own assistant — full memory, every block.',
  self: true,
};

/** Strip the list numbering and punctuation a stored label carries. */
function normalise(label) {
  return String(label || '')
    .replace(/^\s*\d+[.)]\s*/, '')       // "1. Protocol & Header..." -> "Protocol & Header..."
    .replace(/[^a-z0-9 ]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Everyone who can be called, cheapest possible read. */
function roster() {
  const out = [SELF];
  try {
    const members = JSON.parse(fs.readFileSync(COUNCIL_FILE, 'utf8'));
    for (const m of Array.isArray(members) ? members : []) {
      const label = normalise(m?.label);
      if (!label) continue;
      out.push({
        id: m.id,
        name: label,
        // The persona is the agent; quoting it here would cost what the roster
        // exists to avoid. Its first clause is enough to choose by.
        role: firstClause(m.persona) || (m.chair ? 'Council chair' : 'Council member'),
        model: m.model || null,
        provider: m.provider || null,
        self: false,
      });
    }
  } catch {
    // No council file is not an error: a fresh vault has none, and AEON itself
    // is still callable. An empty roster would be the wrong claim.
  }
  return out;
}

function firstClause(persona) {
  const s = String(persona || '').trim().replace(/\s+/g, ' ');
  if (!s) return null;
  const cut = s.split(/(?<=[.!?])\s/)[0] || s;
  return cut.length > 120 ? `${cut.slice(0, 117)}…` : cut;
}

/**
 * The agent a spoken name refers to, or null.
 *
 * Exact id, then exact name, then a word-prefix match — "shield" finds
 * "AEON-Shield", "protocol" finds "Protocol & Header Forensics Specialist".
 * Ambiguity returns null rather than guessing: waking the wrong persona is
 * worse than asking which one was meant.
 */
function resolve(spoken, list = roster()) {
  const q = normalise(spoken).toLowerCase();
  if (!q) return null;
  const byId = list.find((a) => String(a.id).toLowerCase() === q);
  if (byId) return byId;
  const byName = list.filter((a) => a.name.toLowerCase() === q);
  if (byName.length === 1) return byName[0];
  const byWord = list.filter((a) => a.name.toLowerCase().split(' ').some((w) => w === q || w.startsWith(q)));
  return byWord.length === 1 ? byWord[0] : null;
}

/**
 * The roster as the model should see it: names and one line each, no personas
 * and no memory. Deliberately ends by saying what it is NOT, because a model
 * handed a list of specialists will otherwise start speaking as one.
 */
function render(list = roster()) {
  const lines = list.map((a) => `- ${a.name}${a.self ? '' : ` — ${a.role}`}`);
  return `\n\n[AEON AGENTS]\nThe operator can call any of these by saying "aeon <name> come online":\n\n`
    + `${lines.join('\n')}\n\n`
    + `This is the roster only — no agent is loaded and no memory has been read. `
    + `Do not answer as one of these agents, and do not describe what one would say. `
    + `If the operator asked who is available, list them. If they asked something an agent `
    + `should handle, name the one you would call and ask them to call it.`;
}

// "who can I talk to", "which agents", "list agents", "who is available".
const ROSTER_RE = /\b(?:who|which|what)\b[^?]{0,40}\b(?:agents?|personas?|available|talk to|call)\b|\blist\s+(?:the\s+)?agents?\b|\bagent\s+list\b/i;

const isRosterQuery = (text) => ROSTER_RE.test(String(text || ''));

module.exports = { roster, resolve, render, isRosterQuery, normalise, ROSTER_RE, SELF, COUNCIL_FILE };
