/**
 * memory_core — VP's persistent memory store.
 *
 * The old memory block was removed but two live consumers still expect it:
 *   - dashboard/api/chat-stream.cjs injects memories into every terminal chat
 *   - its auto-extract loop POSTs new facts to /api/memory/add
 * This block owns that store again, vault-resident so the operator can see
 * every memory as a file in Aeon Matrix.
 *
 * Store: Vault/Agents/Aeon/memory/memories.json  (SHARED — every agent reads it)
 *        Vault/Agents/<Folder>/memory/memories.json  (one agent's own)
 *        <dir>/<id>.md                           (operator-readable mirror)
 * Every route takes ?agent=<id|name> (or body.agent); none means the shared
 * store. Agents themselves: GET/POST /agents, PUT/DELETE /agents/:id
 * (src/kernel/agents.cjs owns the layout).
 * Record: { id, text, category, type, title, tags, pinned, active, timestamp, source, refs }
 *   - active: the manual switch — false keeps the memory saved and listed
 *     here, but never sends it to a model, and keeps it (and its .md mirror)
 *     out of the Second Brain index and recall (kernel/vaultPrivacy.cjs).
 *     Missing = on
 *   - category: legacy taxonomy (fact|identity|preference|contact|project|goal)
 *   - type: operator taxonomy (outline|algorithm|decision|milestone) — optional
 *   - refs: provenance, citation-doctrine style — [{kind, ...locator}] so a
 *     memory can always answer "where did this come from" (kind: terminal-history
 *     | transcript | file | url | mission | operator)
 *
 * Ranking doctrine (context + injection): continuity > recency.
 *   pinned ≫ operator-authored > decision > outline/algorithm > fact > milestone,
 *   recency only breaks ties. Keyword relevance adds on top for /context.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const memoryPolicy = require('../../../kernel/memory-policy.cjs');
const agentsKernel = require('../../../kernel/agents.cjs');
const { estimateTokens } = require('../../../kernel/tokens.cjs');
const blockSettings = require('../../../kernel/blockSettings.cjs');
const sections = require('../../../kernel/memorySections.cjs');
const agentWorkspace = require('../../../kernel/agentWorkspace.cjs');
const crypto = require('crypto');

/**
 * How long ago an ISO time was, in words, for the "already distilled" reply.
 * Each unit is rounded before its threshold is checked, so 59.6 minutes
 * reads "1 hour ago". Clock skew (a time in the future) reads "moments ago";
 * a time that does not parse counts from the epoch.
 */
function agoInWords(iso, now = Date.now()) {
  const t = Date.parse(iso);
  const ms = now - (Number.isFinite(t) ? t : 0);
  if (ms < 90 * 1000) return 'moments ago';
  const ago = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return ago(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 24) return ago(hours, 'hour');
  return ago(Math.round(hours / 24), 'day');
}

/**
 * A saved chat as the distil prompt reads it: the last 30 turns, one
 * "role: content" line each, content cut to 400 characters. The terminal's
 * DISTIL button builds its live transcript the same way, so the same
 * conversation fingerprints the same from either button.
 */
function sessionTranscript(msgs) {
  return msgs.slice(-30).map((m) => `${m?.role}: ${String(m?.content ?? '').slice(0, 400)}`).join('\n');
}

