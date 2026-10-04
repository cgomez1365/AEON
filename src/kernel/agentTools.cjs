/**
 * The agent toolbox — what an agent (and the operator's own AEON) may DO
 * during a chat turn, using AEON's own capabilities and nothing else:
 *
 *   vault_search      the Second Brain search /ask uses (context.cjs → retrieve)
 *   vault_read        one Vault file: text, Markdown, PDF, HTML (extract.cjs)
 *   vault_list        one Vault folder
 *   web_search        the search-web service (services/search.js), never for
 *                     an agent set to Local only or while Local only is on
 *   memory_save       its OWN memory store, through memory_core's route
 *   artifact_save     a Markdown document in its own folder
 *   scratchpad_write  its own scratchpad
 *   ask_agent         one question to another agent (askAgent below)
 *
 * No shell, no code execution, no arbitrary HTTP: the toolbox holds exactly
 * these eight. (src/kernel/agentToolRegistry.cjs — manifest agent_tools,
 * loopback into any block route — is a different module and is NOT used here.)
 *
 * Every call: arguments validated first, privacy enforced before any read
 * (vaultPath.cjs confines paths to the Vault; vaultPrivacy.cjs withholds a
 * Local only agent's folder and switched-off memories), a timeout, a size cap,
 * an audit line. Writes go only to the caller's own memory / scratchpad /
 * artifacts, at most MAX_WRITES per turn, and each one carries a notice the
 * terminal shows. run() never throws.
 *
 * Kernel module: relative requires only, takes the vault root as an argument.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const agentsKernel = require('./agents.cjs');
const kernelContext = require('./context.cjs');
const vaultPrivacy = require('./vaultPrivacy.cjs');
const { resolveInVault } = require('./vaultPath.cjs');
const { extractText } = require('./extract.cjs');
const { isOsJunk, isHidden } = require('./osJunk.cjs');
const { inputBudgets } = require('./tokens.cjs');
const workspace = require('./agentWorkspace.cjs');
const protocol = require('./toolProtocol.cjs');

const LIMITS = Object.freeze({
  MAX_TOOL_CALLS: 6,
  MAX_WRITES: 3,
  RESULT_MAX_CHARS: Object.freeze({
    vault_search: 6000, vault_read: 8000, vault_list: 4000, web_search: 4000,
    memory_save: 1000, artifact_save: 1000, scratchpad_write: 1000, ask_agent: 4000,
  }),
  RESULTS_TOTAL_MIN: 3000,
  RESULTS_TOTAL_MAX: 24000,
  PREVIEW_MAX_CHARS: 4000,
  TIMEOUT_MS: Object.freeze({
    vault_search: 15000, vault_read: 30000, vault_list: 5000, web_search: 15000,
    memory_save: 10000, artifact_save: 5000, scratchpad_write: 5000, ask_agent: 120000,
  }),
  READ_MAX_BYTES: 25 * 1024 * 1024,
  QUERY_MAX: 500,
  PATH_MAX: 512,
  MEMORY_TEXT: Object.freeze([6, 1000]),
  ARTIFACT_NAME_MAX: 80,
  ARTIFACT_MAX_CHARS: 20000,
  QUESTION_MAX: 2000,
  WEB_COUNT_MAX: 8,
  LIST_MAX_ENTRIES: 200,
  TOOLS_MIN_CONTEXT: 4096,
  ASK_AGENT_MAX_TOKENS: 1024,
  SCRATCHPAD_MAX: workspace.SCRATCHPAD_MAX,
});

const TOOL_NAMES = protocol.TOOL_NAMES;
const WRITE_TOOLS = protocol.WRITE_TOOLS;
const CATEGORIES = new Set(['fact', 'identity', 'preference', 'contact', 'project', 'goal']);
const BASE_IDENTITY = 'You are AEON, a private AI workspace built by Broken Gear Industries. You are helpful, precise, and concise. When the user asks you to do something, do it directly. ';

/**
 * Never read or listed through a tool, whoever asks, judged as typed AND as
 * the disk resolves it (vaultPrivacy: real case, symlinks followed, Windows
 * short names expanded by realpath), so a link elsewhere in the Vault that
 * leads into one is refused too:
 *   'saved-chats'   saved chats and the security block's records
 *                   (vaultPrivacy.NEVER_SHARED: not indexed either)
 *   'memory-folder' an agent's memory folder — its store and the <id>.md
 *                   mirrors. Memories switched on reach the model in its
 *                   instructions, and vault_search searches them; a listing
 *                   would change with a save that matched a switched-off
 *                   memory and so tell a model that one exists.
 */
