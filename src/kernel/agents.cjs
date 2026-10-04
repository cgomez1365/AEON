/**
 * The operator's agents — each one a folder under Vault/Agents.
 *
 *   Vault/Agents/Aeon/                 the operator's own AEON (always present)
 *     agent.json                       optional: the name and persona they gave it
 *     memory/memories.json             SHARED memory — every agent may read it
 *     chat_sessions/                   saved chats
 *   Vault/Agents/<Folder>/             one per agent the operator created
 *     agent.json                       name, persona, model, privacy, memory switches
 *     memory/memories.json             that agent's OWN memory
 *     chat_sessions/
 *
 * The shared store keeps the path it always had (Agents/Aeon/memory), so an
 * install that predates agents loses nothing and moves nothing. A folder
 * under Agents/ is an agent only if it holds an agent.json — Agents/council
 * (debate transcripts) is not one, and never shows up as one.
 *
 * Everything is read from disk on every call: the Vault is the operator's,
 * and an edit made in Aeon Matrix is true the moment it is saved.
 *
 * Kernel module: relative requires only, takes the vault root as an argument,
 * looks for no home directory.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isOsJunk, isHidden } = require('./osJunk.cjs');

const SELF_FOLDER = 'Aeon';
const SELF_ID = 'aeon';
const NAME_MAX = 32;
const PERSONA_MAX = 4000;
const PRIVACY = new Set(['roulette', 'local-only']);
// Folders under Agents/ that are something else, and words that already wake
// the operator's own AEON. An agent may not take any of them.
const RESERVED = new Set(['aeon', 'vp', 'council', 'shared', 'all', 'removed', 'agents']);

class AgentError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// No vault root given: the in-install default context.cjs also uses.
const agentsDir = (vaultRoot) => path.join(vaultRoot || path.join(__dirname, '..', 'blocks', 'aeon_matrix', 'data', 'Vault'), 'Agents');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// Atomic, like the memory store: the Vault lives on an exFAT drive on carried
// installs, and an unplug mid-write must leave the old file whole.
function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

/** A spoken name: 1–32 characters, starting with a letter. */
function cleanName(raw) {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!name) throw new AgentError('An agent needs a name.');
  if (name.length > NAME_MAX) throw new AgentError(`An agent's name is at most ${NAME_MAX} characters — it is what you say to call it.`);
  if (!/^\p{L}/u.test(name)) throw new AgentError('An agent\'s name starts with a letter.');
  if (!/^[\p{L}\p{N} '._-]+$/u.test(name)) throw new AgentError('An agent\'s name may use letters, digits, spaces and - _ . \' only.');
  return name;
}

/** The folder a name lives in: ASCII letters, digits, - and _ only. */
function folderFor(name) {
  return String(name).normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

function cleanModel(model) {
  if (model == null || model === '') return null;
  if (typeof model !== 'object') throw new AgentError('model is { provider, model } or null.');
  const provider = String(model.provider ?? '').trim();
  if (!provider || provider === 'none') return null;
  const id = model.model == null ? null : String(model.model).trim() || null;
  return { provider, model: id };
}

/** The fields an operator may set, validated. Unknown fields are ignored. */
function cleanFields(input, { partial }) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);
  if (!partial || has('name')) out.name = cleanName(input.name);
  if (has('persona')) {
    const p = String(input.persona ?? '').trim();
    if (p.length > PERSONA_MAX) throw new AgentError(`A persona is at most ${PERSONA_MAX} characters; it is sent with every message to this agent.`);
    out.persona = p;
  }
  if (has('model')) out.model = cleanModel(input.model);
  if (has('privacy')) {
    if (!PRIVACY.has(input.privacy)) throw new AgentError('privacy is "roulette" (any configured provider) or "local-only" (this computer only).');
    out.privacy = input.privacy;
  }
  if (has('sharedMemory')) out.sharedMemory = input.sharedMemory !== false;
  if (has('capture')) out.capture = input.capture === true;
  return out;
}

// Newest modification time under a folder's direct children, or 0.
function newestIn(dir) {
  let best = 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  for (const n of names) {
    if (isOsJunk(n) || isHidden(n)) continue;
    try { best = Math.max(best, fs.statSync(path.join(dir, n)).mtimeMs); } catch {}
  }
  return best;
}