module.exports = function createMemoryRouter(deps) {
  const router = express.Router();
  const { kernelLLM, VAULT_ROOT, TERMINAL_HISTORY_FILE } = deps;

  // Every memory is also a Vault file (the .md mirror), and the Second Brain
  // only finds Vault files it has indexed. The store never asked, so a memory
  // saved at 08:40 was invisible to /recall until the next boot, nightly or
  // manual scan (measured 2026-09-23). vaultSync — the other kernel writer into
  // the Vault — asks via this same hook; the kernel coalesces the requests into
  // one incremental scan.
  const requestIndex = (kind) => {
    try { if (typeof deps.requestIndex === 'function') deps.requestIndex({ blockId: 'memory_core', kind }); }
    catch { /* indexing is best-effort; the memory itself is already saved */ }
  };

  const VAULT = VAULT_ROOT || path.join(__dirname, '..', '..', 'aeon_matrix', 'data', 'Vault');
  // The shared store keeps the path it always had: Agents/Aeon/memory.
  const MEM_DIR = agentsKernel.sharedMemoryDir(VAULT);

  // One store per memory folder — the shared one, and one per agent. Same
  // rules for every one of them: atomic writes, unreadable is not empty, a
  // ledger of what was distilled beside it.
  function makeStore(MEM_DIR, owner = null) {
  const STORE = path.join(MEM_DIR, 'memories.json');
  // A store reached through a link is neither read nor written
  // (agents.memoryLink): a linked memory/ would show and change another
  // agent's memories — a Local only one's included — as this one's.
  const refuseLink = () => {
    const link = agentsKernel.memoryLink(VAULT, owner);
    if (!link) return;
    const err = new Error(agentsKernel.memoryLinkError(link));
    err.status = 409;
    err.memoryStore = true;
    throw err;
  };
  // Which transcripts have already been distilled, by fingerprint. It sits
  // beside memories.json rather than under db/, so a Vault restored from a
  // backup brings back the ledger that matches its memories. Bounded: 200
  // runs is far more than the guard needs, and a file next to the Vault must
  // not grow forever.
  const LEDGER = path.join(MEM_DIR, '.distilled.json');
  const LEDGER_MAX = 200;
  // Missing, damaged or not a list: an empty ledger. Reading never fails a distill.
  const readLedger = () => {
    try {
      const entries = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
      return Array.isArray(entries) ? entries : [];
    } catch { return []; }
  };
  // A ledger that cannot be written costs one repeat distil later, never this
  // one: the memories are already saved, so the failure is logged, not raised.
  const recordDistilled = (sha, added) => {
    try {
      const entries = readLedger().filter((e) => e && e.sha !== sha);
      entries.push({ sha, at: new Date().toISOString(), added });
      fs.writeFileSync(LEDGER, JSON.stringify(entries.slice(-LEDGER_MAX), null, 2));
    } catch (e) {
      console.warn(`[MEMORY] distill ledger ${LEDGER} was not written (${e.message}); this conversation can be distilled again.`);
    }
  };

  // Unreadable is not empty — the rule vault.cjs and endpoints.cjs already
  // follow (kernel audit, 2026-09-28). A memories.json cut short by an unplug
  // mid-write, or left with a trailing comma by a hand edit in Matrix Edit
  // Mode, read as [] with no log: Memory Core showed "0 memories" as if that
  // were true, and the next add, edit or distill wrote a store holding only
  // that one memory over every other. Only a MISSING file is an empty store.
  // Anything else throws, the file stays exactly as it is, and the log and
  // the route both say where it is and what to do.
  // A memory whose <id>.md mirror is missing (mdMirror's write failed, or the
  // store was restored or edited by hand) is found by recall only through its
  // mirror once memories.json is withheld (vaultPrivacy: a store holding an
  // Off memory), so a read writes the mirrors it finds missing. Each id is
  // checked once per process; mdMirror marks the ones it writes.
  const mirrored = new Set();
  const repairMirrors = (all) => {
    let wrote = 0;
    for (const m of all) {
      if (!m || m.id == null || mirrored.has(String(m.id)) || typeof m.text !== 'string') continue;
      try {
        const file = path.join(MEM_DIR, `${m.id}.md`);
        if (!fs.existsSync(file)) { mdMirror(m); if (fs.existsSync(file)) wrote++; }
      } catch (e) { console.warn(`[MEMORY] mirror ${m.id}.md was not written (${e.message})`); }
      mirrored.add(String(m.id));
    }
    if (wrote) { console.log(`[MEMORY] wrote ${wrote} missing memory mirror(s) in ${MEM_DIR}`); requestIndex('mirror'); }
  };
  const load = () => {
    refuseLink();
    let why;
    try {
      const all = JSON.parse(fs.readFileSync(STORE, 'utf8'));
      if (Array.isArray(all)) { repairMirrors(all); return all; }
      why = 'not a list of memories';
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      why = e.message;
    }
    const err = new Error(`The memory store ${STORE} is unreadable (${why}). It was left untouched and nothing was saved — `
      + 'fix or restore that file (every memory also has an <id>.md copy beside it), then try again.');
    err.status = 503;
    err.memoryStore = true; // only this error's status is passed on (see distill)
    console.error(`[MEMORY] ${err.message}`);
    throw err;
  };
  // Read for a route: a damaged store answers 503 with the reason, never a
  // list that looks empty. Returns null once it has answered.
  const loadFor = (res) => {
    try { return load(); }
    catch (e) { res.status(e.status || 500).json({ ok: false, error: e.message }); return null; }
  };
  // Atomic: a crash or an unplug mid-write leaves the previous file whole,
  // not half of a new one. The store lives on an exFAT drive on carried installs.
  // The temp file is flushed to the disk before the rename: without the fsync
  // an unplug just after the rename could still leave the new name holding a
  // short file, and the comment above would only be true of a crash.
  const save = (all) => {
    refuseLink();
    fs.mkdirSync(MEM_DIR, { recursive: true });
    const tmp = `${STORE}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      const fd = fs.openSync(tmp, 'w');
      try { fs.writeFileSync(fd, JSON.stringify(all, null, 2)); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(tmp, STORE);
    } catch (e) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
      throw e;
    }
  };

  const mdMirror = (m) => {
    const fm = [
      '---',
      `id: ${m.id}`,
      `category: ${m.category || 'fact'}`,
      m.type ? `type: ${m.type}` : null,
      m.title ? `title: ${JSON.stringify(m.title)}` : null,
      (m.tags && m.tags.length) ? `tags: [${m.tags.join(', ')}]` : null,
      `pinned: ${!!m.pinned}`,
      m.active === false ? 'active: false' : null,
      `created: ${new Date(m.timestamp).toISOString()}`,
      m.source ? `source: ${m.source}` : null,
      (m.refs && m.refs.length) ? `refs: ${JSON.stringify(m.refs)}` : null,
      '---',
    ].filter(Boolean).join('\n');
    try { fs.writeFileSync(path.join(MEM_DIR, `${m.id}.md`), `${fm}\n\n${m.text}\n`); mirrored.add(String(m.id)); } catch {}
  };
  const mdRemove = (id) => { try { fs.unlinkSync(path.join(MEM_DIR, `${id}.md`)); } catch {} };
  return { dir: MEM_DIR, STORE, LEDGER, readLedger, recordDistilled, load, loadFor, save, mdMirror, mdRemove };
  }

  try { if (!fs.existsSync(MEM_DIR)) fs.mkdirSync(MEM_DIR, { recursive: true }); } catch {}
  const stores = new Map();
  const storeAt = (dir, owner = null) => { if (!stores.has(dir)) stores.set(dir, makeStore(dir, owner)); return stores.get(dir); };

  // Which store a request means: ?agent= or body.agent, else the shared
  // one. An agent nobody has is a 404 that says so — never the shared store
  // standing in for it, which would put one agent's memory in another's.
  const scopeFor = (req, res) => {
    const ref = req.query?.agent ?? req.body?.agent;
    if (ref == null || ref === '') return { st: storeAt(MEM_DIR), agent: null };
    const agent = agentsKernel.get(VAULT, ref);
    if (!agent) { res.status(404).json({ ok: false, error: `No agent called "${ref}". GET /api/agents lists them.` }); return null; }
    return { st: storeAt(agentsKernel.memoryDir(VAULT, agent), agent.self ? null : agent), agent: agent.self ? null : agent };
  };
  // Settings → Blocks → Memory Core → "New memories start on". Off suits an
  // operator whose store has outgrown the context window: new memories are
  // kept and switched on by hand when they matter.
  const newMemoriesOn = () => {
    let settings = {};
    try { settings = (typeof deps.loadSettings === 'function' && deps.loadSettings()) || {}; } catch {}
    return blockSettings.get('memory_core', settings).new_memories_on !== false;
  };
  const agentErr = (res, e) => res.status(e.status || 500).json({ ok: false, error: e.message });
  // A memory as a list shows it: what it costs a prompt, and whether it is on.
  const withCost = (m) => ({ ...m, active: m.active !== false, tokens: estimateTokens(`- [${m.type || m.category || 'fact'}] ${m.text}`) });

  const newId = () => crypto.randomBytes(6).toString('hex');

  // ── GET /memory — full list (newest first, pinned float) ────────────
  router.get('/memory', (req, res) => {
    const scope = scopeFor(req, res); if (!scope) return;
    const { st, agent } = scope;
    const stored = st.loadFor(res); if (!stored) return;
    const all = stored.sort((a, b) => (b.pinned - a.pinned) || (b.timestamp - a.timestamp));
    const { type, category, q } = req.query;
    let out = all;
    if (type) out = out.filter(m => m.type === type);
    if (category) out = out.filter(m => m.category === category);
    // A `q` that is only a category word (case-insensitive, plural-tolerant)
    // is a SECTION lookup — the memory's category field, not its text. It was
    // text-only: `/memory preference` returned 0 for seven category=preference
    // memories whose text never said the word. Anything else stays a substring
    // search.
    const sec = q ? sections.parseSectionQuery(q, all) : null;
    let section = null;
    if (sec) {
      section = sec.category;
      out = sections.selectSection(out, sec).entries;
    } else if (q) {
      // Every word, in any order. One substring made "/memory northwind pilot"
      // find a memory that "/memory pilot northwind" could not (audit
      // 2026-09-23). An exact phrase still matches — it contains every word.
      const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
      out = out.filter(m => {
        const hay = (m.text + ' ' + (m.title || '')).toLowerCase();
        return words.every(w => hay.includes(w));
      });
    }
    // `text` is the complete rendering (the terminal chip and the narrator read
    // it); `verbatim` says it is the whole answer, safe to relay unsummarised.
    // What the switches add up to, over the whole store (not just this
    // search): how many memories are on, and what they cost a prompt.
    const listed = out.map(withCost);
    const on = all.filter(memoryPolicy.isActive);
    const summary = {
      total: all.length,
      active: on.length,
      inactive: all.length - on.length,
      activeTokens: on.reduce((n, m) => n + withCost(m).tokens, 0),
    };
    // What the terminal's narrator may read back into the conversation — and
    // the conversation goes to a model. The list without the memories that are
    // switched off; nothing of a Local only agent's memory. `text` (the chip
    // the operator sees) keeps everything.
    const off = out.filter((m) => m.active === false).length;
    const modelText = agent && agent.privacy === 'local-only'
      ? null
      : off ? `${sections.renderList(out.filter((m) => m.active !== false))}\n(${off} switched off — not repeated here.)` : undefined;
    res.json({
      memories: listed, count: listed.length, dir: st.dir, summary,
      agent: agent ? { id: agent.id, name: agent.name } : null,
      ...(section ? { section } : {}), text: sections.renderList(out), verbatim: true,
      ...(modelText !== undefined ? { modelText } : {}),
    });
  });

  // What a save says: the stored text, and whether it was reworded.
  const savedSays = (category, normalized, original) => {
    const said = [`Saved to memory (${category}): ${normalized.text}`];
    if (normalized.changed) said.push(`Reworded from "${String(original).trim()}" so it reads as being about you when AEON recalls it.`);
    if (normalized.residualPerson) said.push('It still says "I" or "you" somewhere; recalled into a prompt, that reads as the model. Consider editing it in Memory Core.');
    return said;
  };

  // ── POST /memory/add — create (path kept for chat-stream auto-extract) ─
  router.post('/memory/add', (req, res) => {
    const { text, category, type, title, tags, pinned, source, refs } = req.body || {};
    if (!text || String(text).trim().length < 6) return res.status(400).json({ error: 'text required (6+ chars)' });

    // D2a #10 — store facts in third person, about the operator.
    //
    // These are injected into a SYSTEM prompt, where "you" addresses the
    // MODEL. So "[fact] your name is Cristian" told the model its own name
    // was Cristian, and "[fact] I am Nanaki" sitting beside it is very
    // likely that same confusion coming back out again.
    //
    // The original is kept whenever this changes anything. Rewriting an
    // operator's own words and discarding what they actually wrote would be
    // its own §08 defect — the record has to show both.
    const normalized = memoryPolicy.normalizeFactPerson(text);

    const scope = scopeFor(req, res); if (!scope) return;
    const { st } = scope;
    const all = st.loadFor(res); if (!all) return;
    // Dedupe: identical text is a no-op, not a second copy
    const dupe = all.find(m => m.text.trim().toLowerCase() === normalized.text.toLowerCase());
    // `text` is what the terminal chip prints. Without it /remember showed the
    // record as JSON, and a repeat looked exactly like a save.
    if (dupe) {
      const out = { ok: true, memory: dupe, deduped: true, text: `Already in memory — nothing new saved: ${dupe.text}` };
      // A switched-off memory never reaches a model, so a model that saves
      // its words (an agent's memory_save tool) is told what a new save would
      // tell it — modelText and modelActive — and never that it exists, nor
      // its stored wording. `text` above is the operator's.
      if (dupe.active === false) Object.assign(out, { modelText: savedSays(category || 'fact', normalized, text).join('\n'), modelActive: newMemoriesOn() });
      return res.json(out);
    }
    const m = {
      id: newId(), text: normalized.text,
      ...(normalized.changed ? { originalText: String(text).trim() } : {}),
      category: category || 'fact', type: type || null, title: title || null,
      tags: Array.isArray(tags) ? tags : [], pinned: !!pinned,
      // New memories follow the operator's default (Settings → Blocks →
      // Memory Core); a caller may say otherwise.
      active: req.body?.active === undefined ? newMemoriesOn() : req.body.active !== false,
      timestamp: Date.now(), source: source || 'api',
      refs: Array.isArray(refs) ? refs.slice(0, 5) : [],
    };
    all.push(m); st.save(all); st.mdMirror(m);
    requestIndex('memory-add');
    const said = savedSays(m.category, normalized, text);
    res.json({
      ok: true, memory: m, normalized: normalized.changed,
      text: said.join('\n'),
      // Reported, never silently corrected: a fact still carrying "I" or
      // "your" mid-sentence will read as being about the MODEL once injected.
      ...(normalized.residualPerson ? {
        warning: 'This memory still contains first- or second-person wording that could not be rewritten safely. '
          + 'Injected into a system prompt, "I" and "you" refer to the model, not the operator. Consider editing it.',
      } : {}),
    });
  });

  // ── PUT /memory/:id — edit ──────────────────────────────────────────
  router.put('/memory/:id', (req, res) => {
    const scope = scopeFor(req, res); if (!scope) return;
    const { st } = scope;
    const all = st.loadFor(res); if (!all) return;
    const m = all.find(x => x.id === req.params.id);
    if (!m) return res.status(404).json({ error: 'not found' });
    for (const k of ['text', 'category', 'type', 'title', 'tags', 'pinned']) {
      if ((req.body || {})[k] !== undefined) m[k] = req.body[k];
    }
    if ((req.body || {}).active !== undefined) m.active = req.body.active !== false;
    st.save(all); st.mdMirror(m);
    requestIndex('memory-edit');
    res.json({ ok: true, memory: m });
  });

  // ── POST /memory/:id/pin — toggle ───────────────────────────────────
  router.post('/memory/:id/pin', (req, res) => {
    const scope = scopeFor(req, res); if (!scope) return;
    const { st } = scope;
    const all = st.loadFor(res); if (!all) return;
    const m = all.find(x => x.id === req.params.id);
    if (!m) return res.status(404).json({ error: 'not found' });
    m.pinned = !m.pinned;
    st.save(all); st.mdMirror(m);
    res.json({ ok: true, pinned: m.pinned });
  });

  // ── POST /memory/:id/active — the manual switch ─────────────────────
  // { active: true|false } sets it; no body flips it. Off keeps the memory
  // saved, listed here and in Aeon Matrix; it is never sent to a model and
  // leaves the Second Brain index (and so recall) on the scan this asks for.
  // This is how the operator keeps a growing store from slowing every chat.
  router.post('/memory/:id/active', (req, res) => {
    const scope = scopeFor(req, res); if (!scope) return;
    const { st } = scope;
    const all = st.loadFor(res); if (!all) return;
    const m = all.find(x => x.id === req.params.id);
    if (!m) return res.status(404).json({ error: 'not found' });
    const want = req.body?.active;
    m.active = want === undefined ? m.active === false : want !== false;
    st.save(all); st.mdMirror(m);
    // Off takes the memory's file out of the Second Brain index; on puts it back.
    requestIndex('memory-active');
    res.json({ ok: true, id: m.id, active: m.active, text: `Memory ${m.active ? 'on — sent to the model again' : 'off — kept, but not sent to a model or recalled'}: ${m.text.slice(0, 80)}` });
  });

  // ── POST /memory/active — many switches at once ─────────────────────
  // { active, ids: [...] } or { active, all: true }. One save for the lot.
  router.post('/memory/active', (req, res) => {
    const scope = scopeFor(req, res); if (!scope) return;
    const { st } = scope;
    const { active, ids, all: everything } = req.body || {};
    if (typeof active !== 'boolean') return res.status(400).json({ ok: false, error: 'active (true or false) is required' });
    if (!everything && !Array.isArray(ids)) return res.status(400).json({ ok: false, error: 'Send ids: [...] or all: true.' });
    const list = st.loadFor(res); if (!list) return;
    const want = everything ? null : new Set(ids.map(String));
    let changed = 0;
    for (const m of list) {
      if (want && !want.has(m.id)) continue;
      if ((m.active !== false) !== active) { m.active = active; changed++; st.mdMirror(m); }
    }
    if (changed) { st.save(list); requestIndex('memory-active'); }
    res.json({ ok: true, changed, active });
  });

  // ── DELETE /memory/:id ──────────────────────────────────────────────
  router.delete('/memory/:id', (req, res) => {
    const scope = scopeFor(req, res); if (!scope) return;
    const { st } = scope;
    const all = st.loadFor(res); if (!all) return;
    const idx = all.findIndex(x => x.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });
    const [gone] = all.splice(idx, 1);
    st.save(all); st.mdRemove(gone.id);
    requestIndex('memory-delete');
    res.json({ ok: true, removed: gone.id });
  });

  // ── Ranking doctrine: continuity > recency ──────────────────────────
  // Operator-authored entries and settled decisions must outrank milestones
  // and drive-by facts no matter how old they are — re-litigating a decision
  // costs more than missing a recent event. Recency only breaks ties.
  //
  // The doctrine now lives in src/kernel/memory-policy.cjs as continuityRank(),
  // because it was written twice — here and in dashboard's chat-stream — and
  // two copies of a ranking rule are two rankings waiting to disagree.

  // ── GET /memory/context?q=&budget= — injection payload ──────────────
  // Pinned first, then continuity rank + keyword relevance, recency last.
  router.get('/memory/context', (req, res) => {
    // D2a. This was a second, independently-written copy of the injection
    // policy: character budget, bare `break`, no stated precedence. Both
    // copies had the same two defects (#9, #11) and drifted apart anyway.
    // One module now, consumed here and by dashboard's chat-stream.
    //
    // `budget` stays a TOKEN count. The old query parameter was characters,
    // and the default 4500 characters is roughly 1,100 tokens of prose, so
    // that is the default carried over — the unit is now stated rather than
    // assumed (D1f).
    const budgetTokens = Math.min(Number(req.query.budget) || 1100, 6000);
    const scope = scopeFor(req, res); if (!scope) return;
    const { st, agent } = scope;
    const own = st.loadFor(res); if (!own) return;
    // An agent sees its own memories and, unless it was told not to, the
    // shared ones — exactly what its chat turns are given.
    let memories = own;
    if (agent) {
      memories = own.map((m) => ({ ...m, _scope: 'agent' }));
      if (agent.sharedMemory !== false) {
        const shared = storeAt(MEM_DIR).loadFor(res); if (!shared) return;
        memories = memories.concat(shared.map((m) => ({ ...m, _scope: 'shared' })));
      }
    }
    const selection = memoryPolicy.selectForInjection({
      memories,
      budgetTokens,
      query: String(req.query.q || ''),
    });
    res.json({
      text: selection.text,
      count: selection.injected,
      // What did not make it in, and why there is a number at all: a silent
      // eviction and a store with nothing in it looked identical from here.
      considered: selection.considered,
      dropped: selection.dropped,
      disabled: selection.disabled,
      tokensUsed: selection.tokensUsed,
      budget: budgetTokens,
      budgetUnit: 'tokens',
      // A Local only agent's memory is not read back into the terminal's
      // conversation, which may go to a cloud model (commandNarrator).
      ...(agent && agent.privacy === 'local-only' ? { modelText: null } : {}),
    });
  });

  // ── POST /memory/distill — transcript → typed candidate memories ────
  router.post('/memory/distill', async (req, res) => {
    if (!kernelLLM) return res.status(503).json({ error: 'kernelLLM unavailable' });
    const scope = scopeFor(req, res); if (!scope) return;
    const { st, agent } = scope;
    const folder = agent ? agent.folder : agentsKernel.SELF_FOLDER;
    // An agent's distil runs on that agent's model and privacy — the
    // operator's own AEON's too (scopeFor names no agent for it).
    const caller = agent || agentsKernel.get(VAULT, agentsKernel.SELF_ID);
    const callerLocal = caller?.privacy === 'local-only';
    let agentList = null;
    const allAgents = () => {
      if (!agentList) { try { agentList = agentsKernel.list(VAULT, { withStats: false }); } catch { agentList = []; } }
      return agentList;
    };
    let transcript = req.body?.transcript;
    // The terminal's DISTIL button sends its live turns, each tagged with the
    // agent it was with, so the turns a Local only agent had are left out
    // here unless this distil runs Local only too. Same transcript shape as a
    // saved chat's, so "already distilled" holds across both buttons.
    if (!transcript && Array.isArray(req.body?.messages)) {
      const turns = agentsKernel.shareableTurns(req.body.messages, caller, allAgents())
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant'));
      if (!turns.length) {
        return res.status(400).json({
          ok: false, code: 'local_only',
          error: 'Nothing to distil: every turn of this chat was with an agent set to Local only, and this distil does not run Local only.',
        });
      }
      transcript = sessionTranscript(turns);
    }
    // Provenance rides on every distilled memory: cite the transcript span (or
    // caller-supplied refs) so no memory is ever flat/no-provenance.
    let refs = Array.isArray(req.body?.refs) ? req.body.refs.slice(0, 5) : null;
    if (transcript && !refs) {
      refs = [{ kind: 'transcript', sha: crypto.createHash('sha256').update(String(transcript)).digest('hex').slice(0, 12), at: new Date().toISOString() }];
    }
    // The saved chat a transcript was read from, named in the reply so the
    // operator can see WHICH conversation was distilled. Null when the caller
    // sent its own transcript or the legacy history file was used.
    let usedSession = null;
    // Where the transcript comes from when the caller sent none:
    //   1. the operator's saved chat sessions (newest, or `sessionId`), the
    //      folder dashboard/api/chat.cjs writes beside this memory folder;
    //   2. the legacy terminal history file, for installs that still write it.
    // The panel's button posts an empty body, and that file does not exist on
    // a normal install — so it used to answer "nothing to distill" while a
    // long conversation sat saved on disk.
    if (!transcript) {
      try {
        const sessionsDir = path.join(path.dirname(st.dir), 'chat_sessions');
        const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
        if (!files.length) throw new Error('no saved sessions');
        // Compared with values only — never joined into a path — so it cannot
        // reach outside the folder.
        const wanted = typeof req.body?.sessionId === 'string' ? req.body.sessionId : null;
        // A chat with an agent set to Local only is not sent to a distil that
        // may run on a cloud model: every agent's chats are saved in this one
        // folder, and the newest is not necessarily the caller's own. Nor are
        // a Local only agent's turns in a chat that switched agents.
        const withheldWith = (rec) => {
          if (callerLocal) return null;
          const owner = agentsKernel.get(VAULT, (rec && !Array.isArray(rec) && rec.agent) || agentsKernel.SELF_ID, allAgents());
          return owner && owner.privacy === 'local-only' ? owner : null;
        };
        let best = null;
        let withheld = null;
        for (const f of files) {
          let rec;
          try { rec = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8')); } catch { continue; }
          const all = Array.isArray(rec) ? rec : (rec?.messages || []);
          if (!Array.isArray(all) || !all.length) continue;
          if (wanted && rec?.id !== wanted && f !== `${wanted}.json`) continue;
          const owner = withheldWith(rec);
          if (owner) { withheld = withheld || owner; continue; }
          const msgs = agentsKernel.shareableTurns(all, caller, allAgents());
          if (!msgs.length) continue;
          const t = Date.parse(rec?.updatedAt || rec?.savedAt);
          const rank = Number.isFinite(t) ? t : -Infinity;
          if (!best || rank > best.rank) best = { f, rec, msgs, rank };
        }
        if (!best && wanted && withheld) {
          return res.status(409).json({
            ok: false, code: 'local_only',
            error: `That chat is with ${withheld.name}, which is set to Local only, so it is not sent to the model this distil runs on.`,
          });
        }
        if (!best) {
          throw new Error(wanted ? 'that session has no messages'
            : withheld ? 'every saved session is empty or with an agent set to Local only' : 'every saved session is empty');
        }
        // Both sides of the conversation, on purpose. R09 keeps assistant
        // output out of the document index so the model's own words never
        // come back as evidence; a distilled memory is a short item the
        // operator sees, edits or deletes, with a ref to its chat. Dropping
        // the assistant turns would usually drop half of what was agreed.
        transcript = sessionTranscript(best.msgs);
        usedSession = best.rec?.name || best.f;
        refs = [{ kind: 'chat-session', file: `Agents/${folder}/chat_sessions/${best.f}`, span: `last-${Math.min(best.msgs.length, 30)}-turns`, at: new Date().toISOString() }];
      } catch (sessionErr) {
        try {
          if (!TERMINAL_HISTORY_FILE) throw new Error('TERMINAL_HISTORY_FILE not injected');
          const h = JSON.parse(fs.readFileSync(TERMINAL_HISTORY_FILE, 'utf8'));
          const msgs = Array.isArray(h) ? h : h.messages || [];
          if (!Array.isArray(msgs) || !msgs.length) throw new Error('terminal history is empty');
          transcript = msgs.slice(-30).map(m => `${m.role}: ${String(m.content).slice(0, 400)}`).join('\n');
          refs = [{ kind: 'terminal-history', file: 'db/aeon_terminal_history.json', span: `last-${Math.min(msgs.length, 30)}-turns`, at: new Date().toISOString() }];
        } catch (historyErr) {
          return res.status(400).json({
            ok: false,
            error: 'Nothing to distill. No transcript was sent, '
              + `no saved chat session could be read (${sessionErr.message}), `
              + `and the terminal history file is unavailable (${historyErr.message}). `
              + 'Send a message in the terminal first, or pass a transcript.',
          });
        }
      }
    }
    // Once per unchanged conversation. The INPUT is fingerprinted, not the
    // output: three presses on one chat once stored 13 memories — five facts,
    // each reworded — because a model asked twice words its answer
    // differently. Fuzzy matching on the stored text found 2 of those 9
    // repeats and blocked one genuine memory, and a blocked memory is simply
    // lost where an extra one can be deleted. The transcript is what really
    // recurs, so an exact fingerprint of it never blocks new material: once
    // the chat grows, the fingerprint changes and a distil runs again.
    // SHA-256, first 16 hex characters, over the transcript as resolved —
    // existing ledgers are keyed this way, so the derivation must not change.
    const fingerprint = crypto.createHash('sha256').update(String(transcript)).digest('hex').slice(0, 16);
    const already = req.body?.force ? null : st.readLedger().find((e) => e && e.sha === fingerprint);
    if (already) {
      return res.json({
        ok: true, added: [], candidates: 0, session: usedSession, alreadyDistilled: true,
        message: `Nothing new — this conversation was distilled ${agoInWords(already.at)}, and nothing has been said since. `
          + 'Keep chatting and distil again, or pass force to run it anyway.',
      });
    }
    const prompt = `Distill durable memories from this operator/VP terminal session. Prefer the operator's working artifacts over chit-chat:
- outline: a scoped structure/plan that was settled
- algorithm: logic or a flow that was decided
- decision: a choice made and WHY (so it is never re-litigated)
- milestone: a concrete external result
- fact/preference/project: anything else durable about the operator or system
Return ONLY a JSON array: [{"text":"...","type":"outline|algorithm|decision|milestone|null","category":"fact|identity|preference|contact|project|goal","title":"short label"}]. Max 5. Empty array if nothing durable.

TRANSCRIPT:
${String(transcript).slice(0, 8000)}`;
    // A store that cannot be read cannot be added to — say so before paying
    // for a model call whose results would have nowhere to go.
    if (!st.loadFor(res)) return;
    try {
      const out = await kernelLLM(prompt, { role: 'chat', background: true, max_tokens: 2048, ...agentsKernel.callOptions(caller) });
      const raw = (typeof out === 'string' ? out : out?.text || '') + '';
      // No list in the reply is a failed run, not an empty one. It read as
      // "[]", the transcript was recorded as distilled, and every later click
      // answered "already distilled" — the memories in a reply written as
      // prose or a numbered list were lost, and the conversation could never
      // be distilled again without `force`, which no button sends. Not
      // recorded, so the next click asks again.
      const list = raw.match(/\[[\s\S]*\]/);
      if (!list) {
        return res.status(502).json({
          ok: false,
          error: 'distill failed: the model did not answer with the list of memories it was asked for, so nothing was saved. '
            + 'Try again, or assign a different model to the chat role.',
        });
      }
      const arr = JSON.parse(list[0]);
      // A list with nothing usable in it is the same failed run. A small model
      // that answered ["fact one","fact two"] (strings, not {text} objects) had
      // every item skipped, the transcript recorded, and the conversation
      // locked. A plain string is taken as the memory's text; a list where no
      // entry carries text at all is refused unrecorded. "[]", and entries that
      // are only too short or already known, stay the real "nothing durable".
      const usable = arr
        .map(c => (typeof c === 'string' ? { text: c } : c))
        .filter(c => c && typeof c === 'object' && typeof c.text === 'string' && c.text.trim());
      if (arr.length && !usable.length) {
        return res.status(502).json({
          ok: false,
          error: `distill failed: the model answered with ${arr.length} item(s) but none carried the memory text it was asked for, so nothing was saved. `
            + 'Try again, or assign a different model to the chat role.',
        });
      }
      const all = st.load();
      const added = [];
      for (const c of usable.slice(0, 5)) {
        if (c.text.trim().length < 10) continue;
        if (all.find(m => m.text.trim().toLowerCase() === c.text.trim().toLowerCase())) continue;
        const m = {
          id: newId(), text: c.text.trim(), category: c.category || 'fact',
          type: ['outline', 'algorithm', 'decision', 'milestone'].includes(c.type) ? c.type : null,
          title: c.title || null, tags: [], pinned: false, active: newMemoriesOn(),
          timestamp: Date.now(), source: 'distill', refs: refs || [],
        };
        all.push(m); st.mdMirror(m); added.push(m);
      }
      if (added.length) { st.save(all); requestIndex('memory-distill'); }
      // Recorded even when nothing was added: asking again about the same
      // transcript would only come back empty again, at the price of a call.
      st.recordDistilled(fingerprint, added.length);
      res.json({ ok: true, added, candidates: usable.length, session: usedSession });
    } catch (e) {
      // The store's 503 is ours to pass on. A status on anything else belongs
      // to whoever threw it — a provider's 401 or 429 surfacing through
      // kernelLLM — and is not this route's answer: a 401 here reads as "your
      // AEON session ended" to every client.
      res.status(e.memoryStore ? e.status : 500).json({ error: 'distill failed: ' + e.message });
    }
  });


  // ── Agents ──────────────────────────────────────────────────────────
  // Each agent is a folder under Vault/Agents with its own memory; the
  // operator's own AEON (Agents/Aeon) holds the shared memory every agent
  // reads. Created here, called in the terminal with /agent <name> or by
  // name ("scout come online"), listed under Recent Agent Missions.
  const agentLine = (a) => {
    const model = a.model ? `${a.model.provider}${a.model.model ? ` · ${a.model.model}` : ''}` : 'Settings decides';
    return `${a.self ? '★ ' : '- '}${a.name}${a.self ? ' (your AEON)' : ''} — ${model}${a.privacy === 'local-only' ? ' · local only' : ''}`
      + ` · ${a.memoryCount ?? '?'} memories${a.lastActiveAt ? ` · active ${agoInWords(a.lastActiveAt)}` : ''}`;
  };

  router.get('/agents', (_req, res) => {
    try {
      const agents = agentsKernel.list(VAULT);
      res.json({
        ok: true, agents, count: agents.length,
        text: `${agents.map(agentLine).join('\n')}\n\n/agent <name> to talk to one · create agents in Memory Core`,
        verbatim: true,
      });
    } catch (e) { agentErr(res, e); }
  });

  router.post('/agents', (req, res) => {
    try {
      const agent = agentsKernel.create(VAULT, req.body || {});
      requestIndex('agent-create');
      res.json({ ok: true, agent, text: `Agent ${agent.name} created — say "${agent.name.toLowerCase()} come online" or /agent ${agent.name.toLowerCase()}.` });
    } catch (e) { agentErr(res, e); }
  });

  router.put('/agents/:id', (req, res) => {
    try {
      const agent = agentsKernel.update(VAULT, req.params.id, req.body || {});
      // Local only takes the agent's folder out of the Second Brain index on
      // this scan; Roulette puts it back.
      requestIndex('agent-update');
      res.json({ ok: true, agent });
    } catch (e) { agentErr(res, e); }
  });

  router.delete('/agents/:id', (req, res) => {
    try {
      const out = agentsKernel.remove(VAULT, req.params.id);
      requestIndex('agent-remove');
      res.json({ ok: true, ...out, text: `${out.name} removed. Its memory and chats were moved to ${out.movedTo}, not deleted.` });
    } catch (e) { agentErr(res, e); }
  });

  // ── An agent's working files (3.3, src/kernel/agentWorkspace.cjs) ─────
  // Its scratchpad (its own notes, shown to it every turn, at most 2,000
  // characters: refused over that, never cut) and its handoffs (written by
  // the agent with /handoff; the newest (its first 1,500 characters) is shown to it on every turn until it
  // writes a newer one; kept, never deleted). Neither is indexed: they are a model's words.
  const workspaceErr = (res, e) => res.status(e.status || 500).json({ ok: false, error: e.message, ...(e.code ? { code: e.code } : {}) });
  const agentOr404 = (ref, res) => {
    const a = agentsKernel.get(VAULT, ref);
    if (!a) res.status(404).json({ ok: false, error: `No agent called "${ref}". GET /api/agents lists them.` });
    return a;
  };

  router.get('/agents/:id/scratchpad', (req, res) => {
    const a = agentOr404(req.params.id, res); if (!a) return;
    try {
      res.json({ ok: true, agent: { id: a.id, name: a.name }, ...agentWorkspace.readScratchpad(VAULT, a) });
    } catch (e) { workspaceErr(res, e); }
  });

  router.put('/agents/:id/scratchpad', (req, res) => {
    const a = agentOr404(req.params.id, res); if (!a) return;
    const content = req.body?.content;
    if (typeof content !== 'string') return res.status(400).json({ ok: false, error: 'Send the scratchpad as { content: "..." }.' });
    try {
      const w = agentWorkspace.writeScratchpad(VAULT, a, content, { mode: 'replace' });
      res.json({ ok: true, chars: w.chars, max: w.max, path: w.path,
        text: `${a.name}'s scratchpad saved (${w.chars.toLocaleString('en-US')} / ${w.max.toLocaleString('en-US')} characters).` });
    } catch (e) { workspaceErr(res, e); }
  });

  router.get('/agents/:id/handoffs', (req, res) => {
    const a = agentOr404(req.params.id, res); if (!a) return;
    try {
      res.json({ ok: true, agent: { id: a.id, name: a.name }, ...agentWorkspace.listHandoffs(VAULT, a, { limit: req.query?.limit }) });
    } catch (e) { workspaceErr(res, e); }
  });

  // /handoff — the agent the terminal is talking to writes its handoff from
  // this conversation (the dispatcher forwards `agent` and `history`). A
  // Local only agent's handoff is written by a local model or not at all.
  router.post('/agents/handoff', async (req, res) => {
    const { agent: ref = null, history = [], note = '' } = req.body || {};
    const a = agentOr404(ref || agentsKernel.SELF_ID, res); if (!a) return;
    try {
      const out = await agentWorkspace.writeHandoff({
        vaultRoot: VAULT, agent: a, history: Array.isArray(history) ? history : [],
        note: typeof note === 'string' ? note : '', kernelLLM, source: '/handoff',
      });
      res.json({ ok: true, path: out.rel, at: out.at, text: `Handoff saved to ${out.rel}\n\n${out.text}` });
    } catch (e) { workspaceErr(res, e); }
  });
  return router;
};