const notForTools = (rel, sc) => {
  try {
    if (sc.neverShared(rel)) return 'saved-chats';
    return sc.inMemoryFolder(rel) ? 'memory-folder' : null;
  } catch { return 'saved-chats'; }
};
const NOT_FOR_TOOLS_SAYS = {
  'saved-chats': 'saved chats and security records stay out of tool results',
  'memory-folder': 'memory files are not read through tools; the memories that are switched on are already in your instructions, and vault_search searches them',
};

const USAGE = {
  vault_search: '{"tool": "vault_search", "query": "what to look for"}',
  vault_read: '{"tool": "vault_read", "path": "Notes/plan.md", "offset": 0}',
  vault_list: '{"tool": "vault_list", "path": "Notes"}',
  web_search: '{"tool": "web_search", "query": "what to look for"}',
  memory_save: '{"tool": "memory_save", "text": "The operator prefers short answers", "category": "preference"}',
  artifact_save: '{"tool": "artifact_save", "name": "Title"} then a line --- then the Markdown',
  scratchpad_write: '{"tool": "scratchpad_write", "mode": "replace"} then a line --- then the text',
  ask_agent: '{"tool": "ask_agent", "agent": "Name", "question": "..."}',
};

const fmt = (n) => Number(n).toLocaleString('en-US');
const isLocal = (a) => !!a && a.privacy === 'local-only';
const nameOf = (a) => (a && a.name) || 'AEON';
const firstSentence = (p) => String(p || '').trim().split(/(?<=[.!?])\s/)[0].slice(0, 80);
const kb = (bytes) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

function cap(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return { text: s, truncated: false };
  const keep = Math.max(0, max - 80);
  return { text: `${s.slice(0, keep)}\n…(cut here: ${fmt(s.length - keep)} more characters were not sent)`, truncated: true };
}

// The terminal's preview of a result: shorter than what the model got, and
// it says so — the hidden part DID reach the model.
function previewOf(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const keep = Math.max(0, max - 80);
  return `${s.slice(0, keep)}\n…(${fmt(s.length - keep)} more characters went to the model; not shown here)`;
}

class Stopped extends Error {}

// A promise that loses to an abort. The work underneath (an extract, a search)
// cannot always be cancelled, but the turn never waits for it.
function raceSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Stopped());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Stopped());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

// ── F3: ask another agent ───────────────────────────────────────────────

/** The agents `caller` may ask: not itself, readable, and on its side of Local only. */
function askable(caller, agents) {
  return (agents || []).filter((a) => a && !a.error && (!caller || a.id !== caller.id) && isLocal(a) === isLocal(caller));
}

/**
 * One question to another agent: its persona and memory, one turn, no tools,
 * no history, no recall. Depth 1 by construction — the target has no toolbox,
 * so a tool block in its answer is plain text and never runs.
 */