function countJson(dir) {
  try { return fs.readdirSync(dir).filter((n) => n.endsWith('.json') && !isOsJunk(n) && !isHidden(n)).length; }
  catch { return 0; }
}

function memoryCount(dir) {
  try {
    const raw = readJson(path.join(dir, 'memory', 'memories.json'));
    const list = Array.isArray(raw) ? raw : raw?.memories;
    return Array.isArray(list) ? list.length : null;
  } catch (e) { return e.code === 'ENOENT' ? 0 : null; }
}

// The last thing an agent was asked, from its mission log (or null).
function lastMission(dir) {
  try {
    const log = readJson(path.join(dir, 'missions', 'log.json'));
    return Array.isArray(log) && log.length ? log[log.length - 1] : null;
  } catch { return null; }
}

// What the list shows about an agent's folder. Cheap: three small reads.
function stats(dir) {
  const lastActive = Math.max(
    newestIn(path.join(dir, 'chat_sessions')),
    newestIn(path.join(dir, 'memory')),
    newestIn(path.join(dir, 'missions')),
  );
  return {
    lastActiveAt: lastActive ? new Date(lastActive).toISOString() : null,
    memoryCount: memoryCount(dir),
    sessionCount: countJson(path.join(dir, 'chat_sessions')),
    lastMission: lastMission(dir),
  };
}

const MISSION_LOG_MAX = 50;
const ASKED_MAX = 140;
/**
 * One line in an agent's mission log (Agents/<Folder>/missions/log.json):
 * when, what it was asked (the operator's words, cut to 140 characters),
 * and what served it. Never the agent's answer — the log is in the Vault,
 * and a model's own words must not become a document a later answer cites
 * (R09). Capped at the last 50. Best-effort: a log that cannot be written
 * never fails the turn it describes.
 */
function recordMission(vaultRoot, agent, { asked, provider = null, model = null, tokens = 0, ok = true } = {}) {
  if (!agent) return false;
  try {
    const dir = path.join(agentsDir(vaultRoot), agent.self ? SELF_FOLDER : agent.folder, 'missions');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'log.json');
    let log = [];
    try { const raw = readJson(file); if (Array.isArray(raw)) log = raw; } catch {}
    const text = String(asked ?? '').replace(/\s+/g, ' ').trim();
    log.push({
      at: new Date().toISOString(),
      asked: text.length > ASKED_MAX ? `${text.slice(0, ASKED_MAX - 1)}…` : text,
      provider, model, tokens: Number(tokens) || 0, ok: !!ok,
    });
    writeJsonAtomic(file, log.slice(-MISSION_LOG_MAX));
    return true;
  } catch { return false; }
}

function shape(folder, rec, self) {
  return {
    id: self ? SELF_ID : String(rec.id || folder.toLowerCase()),
    name: rec.name || (self ? 'Aeon' : folder),
    folder,
    self,
    persona: rec.persona || '',
    model: cleanModelSafe(rec.model),
    privacy: PRIVACY.has(rec.privacy) ? rec.privacy : 'roulette',
    // The operator's own AEON owns the shared store, so for it "shared" is
    // simply its memory.
    sharedMemory: self ? true : rec.sharedMemory !== false,
    capture: rec.capture === true,
    createdAt: rec.createdAt || null,
    updatedAt: rec.updatedAt || null,
  };
}
function cleanModelSafe(m) { try { return cleanModel(m); } catch { return null; } }

// An agent.json that is there but cannot be read: the agent is treated as
// Local only until it is fixed. vaultPrivacy.cjs already withholds such a
// folder ("a privacy setting nobody can read is not off"); serving the agent
// as Roulette would send its memory and notes to a cloud model.
function unreadable(folder, self, e) {
  return {
    ...shape(folder, { privacy: 'local-only' }, self),
    error: `agent.json could not be read (${e.message})`,
    privacyUnknown: true,
  };
}

