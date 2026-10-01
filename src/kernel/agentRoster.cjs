/**
 * Who the operator can talk to: AEON itself, plus the Council members they
 * created. Not to be confused with agents.json, which lists PROVIDERS (Groq,
 * Gemini, local models) — this lists the voices.
 *
 * The point is cost. A list of names is cheap (the whole roster measured
 * about 286 tokens) where waking an agent means a full memory read (about
 * 7,200). So the roster carries a name and one line per agent, never a
 * persona, and memory is loaded only when an agent is actually called.
 *
 * Kernel module: relative requires only, no reach into services/, no home
 * directory (the path gate allows only aeonHome.cjs to look for one). It
 * writes nothing — not when required, not when read. A fresh vault has no
 * council file, and that is not an error: AEON itself can still be called.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { roots } = require('./aeonHome.cjs');

// The same file the Council block reads and writes (its data folder,
// "council", under the data root). roots() honours DATA_PATH; tests set it
// before requiring this module, because the path is resolved once, here.
const COUNCIL_FILE = path.join(roots({ appRoot: path.join(__dirname, '..', '..') }).data, 'council', 'members.json');

/** AEON's own entry. Always present, stored in no file. */
const SELF = Object.freeze({
  id: 'aeon',
  name: 'Aeon',
  role: "The operator's own assistant — the default voice when no specialist is named.",
  self: true,
});

// One line per agent keeps the whole roster to a few hundred tokens.
const ROLE_MAX = 120;

/**
 * A stored label as a spoken name: list numbering dropped ("1. "), anything
 * that is not an ASCII letter, digit or space turned into a space, spaces
 * collapsed. Case is kept. (Non-ASCII letters are dropped too — a known
 * limit: "Café" becomes "Caf".)
 */
function normalise(label) {
  return String(label ?? '')
    .replace(/^\s*\d+[.)]\s*/, '')
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The first sentence of a persona, at most 120 characters. Never the whole
 * persona: the persona is most of what an agent IS, and copying it here
 * would bring back exactly the cost the roster exists to avoid.
 */
function firstSentence(persona) {
  const text = String(persona ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const m = /^.*?[.!?](?=\s)/.exec(text);
  const line = m ? m[0] : text;
  return line.length > ROLE_MAX ? `${line.slice(0, ROLE_MAX - 3)}…` : line;
}

function readCouncil() {
  try {
    const parsed = JSON.parse(fs.readFileSync(COUNCIL_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * [SELF, ...council members]. Read from disk on every call (no cache); a
 * missing or damaged council file yields [SELF] — claiming nobody is
 * available would be false.
 */
function roster() {
  const out = [SELF];
  for (const m of readCouncil()) {
    if (!m) continue;
    const name = normalise(m.label);
    if (!name) continue;
    out.push({
      id: m.id,
      name,
      role: firstSentence(m.persona) || (m.chair ? 'Council chair' : 'Council member'),
      model: m.model ?? null,
      provider: m.provider ?? null,
      self: false,
    });
  }
  return out;
}

/**
 * The roster entry a spoken name means, or null. Tried in order: an id, a
 * full name, then a single word that one name contains (or begins). Two or
 * more candidates is null — ambiguity never guesses, because a wrong wake
 * costs more than a clarifying question.
 */
function resolve(spoken, list = roster()) {
  const text = normalise(spoken).toLowerCase();
  if (!text) return null;
  const entries = Array.isArray(list) ? list.filter(Boolean) : [];

  const byId = entries.find((e) => String(e.id ?? '').toLowerCase() === text);
  if (byId) return byId;

  const byName = entries.filter((e) => String(e.name ?? '').toLowerCase() === text);
  if (byName.length === 1) return byName[0];

  const byWord = entries.filter((e) => String(e.name ?? '').toLowerCase().split(' ')
    .some((w) => w === text || w.startsWith(text)));
  return byWord.length === 1 ? byWord[0] : null;
}

/** The roster as the model sees it: names and one-line roles, nothing loaded. */
function render(list = roster()) {
  const lines = (Array.isArray(list) ? list : []).filter(Boolean)
    .map((e) => (e.self ? `- ${e.name}` : `- ${e.name} — ${e.role}`));
  return '\n\n[AEON AGENTS]\n'
    + 'The operator calls one by saying "aeon <name> come online".\n'
    + `${lines.join('\n')}\n`
    + 'Only these names are present: no persona is loaded and no memory was read. '
    + "Do not speak in any listed agent's voice or predict what one would answer. "
    + 'If the operator asks who is available, give this list. If a request belongs '
    + 'to a specialist, suggest which agent fits and leave calling it to the operator.';
}

// "who can I talk to", "which agents are there", "list the agents",
// "agent list". The 40-character window keeps the question word and the term
// in one clause; a "?" inside it ends the clause. "call" must end at a word
// boundary, so "who called me?" is not a roster question.
const ROSTER_RE = /\b(?:who|which|what)\b[^?]{0,40}?\b(?:agents?|personas?|available|talk to|call)\b|\blist\s+(?:the )?agents?\b|\bagent list\b/i;

function isRosterQuery(text) {
  return ROSTER_RE.test(String(text ?? ''));
}

module.exports = { roster, resolve, render, isRosterQuery, normalise, ROSTER_RE, SELF, COUNCIL_FILE };