async function askAgent({
  vaultRoot, caller, target: ref, agents = null, question, kernelLLM, signal = null,
  contextTokens = 8192, baseIdentity = BASE_IDENTITY, memSettings = {},
}) {
  const all = agents || agentsKernel.list(vaultRoot, { withStats: false });
  const allowed = askable(caller, all);
  const names = allowed.map((a) => a.name).join(', ') || 'none';
  const text = String(ref ?? '').trim();
  // A caller that is not Local only (its model may be in the cloud) cannot
  // learn that a Local only agent exists, not even its name: the target is
  // looked up among the agents it could see, and a Local only one answers
  // exactly like no agent at all. (The caller itself is kept, for "self".)
  const visible = isLocal(caller) ? all : all.filter((a) => !isLocal(a) || (caller && a.id === caller.id));
  const target = text ? agentsKernel.get(vaultRoot, text, visible) : null;
  if (!target) {
    const lower = text.toLowerCase();
    const several = text && allowed.filter((a) => a.name.toLowerCase().split(' ').some((w) => w.startsWith(lower))).length > 1;
    return {
      status: 'error', code: several ? 'ambiguous-agent' : 'unknown-agent',
      text: `${several ? `"${text}" matches more than one agent` : `No agent called "${text}"`}. Agents you may ask: ${names}.`,
      summary: several ? 'more than one agent matches' : 'no such agent',
    };
  }
  if (caller && target.id === caller.id) {
    return { status: 'refused', code: 'self', text: 'You cannot ask yourself. Answer from what you know, or use another tool.', summary: 'cannot ask itself' };
  }
  if (target.error) {
    return { status: 'error', code: 'unknown-agent', text: `${target.name}'s agent.json could not be read; it cannot be asked. Agents you may ask: ${names}.`, summary: 'agent unreadable' };
  }
  // The privacy boundary: Local only on one side and not the other. The
  // target's model is never called.
  if (isLocal(caller) !== isLocal(target)) {
    const msg = isLocal(target)
      ? `${target.name} is set to Local only; its answer would carry its private memory into this chat, which goes to a cloud model. Ask ${target.name} directly with /agent ${target.name.toLowerCase()}.`
      : `${nameOf(caller)} is set to Local only; asking ${target.name} would send this conversation's question to a cloud model.`;
    return { status: 'refused', code: 'privacy-boundary', text: msg, summary: 'Local only boundary' };
  }
  if (!kernelLLM || typeof kernelLLM.stream !== 'function') {
    return { status: 'error', code: 'unavailable', text: 'The model layer is not available to ask another agent.', summary: 'unavailable' };
  }
  const q = String(question ?? '').trim();
  const budgets = inputBudgets(contextTokens || 8192);
  const mem = kernelContext.buildMemoryContext(q, {
    vaultRoot, agent: target, budgetTokens: budgets.memoryTokens, maxCount: 200,
    enabled: memSettings.memory_in_context !== false,
  });
  const system = agentsKernel.identityFor(target, baseIdentity) + kernelContext.FORMATTING
    + workspace.promptBlock(vaultRoot, target).text + protocol.neutralise(mem.text);
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: `${nameOf(caller)}, another of the operator's agents, asks you: ${q}` },
  ];
  let answer = '';
  const r = await kernelLLM.stream(messages, {
    role: 'chat', ...agentsKernel.callOptions(target), max_tokens: LIMITS.ASK_AGENT_MAX_TOKENS,
    ...(signal ? { signal } : {}),
    onToken: (t) => { answer += t; },
  });
  if (r && r.cancelled) throw new Stopped();
  const said = String(r?.text ?? answer).trim();
  agentsKernel.recordMission(vaultRoot, target, {
    asked: `[from ${nameOf(caller)}] ${q}`, provider: r?.provider || null, model: r?.model || null, tokens: r?.tokens || 0, ok: !!said,
  });
  return {
    status: 'ok', code: null,
    text: `${target.name} answered:\n${said || '(no answer)'}`,
    summary: `${target.name} answered (${fmt(said.length)} characters)`,
  };
}

// ── The toolbox ─────────────────────────────────────────────────────────