function readSelf(vaultRoot) {
  let rec = {};
  try { rec = readJson(path.join(agentsDir(vaultRoot), SELF_FOLDER, 'agent.json')) || {}; }
  catch (e) {
    // No agent.json: the operator's own AEON before it was named.
    if (!(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR'))) return unreadable(SELF_FOLDER, true, e);
  }
  return shape(SELF_FOLDER, rec, true);
}

/**
 * Every agent: the operator's own AEON first, then the ones they created,
 * most recently active first. A damaged agent.json is listed with the error
 * rather than hidden — hiding it would read as "the agent is gone".
 */
function list(vaultRoot, { withStats = true } = {}) {
  const root = agentsDir(vaultRoot);
  const self = readSelf(vaultRoot);
  const out = [withStats ? { ...self, ...stats(path.join(root, SELF_FOLDER)) } : self];
  let names = [];
  try { names = fs.readdirSync(root); } catch { return out; }
  const others = [];
  for (const folder of names) {
    if (folder === SELF_FOLDER || isOsJunk(folder) || isHidden(folder)) continue;
    const dir = path.join(root, folder);
    const file = path.join(dir, 'agent.json');
    if (!fs.existsSync(file)) continue;
    let entry;
    try { entry = shape(folder, readJson(file) || {}, false); }
    catch (e) { entry = unreadable(folder, false, e); }
    others.push(withStats ? { ...entry, ...stats(dir) } : entry);
  }
  others.sort((a, b) => String(b.lastActiveAt || '').localeCompare(String(a.lastActiveAt || '')) || a.name.localeCompare(b.name));
  return out.concat(others);
}

/**
 * The agent a reference means — an id, a folder, a name, or one word of a
 * name — or null. Two or more candidates is null: a wrong agent costs more
 * than a question.
 */
function get(vaultRoot, ref, agents = null) {
  const all = agents || list(vaultRoot, { withStats: false });
  const text = String(ref ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!text) return null;
  if (text === SELF_ID || text === 'vp') return all.find((a) => a.self) || null;
  const exact = all.filter((a) => a.id === text || a.folder.toLowerCase() === text || a.name.toLowerCase() === text);
  if (exact.length === 1) return exact[0];
  const byWord = all.filter((a) => a.name.toLowerCase().split(' ').some((w) => w === text || w.startsWith(text)));
  return byWord.length === 1 ? byWord[0] : null;
}

function requireAgent(vaultRoot, ref) {
  const a = get(vaultRoot, ref);
  if (!a) throw new AgentError(`No agent called "${ref}". /agent lists them.`, 404);
  return a;
}

/** Create an agent: its folder, its agent.json, an empty memory folder. */
function create(vaultRoot, input = {}) {
  const fields = cleanFields(input, { partial: false });
  const all = list(vaultRoot, { withStats: false });
  const lower = fields.name.toLowerCase();
  if (RESERVED.has(lower) || all.some((a) => a.name.toLowerCase() === lower)) {
    throw new AgentError(`"${fields.name}" is already taken${RESERVED.has(lower) ? ' — it is a reserved word' : ''}. Pick another name.`, 409);
  }
  let folder = folderFor(fields.name);
  if (!folder || RESERVED.has(folder.toLowerCase())) folder = `Agent_${crypto.randomBytes(2).toString('hex')}`;
  const dir = path.join(agentsDir(vaultRoot), folder);
  if (fs.existsSync(dir)) {
    throw new AgentError(`A folder Agents/${folder} already exists in the Vault. Pick another name, or move that folder first.`, 409);
  }
  const now = new Date().toISOString();
  const rec = {
    id: folder.toLowerCase(),
    name: fields.name,
    persona: fields.persona || '',
    model: fields.model ?? null,
    privacy: fields.privacy || 'roulette',
    sharedMemory: fields.sharedMemory !== false,
    capture: fields.capture === true,
    createdAt: now,
    updatedAt: now,
  };
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  writeJsonAtomic(path.join(dir, 'agent.json'), rec);
  return { ...shape(folder, rec, false), ...stats(dir) };
}

/**
 * Change an agent. The operator's own AEON can be renamed and given a
 * persona and a model — "users design and name their own AEON" — and its
 * folder stays Agents/Aeon so the shared memory never moves.
 */
function update(vaultRoot, ref, patch = {}) {
  const a = requireAgent(vaultRoot, ref);
  const fields = cleanFields(patch, { partial: true });
  if (a.self) delete fields.sharedMemory;
  if (fields.name && fields.name.toLowerCase() !== a.name.toLowerCase()) {
    const lower = fields.name.toLowerCase();
    const others = list(vaultRoot, { withStats: false }).filter((x) => x.id !== a.id);
    if ((!a.self && RESERVED.has(lower)) || others.some((x) => x.name.toLowerCase() === lower)) {
      throw new AgentError(`"${fields.name}" is already taken. Pick another name.`, 409);
    }
  }
  const dir = path.join(agentsDir(vaultRoot), a.folder);
  const file = path.join(dir, 'agent.json');
  let rec = {};
  try { rec = readJson(file) || {}; } catch (e) { if (e.code !== 'ENOENT') throw new AgentError(`Agents/${a.folder}/agent.json could not be read (${e.message}); fix it in Aeon Matrix first.`, 503); }
  const next = { ...rec, ...(a.self ? {} : { id: a.id }), ...fields, updatedAt: new Date().toISOString() };
  if (!next.createdAt) next.createdAt = next.updatedAt;
  fs.mkdirSync(dir, { recursive: true });
  writeJsonAtomic(file, next);
  return { ...shape(a.folder, next, a.self), ...stats(dir) };
}

/**
 * Remove an agent. Its folder — memory, chats, missions — moves to
 * Agents/.removed/; nothing is deleted (§21). The operator's own AEON
 * cannot be removed: it holds the shared memory.
 */
function remove(vaultRoot, ref) {
  const a = requireAgent(vaultRoot, ref);
  if (a.self) throw new AgentError('Your own AEON holds the shared memory and cannot be removed. Rename it instead.', 409);
  const from = path.join(agentsDir(vaultRoot), a.folder);
  const bin = path.join(agentsDir(vaultRoot), '.removed');
  fs.mkdirSync(bin, { recursive: true });
  const to = path.join(bin, `${a.folder}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.renameSync(from, to);
  return { id: a.id, name: a.name, movedTo: path.relative(vaultRoot, to) };
}

/**
 * What a model call made for this agent carries to the kernel LLM layer:
 * the agent's own model (or nothing — Settings decides, roulette included),
 * and Local only when the agent is private. A private agent's call is
 * refused rather than sent to a cloud model, whatever the global switch says
 * — a privacy promise that falls back to the cloud is not one.
 */
function callOptions(agent) {
  if (!agent) return {};
  const out = {};
  if (agent.model && agent.model.provider) {
    out.provider = agent.model.provider;
    if (agent.model.model) out.model = agent.model.model;
  }
  if (agent.privacy === 'local-only') {
    out.localOnly = true;
    if (agent.privacyUnknown) {
      const where = `Agents/${agent.self ? SELF_FOLDER : agent.folder}/agent.json`;
      out.localOnlyReason = `${where} could not be read, so ${agent.name} is treated as Local only and nothing it is asked is sent to a cloud model. `;
      out.localOnlyRemedy = `Fix or restore ${where} (Memory Core shows the error), or give ${agent.name} a local model.`;
    } else {
      out.localOnlyReason = `${agent.name} is set to Local only, so nothing it is asked is sent to a cloud model. `;
      out.localOnlyRemedy = `Give ${agent.name} a local model in Memory Core, or set its privacy to Roulette.`;
    }
  }
  return out;
}

/** Where an agent's memory lives. The operator's own AEON: the shared store. */
function memoryDir(vaultRoot, agent) {
  return path.join(agentsDir(vaultRoot), agent && !agent.self ? agent.folder : SELF_FOLDER, 'memory');
}

/**
 * The opening of a system prompt, for an agent. `base` is the caller's own
 * identity line, which starts with LEAD; only that first sentence changes.
 * The operator's own AEON keeps the stock line until they name it or give
 * it a persona.
 */
const LEAD = 'You are AEON, a private AI workspace built by Broken Gear Industries.';
function identityFor(agent, base) {
  if (!agent) return base;
  const stock = agent.self && (!agent.name || agent.name.toLowerCase() === 'aeon') && !agent.persona;
  if (stock) return base;
  const rest = base.startsWith(LEAD) ? base.slice(LEAD.length) : ` ${base}`;
  const who = agent.self
    ? `You are ${agent.name}, the operator's own AEON — a private AI workspace built by Broken Gear Industries.`
    : `You are ${agent.name}, an agent the operator created inside AEON, a private AI workspace built by Broken Gear Industries.`;
  return `${who}${agent.persona ? ` ${agent.persona}` : ''}${rest}`;
}
const sharedMemoryDir = (vaultRoot) => memoryDir(vaultRoot, null);

// ── Waking an agent ───────────────────────────────────────────────────
// "Any wake-up call should be good" (operator, 2026-10-02). Between the words
// any spaces or punctuation are allowed — "aeon - come online" did not wake
// before, because only a space, comma or "!" could sit there.
const SEP = "[\\s,.:;!?'\"\\u2013\\u2014-]";
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * { wake, agent, spoken } for a message.
 *
 *   "<name> come online", "<name> - online", "aeon, scout come online"
 *   "wake up <name>", "<name> wake up", "hey <name>, wake up"
 *   "come online" / "wake up" alone            → wakes whoever is current
 *
 * <name> is "aeon", "vp", or any agent's name or folder. `agent` is the
 * agent that was named (null when none was, or a name nobody has — waking
 * is never cancelled by a name nobody recognises).
 */
function detectWake(message, agents = []) {
  const text = String(message ?? '').trim();
  if (!text) return { wake: false, agent: null, spoken: null };
  const names = new Set(['aeon', 'vp']);
  for (const a of agents) {
    if (!a) continue;
    names.add(String(a.name).toLowerCase());
    names.add(String(a.folder).toLowerCase());
  }
  const words = [...names].filter(Boolean).sort((x, y) => y.length - x.length).map(escapeRe).join('|');
  const name = `(?:${SEP}+([\\p{L}][\\p{L}\\p{N} _-]{0,30}?))?`;
  const tries = [
    // At the start (after an optional greeting): <word> [name] (come|get|be|go)? (back)? online
    new RegExp(`^(?:(?:hey|hi|hello|ok|okay|yo)${SEP}+)?(${words})${name}${SEP}+(?:(?:come|get|be|go)\\s+)?(?:back\\s+)?online(?![\\p{L}\\p{N}])`, 'iu'),
    // Anywhere, with the verb said: "please, aeon come online". A bare
    // "online" mid-sentence ("the aeon docs are online") is not a wake.
    new RegExp(`(?:^|[^\\p{L}\\p{N}])(${words})${name}${SEP}+(?:come|get|be|go)\\s+(?:back\\s+)?online(?![\\p{L}\\p{N}])`, 'iu'),
    // wake up [,] <word>
    new RegExp(`(?:^|[^\\p{L}\\p{N}])wake\\s*up${SEP}+(${words})(?![\\p{L}\\p{N}])`, 'iu'),
    // <word> [,] wake up
    new RegExp(`(?:^|[^\\p{L}\\p{N}])(${words})${SEP}+wake\\s*up(?![\\p{L}\\p{N}])`, 'iu'),
  ];
  for (const re of tries) {
    const m = re.exec(text);
    if (!m) continue;
    const word = m[1].toLowerCase();
    const extra = (m[2] || '').trim().toLowerCase();
    const named = extra && !['come', 'get', 'be', 'go', 'back'].includes(extra) ? extra : null;
    // "aeon scout come online": aeon is the wake word, scout the agent.
    const spoken = (word === 'aeon' || word === 'vp') && named ? named : word;
    const agent = agents.length ? get(null, spoken, agents) : null;
    return { wake: true, agent, spoken };
  }
  if (new RegExp(`^(?:hey${SEP}+)?(?:(?:come|get|be)\\s+online|wake\\s*up)(?![\\p{L}\\p{N}])`, 'iu').test(text)) {
    return { wake: true, agent: null, spoken: null };
  }
  return { wake: false, agent: null, spoken: null };
}

/**
 * The turns of a conversation that may go to a model serving `agent`. The
 * terminal tags each turn with the agent it was with (`agent: <id>`), and one
 * feed can hold several agents. A turn with an agent set to Local only goes
 * only to a call that is Local only too; untagged turns are kept. `agent`
 * null: a call that is not an agent's (a chat title, the indexed record).
 */
function shareableTurns(messages, agent, agents) {
  if (!Array.isArray(messages)) return [];
  if (agent && agent.privacy === 'local-only') return messages;
  const hidden = new Set((agents || []).filter((a) => a && a.privacy === 'local-only').map((a) => a.id));
  if (!hidden.size) return messages;
  return messages.filter((m) => !(m && typeof m.agent === 'string' && hidden.has(m.agent)));
}

module.exports = {
  list, get, create, update, remove, memoryDir, sharedMemoryDir, detectWake, callOptions, identityFor, recordMission,
  shareableTurns,
  folderFor, cleanName, AgentError, SELF_ID, SELF_FOLDER, PRIVACY,
};