function createToolbox({
  vaultRoot, agent = null, agents = null, settings = {}, memSettings = {}, auth = null,
  kernelLLM = null, fetchWebSearch = null, requestIndex = null, writeOSAudit = null,
  correlationId = 'AEON-SYS', contextTokens = 8192, signal: turnSignal = null,
  fetchImpl = null, baseIdentity = BASE_IDENTITY,
  // Test seam: shorter per-tool timeouts (never longer than LIMITS).
  timeoutsMs = null,
} = {}) {
  const timeoutFor = (tool) => Math.min(LIMITS.TIMEOUT_MS[tool], Number(timeoutsMs?.[tool]) || LIMITS.TIMEOUT_MS[tool]);
  const all = Array.isArray(agents) ? agents : (() => { try { return agentsKernel.list(vaultRoot, { withStats: false }); } catch { return []; } })();
  const caller = agent || all.find((a) => a.self) || { id: agentsKernel.SELF_ID, name: 'AEON', folder: agentsKernel.SELF_FOLDER, self: true, privacy: 'roulette' };
  const callerLocal = isLocal(caller);
  const ownFolder = callerLocal ? workspace.folderOf(caller) : null;
  const totalBudget = Math.max(LIMITS.RESULTS_TOTAL_MIN, Math.min(LIMITS.RESULTS_TOTAL_MAX, Math.floor((Number(contextTokens) || 8192) * 4 * 0.35)));
  const doFetch = fetchImpl || globalThis.fetch;

  // Why web search is not offered to this caller, or null.
  const webOff = callerLocal
    ? `${caller.name} is set to Local only, so it never searches the web: a search query would leave this computer.`
    : settings && settings.local_only === true
      ? 'Local only is on (Settings → Models), so AEON does not search the web: a search query would leave this computer.'
      : memSettings && memSettings.agent_tools_web === false
        ? 'Web search for agents is off (Settings → Blocks → Memory Core → Agents may search the web).'
        : null;
  const allowedAgents = askable(caller, all);

  const available = [
    'vault_search', 'vault_read', 'vault_list',
    ...(!webOff && typeof fetchWebSearch === 'function' ? ['web_search'] : []),
    'memory_save', 'artifact_save', 'scratchpad_write',
    ...(allowedAgents.length ? ['ask_agent'] : []),
  ];

  let calls = 0;
  let writes = 0;
  let used = 0;
  const nonce = protocol.newNonce();
  const outcomes = [];
  const scope = () => vaultPrivacy.createScope(vaultRoot);
  const budgetLeft = () => Math.max(0, totalBudget - used);

  const ok = (text, summary, extra = {}) => ({ status: 'ok', code: null, text, summary, ...extra });
  const err = (code, text, summary = text) => ({ status: 'error', code, text, summary });
  const no = (code, text, summary = text) => ({ status: 'refused', code, text, summary });
  const PATH_REFUSALS = new Set(['absolute-path', 'traversal', 'hidden', 'outside-vault']);
  const fromPath = (r) => (PATH_REFUSALS.has(r.code) ? no(r.code, r.message) : err(r.code, r.message));
  // What the terminal says (the operator's view). The model is told only
  // what a missing path tells it, except a Local only caller asking for
  // another Local only agent's folder.
  const WITHHELD_SAYS = {
    'local-only-agent': 'a Local only agent\'s folder',
    'memory-off': 'a memory the operator switched off',
    'memory-store': 'a memory store that holds a switched-off memory',
  };
  // Withheld: the model is told exactly what a missing path tells it, so it
  // cannot learn that the folder exists, nor that a switched-off memory does.
  // A Local only caller may learn that another Local only agent's folder is
  // there (both stay on this computer): each reads only its own.
  const withheldOutcome = (why, rel, notFoundText) => (why === 'local-only-agent' && callerLocal
    ? no(why, `"${rel}" is withheld: it belongs to another agent set to Local only, and each Local only agent reads only its own folder.`)
    : err(why, notFoundText, `withheld: ${WITHHELD_SAYS[why] || why} (the model was told it is not there)`));

  // Why a path is not read or listed for this caller, as the outcome, or
  // null. In this order, so no answer tells a Local only folder apart from a
  // missing one: saved chats (by name alone, the same for every folder), a
  // Local only agent's folder (reads as not there), an existing agent's
  // memory folder, then anything else withheld.
  function barred(rel, sc, notFound) {
    const refuse = (bar) => no('hidden', `"${rel}" is not readable through tools (${NOT_FOR_TOOLS_SAYS[bar]}).`);
    if (notForTools(rel, sc) === 'saved-chats') return refuse('saved-chats');
    const why = sc.withheldFor(rel, { ownFolder });
    if (why === 'local-only-agent') return withheldOutcome(why, rel, notFound);
    const bar = notForTools(rel, sc);
    if (bar) return refuse(bar);
    return why ? withheldOutcome(why, rel, notFound) : null;
  }

  function str(v, max, name, min = 1) {
    if (typeof v !== 'string') return `"${name}" must be text.`;
    const t = v.trim();
    if (t.length < min) return min > 1 ? `"${name}" needs at least ${min} characters.` : `"${name}" is required.`;
    if (t.length > max) return `"${name}" is at most ${fmt(max)} characters.`;
    return null;
  }

  const TOOLS = {
    vault_search: {
      validate: (a) => str(a.query, LIMITS.QUERY_MAX, 'query'),
      label: (a) => `vault_search ${String(a.query || '').slice(0, 80)}`,
      async exec(a, sig, room) {
        const r = await raceSignal(kernelContext.buildRecallContext(kernelContext.FORCE_PREFIX + a.query.trim(), {
          auth, budgetTokens: Math.max(128, Math.floor(room / 4)), localOnly: callerLocal,
          fetchImpl: doFetch, timeoutMs: LIMITS.TIMEOUT_MS.vault_search,
        }), sig);
        const body = String(r.context || '').replace(/^\s*\[AEON SECOND BRAIN CONTEXT\]\s*/, '').trim();
        if (r.ok === false || r.unavailable) {
          return err('unavailable', workspace.plainError(body || 'The document index could not be searched.', vaultRoot), `index could not be searched${r.unavailable ? ` (${r.unavailable})` : ''}`);
        }
        if (!r.count && !r.manifest) return ok('No indexed documents matched this search.', 'no matches');
        return ok(body, r.manifest
          ? `${fmt(r.citations?.length || 0)} matching documents (titles only)`
          : `${fmt(r.count)} passages from ${fmt(r.matched ?? r.count)} matches`);
      },
    },
    vault_read: {
      validate: (a) => str(a.path, LIMITS.PATH_MAX, 'path')
        || (a.offset != null && !(Number.isInteger(Number(a.offset)) && Number(a.offset) >= 0) ? '"offset" is a whole number of characters, 0 or more.' : null),
      label: (a) => `vault_read ${String(a.path || '')}${Number(a.offset) ? ` @${a.offset}` : ''}`,
      async exec(a, sig, room) {
        const r = resolveInVault(vaultRoot, a.path, { mustExist: false });
        if (!r.ok) return fromPath(r);
        const notFound = `Nothing at "${r.rel}" in the Vault. Use vault_list or vault_search to find the right path.`;
        const refusal = barred(r.rel, scope(), notFound);
        if (refusal) return refusal;
        if (!fs.existsSync(r.abs)) return err('not-found', notFound);
        const st = fs.statSync(r.abs);
        if (st.isDirectory()) return err('bad-path', `"${r.rel}" is a folder. Use vault_list to see what is in it.`);
        if (st.size > LIMITS.READ_MAX_BYTES) return no('too-large', `"${r.rel}" is ${kb(st.size)}; AEON's tools read files up to ${kb(LIMITS.READ_MAX_BYTES)}.`);
        const text = await raceSignal(Promise.resolve().then(() => extractText(r.abs)), sig);
        if (text == null) return err('unreadable-format', `"${r.rel}" is a binary file; AEON reads text, Markdown, PDF and HTML.`);
        const total = text.length;
        const from = Math.min(Number(a.offset) || 0, total);
        const head = (b) => `${r.rel} — characters ${fmt(from)}–${fmt(b)} of ${fmt(total)}\n\n`;
        const tailNote = (b) => (b < total ? `\n\n(More follows. Call vault_read with "offset": ${b} to read on.)` : '');
        const room2 = Math.max(200, room - head(total).length - tailNote(0).length - 20);
        const to = Math.min(total, from + room2);
        return ok(`${head(to)}${text.slice(from, to)}${tailNote(to)}`,
          `${r.rel}: characters ${fmt(from)}–${fmt(to)} of ${fmt(total)}`, { capped: to < total });
      },
    },
    vault_list: {
      validate: (a) => (a.path == null || a.path === '' ? null : str(a.path, LIMITS.PATH_MAX, 'path')),
      label: (a) => `vault_list ${a.path ? String(a.path) : '/'}`,
      async exec(a) {
        const r = resolveInVault(vaultRoot, a.path == null ? '' : a.path, { allowRoot: true, mustExist: false });
        if (!r.ok) return fromPath(r);
        const sc = scope();
        const notFound = `Nothing at "${r.rel}" in the Vault. Use vault_list on its parent folder.`;
        const refusal = r.rel ? barred(r.rel, sc, notFound) : null;
        if (refusal) return refusal;
        if (!fs.existsSync(r.abs)) {
          return r.rel ? err('not-found', notFound) : ok('The Vault is empty.', 'empty Vault');
        }
        if (!fs.statSync(r.abs).isDirectory()) return err('bad-path', `"${r.rel}" is a file. Use vault_read to read it.`);
        const entries = [];
        for (const d of fs.readdirSync(r.abs, { withFileTypes: true })) {
          if (isOsJunk(d.name) || isHidden(d.name)) continue;
          const rel = r.rel ? `${r.rel}/${d.name}` : d.name;
          if (notForTools(rel, sc) || sc.withheldFor(rel, { ownFolder })) continue;
          let dir = d.isDirectory();
          let size = 0;
          try { const st = fs.statSync(path.join(r.abs, d.name)); dir = st.isDirectory(); size = st.size; } catch { continue; }
          entries.push({ name: d.name, dir, size });
        }
        entries.sort((x, y) => (x.dir === y.dir ? x.name.localeCompare(y.name) : x.dir ? -1 : 1));
        const shown = entries.slice(0, LIMITS.LIST_MAX_ENTRIES);
        const where = r.rel || 'the top of the Vault';
        const lines = shown.map((e) => (e.dir ? `${e.name}/` : `${e.name} (${kb(e.size)})`));
        const more = entries.length > shown.length ? `\n(${fmt(entries.length - shown.length)} more not shown)` : '';
        return ok(entries.length ? `${where}:\n${lines.join('\n')}${more}` : `${where} is empty.`, `${fmt(entries.length)} entries in ${where}`);
      },
    },
    web_search: {
      validate: (a) => str(a.query, LIMITS.QUERY_MAX, 'query')
        || (a.count != null && !(Number(a.count) >= 1) ? '"count" is a number from 1 to 8.' : null),
      label: (a) => `web_search ${String(a.query || '').slice(0, 80)}`,
      async exec(a, sig) {
        const count = Math.min(LIMITS.WEB_COUNT_MAX, Math.max(1, Math.floor(Number(a.count) || 5)));
        const r = await raceSignal(Promise.resolve().then(() => fetchWebSearch(a.query.trim(), correlationId, count)), sig);
        const text = typeof r === 'string' ? r.trim() : '';
        return text ? ok(text, `web results for "${a.query.trim().slice(0, 60)}"`) : ok('No web results found.', 'no web results');
      },
    },
    memory_save: {
      validate: (a) => str(a.text, LIMITS.MEMORY_TEXT[1], 'text', LIMITS.MEMORY_TEXT[0])
        || (a.category != null && !CATEGORIES.has(String(a.category)) ? `"category" is one of ${[...CATEGORIES].join(', ')}.` : null),
      label: (a) => `memory_save ${String(a.text || '').slice(0, 60)}`,
      async exec(a, sig) {
        const body = {
          text: a.text.trim(), category: a.category || 'fact', source: 'agent-tool',
          // Its OWN store: an agent's own, or for the operator's AEON the
          // shared store (which is its own). Never the shared store for an agent.
          ...(caller && !caller.self ? { agent: caller.id } : {}),
        };
        const r = await doFetch(`${kernelContext.kernelBase()}/api/memory/add`, {
          method: 'POST', headers: kernelContext.forwardedAuth(auth), body: JSON.stringify(body), signal: sig,
        });
        const data = await r.json().catch(() => ({}));
        // Memory Core's own message can name the store by its absolute path;
        // the model may be in the cloud, so it reads a Vault path instead.
        // A refused save changed nothing, so it does not use up a save.
        if (!r.ok) {
          const why = workspace.plainError(String(data.error || data.message || ''), vaultRoot).slice(0, 240);
          return { ...err('failed', `Memory Core refused the save (${r.status}): ${why}`, 'memory not saved'), unchanged: true };
        }
        const who = caller.self ? `${nameOf(caller)}'s (shared)` : `${nameOf(caller)}'s`;
        const offNoteFor = (off) => (off ? ' — saved switched off (Settings → Blocks → Memory Core → New memories start on)' : '');
        // The same words as a switched-off memory already in the store:
        // Memory Core says what a new save would have said (modelText), so
        // the model cannot learn that an Off memory exists, nor its wording
        // (Off memories never reach a model). The save stays spent, as a new
        // one would be; the operator's notice says what really happened.
        if (data.deduped && typeof data.modelText === 'string') {
          return ok(`${data.modelText}${offNoteFor(data.modelActive === false)}`, 'already in memory (switched off)', {
            notice: `Already in ${who} memory, switched off — nothing new saved: "${body.text.slice(0, 160)}"`,
            unchanged: true, keepsSave: true,
          });
        }
        const offNote = offNoteFor(data.memory && data.memory.active === false);
        const quoted = `"${String(data.memory?.text || body.text).slice(0, 160)}"`;
        // A memory already there is not a save: not counted, and the reply
        // keeps the save it would have used.
        return ok(`${data.text || 'Saved to memory.'}${offNote}`, data.deduped ? 'already in memory' : 'memory saved', {
          notice: data.deduped ? `Already in ${who} memory — nothing new saved: ${quoted}` : `Saved to ${who} memory: ${quoted}${offNote}`,
          ...(data.deduped ? { unchanged: true } : {}),
        });
      },
    },
    artifact_save: {
      validate: (a) => str(a.name, 200, 'name') || (typeof a.content !== 'string' || !a.content.trim() ? 'Put the document after a line holding exactly ---.' : null),
      label: (a) => `artifact_save ${String(a.name || '').slice(0, 80)}`,
      async exec(a) {
        const saved = workspace.saveArtifact(vaultRoot, caller, a.name, a.content);
        try { if (typeof requestIndex === 'function') requestIndex({ blockId: 'memory_core', kind: 'artifact' }); } catch {}
        return ok(`Saved ${saved.rel} (${fmt(saved.chars)} characters).`, `saved ${saved.rel}`, { notice: `Saved ${saved.rel}` });
      },
    },
    scratchpad_write: {
      validate: (a) => {
        if (a.mode != null && a.mode !== 'replace' && a.mode !== 'append') return '"mode" is "replace" or "append".';
        const c = typeof a.content === 'string' ? a.content : a.text;
        if (typeof c !== 'string') return 'Put the scratchpad text after a line holding exactly ---.';
        if ((a.mode || 'replace') === 'append' && !c.trim()) return 'Nothing to append.';
        return null;
      },
      label: (a) => `scratchpad_write ${a.mode || 'replace'}`,
      async exec(a) {
        const c = typeof a.content === 'string' ? a.content : a.text;
        const w = workspace.writeScratchpad(vaultRoot, caller, c, { mode: a.mode || 'replace' });
        const line = `${nameOf(caller)}'s scratchpad updated (${fmt(w.chars)} / ${fmt(workspace.SCRATCHPAD_MAX)} characters)`;
        return ok(`${line}.`, 'scratchpad updated', { notice: line });
      },
    },
    ask_agent: {
      validate: (a) => str(a.agent, 64, 'agent') || str(a.question, LIMITS.QUESTION_MAX, 'question'),
      label: (a) => `ask_agent ${String(a.agent || '')}`,
      exec: (a, sig) => askAgent({
        vaultRoot, caller, target: a.agent, agents: all, question: a.question, kernelLLM,
        signal: sig, contextTokens, baseIdentity, memSettings,
      }),
    },
  };

  function displayArgs(args) {
    const out = {};
    for (const [k, v] of Object.entries(args || {})) {
      if (k === 'content' && typeof v === 'string') { out[k] = `<${fmt(v.length)} characters>`; continue; }
      if (typeof v === 'string') out[k] = v.length > 200 ? `${v.slice(0, 199)}…` : v;
      else if (v == null || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
      else out[k] = '<object>';
    }
    return out;
  }

  function refusedTool(tool) {
    if (tool === 'web_search') {
      return webOff ? no('local-only-web', webOff, 'web search is off for this agent')
        : err('unavailable', 'Web search is not available in this AEON.', 'web search unavailable');
    }
    if (tool === 'ask_agent') {
      return err('unknown-agent', `There is no other agent ${nameOf(caller)} may ask${callerLocal ? ' (only agents set to Local only, like it)' : ''}.`, 'no agent to ask');
    }
    return err('unknown-tool', `"${tool}" is not available. Tools: ${available.join(', ')}.`, 'unknown tool');
  }

  async function run(call, { signal: sig = null, onStart = null } = {}) {
    calls++;
    const n = calls;
    const id = `t${n}`;
    const t0 = Date.now();
    const parsed = call || { ok: false, error: 'bad-json', message: 'No tool call.' };
    // What the model wrote, made safe for a chip label and an audit line.
    const tool = String(parsed.tool || '?').replace(/[^a-z0-9_?.-]/gi, '').slice(0, 40) || '?';
    const args = parsed.args || {};
    const write = WRITE_TOOLS.has(tool);
    const spec = TOOLS[tool];
    const label = parsed.ok === false ? `${tool === '?' ? 'tool call' : tool} (could not be read)` : (spec ? spec.label(args) : tool);
    try { if (typeof onStart === 'function') onStart({ id, n, tool, args: displayArgs(args), write, label }); } catch {}

    let o;
    const stop = turnSignal || sig;
    if (parsed.ok === false) {
      o = err(parsed.error || 'bad-json', `${parsed.message || 'The tool call could not be read.'}${spec ? ` Usage: ${USAGE[tool]}` : ''}`, 'the call could not be read');
    } else if (n > LIMITS.MAX_TOOL_CALLS) {
      o = no('tool-limit', `No tool uses left this reply (at most ${LIMITS.MAX_TOOL_CALLS}).`, 'tool limit reached');
    } else if (!TOOL_NAMES.includes(tool)) {
      o = err('unknown-tool', `"${String(parsed.rawTool || tool).slice(0, 60)}" is not a tool. Tools: ${available.join(', ')}.`, 'unknown tool');
    } else if (!available.includes(tool)) {
      o = refusedTool(tool);
    } else {
      const bad = spec.validate(args);
      if (bad) o = err('bad-args', `${bad} Usage: ${USAGE[tool]}`, 'bad arguments');
      else if (write && writes >= LIMITS.MAX_WRITES) {
        o = no('write-limit', `No saves left this reply (at most ${LIMITS.MAX_WRITES}). Tell the operator what you would have saved.`, 'save limit reached');
      } else if (!write && budgetLeft() < 200) {
        o = no('results-budget', 'This reply has used all the tool results it can carry. Answer with what you have.', 'results budget used up');
      } else {
        if (write) writes++;
        const room = write ? LIMITS.RESULT_MAX_CHARS[tool] : Math.min(LIMITS.RESULT_MAX_CHARS[tool], budgetLeft());
        const timeout = AbortSignal.timeout(timeoutFor(tool));
        const both = stop ? AbortSignal.any([stop, timeout]) : timeout;
        try {
          o = await raceSignal(spec.exec(args, both, room), both);
        } catch (e) {
          if (stop && stop.aborted) o = err('failed', 'Stopped by the operator.', 'stopped');
          else if (e instanceof Stopped || e?.name === 'TimeoutError' || e?.name === 'AbortError' || timeout.aborted) {
            o = err('timeout', `${tool} took longer than ${Math.max(1, Math.round(timeoutFor(tool) / 1000))} seconds and was stopped.`, 'timed out');
          } else if (e instanceof workspace.WorkspaceError) {
            // Refused before anything was written (too long, a link, bad
            // arguments): nothing changed.
            o = { ...(e.status === 413 || e.code === 'linked' ? no : err)(e.code || 'failed', e.message, e.code === 'scratchpad-full' ? 'scratchpad full' : e.message), unchanged: e.status < 500 };
          } else {
            // The model may be in the cloud: the error's code and a Vault
            // path, never the host's absolute paths. The full message stays
            // on this computer, in the console.
            console.warn(`[AGENT-TOOLS] ${tool} failed:`, e?.message || e);
            o = err('failed', `${tool} failed: ${workspace.plainError(e, vaultRoot)}`.slice(0, 400), 'failed');
          }
        }
      }
    }

    // A write that changed nothing gives its save back.
    if (write && o.unchanged && !o.keepsSave && writes > 0) writes--;
    const max = write ? LIMITS.RESULT_MAX_CHARS[tool] : Math.max(200, Math.min(LIMITS.RESULT_MAX_CHARS[tool] || 1000, budgetLeft() || 200));
    const c = cap(o.text, max);
    used += c.text.length;
    const outcome = {
      id, n, tool, ok: o.status === 'ok', status: o.status, code: o.code || null,
      text: c.text, summary: String(o.summary || '').split('\n')[0].slice(0, 200),
      preview: previewOf(c.text, LIMITS.PREVIEW_MAX_CHARS),
      chars: c.text.length, truncated: c.truncated || !!o.capped,
      notice: o.notice || null, write, saved: write && o.status === 'ok' && !o.unchanged, ms: Date.now() - t0, label,
    };
    outcomes.push(outcome);
    try {
      if (typeof writeOSAudit === 'function') {
        writeOSAudit('AGENT_TOOL', `${caller.id}:${tool}:${outcome.status}`, outcome.ok ? 200 : outcome.status === 'refused' ? 403 : 400, outcome.chars, correlationId);
      }
    } catch {}
    return outcome;
  }

  return {
    names: () => available.slice(),
    promptText: () => protocol.systemText({
      tools: available,
      agentsAllowed: allowedAgents.map((a) => ({ name: a.name, persona: firstSentence(a.persona) })),
      limits: LIMITS, folder: workspace.folderOf(caller), nonce,
    }),
    nonce,
    run,
    callsLeft: () => Math.max(0, LIMITS.MAX_TOOL_CALLS - calls),
    writesLeft: () => Math.max(0, LIMITS.MAX_WRITES - writes),
    outcomes: () => outcomes.slice(),
    budget: () => ({ total: totalBudget, used }),
    caller,
    agentNames: () => allowedAgents.map((a) => a.name),
  };
}

module.exports = { createToolbox, askAgent, LIMITS, TOOL_NAMES, BASE_IDENTITY };
