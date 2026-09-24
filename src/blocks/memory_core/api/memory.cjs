/**
 * memory_core — VP's persistent memory store.
 *
 * The old memory block was removed but two live consumers still expect it:
 *   - dashboard/api/chat-stream.cjs injects memories into every terminal chat
 *   - its auto-extract loop POSTs new facts to /api/memory/add
 * This block owns that store again, vault-resident so the operator can see
 * every memory as a file in Aeon Matrix.
 *
 * Store: Vault/Agents/Aeon/memory/memories.json  (canonical array)
 *        Vault/Agents/Aeon/memory/<id>.md        (operator-readable mirror)
 * Record: { id, text, category, type, title, tags, pinned, timestamp, source, refs }
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
const sections = require('../../../kernel/memorySections.cjs');
const crypto = require('crypto');

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

  const MEM_DIR = path.join(VAULT_ROOT || path.join(__dirname, '..', '..', 'aeon_matrix', 'data', 'Vault'), 'Agents', 'Aeon', 'memory');
  const STORE = path.join(MEM_DIR, 'memories.json');
  try { if (!fs.existsSync(MEM_DIR)) fs.mkdirSync(MEM_DIR, { recursive: true }); } catch {}

  const load = () => {
    try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch { return []; }
  };
  const save = (all) => fs.writeFileSync(STORE, JSON.stringify(all, null, 2));

  const mdMirror = (m) => {
    const fm = [
      '---',
      `id: ${m.id}`,
      `category: ${m.category || 'fact'}`,
      m.type ? `type: ${m.type}` : null,
      m.title ? `title: ${JSON.stringify(m.title)}` : null,
      (m.tags && m.tags.length) ? `tags: [${m.tags.join(', ')}]` : null,
      `pinned: ${!!m.pinned}`,
      `created: ${new Date(m.timestamp).toISOString()}`,
      m.source ? `source: ${m.source}` : null,
      (m.refs && m.refs.length) ? `refs: ${JSON.stringify(m.refs)}` : null,
      '---',
    ].filter(Boolean).join('\n');
    try { fs.writeFileSync(path.join(MEM_DIR, `${m.id}.md`), `${fm}\n\n${m.text}\n`); } catch {}
  };
  const mdRemove = (id) => { try { fs.unlinkSync(path.join(MEM_DIR, `${id}.md`)); } catch {} };

  const newId = () => crypto.randomBytes(6).toString('hex');

  // ── GET /memory — full list (newest first, pinned float) ────────────
  router.get('/memory', (req, res) => {
    const all = load().sort((a, b) => (b.pinned - a.pinned) || (b.timestamp - a.timestamp));
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
    res.json({ memories: out, count: out.length, dir: MEM_DIR, ...(section ? { section } : {}), text: sections.renderList(out), verbatim: true });
  });

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

    const all = load();
    // Dedupe: identical text is a no-op, not a second copy
    const dupe = all.find(m => m.text.trim().toLowerCase() === normalized.text.toLowerCase());
    // `text` is what the terminal chip prints. Without it /remember showed the
    // record as JSON, and a repeat looked exactly like a save.
    if (dupe) return res.json({ ok: true, memory: dupe, deduped: true, text: `Already in memory — nothing new saved: ${dupe.text}` });
    const m = {
      id: newId(), text: normalized.text,
      ...(normalized.changed ? { originalText: String(text).trim() } : {}),
      category: category || 'fact', type: type || null, title: title || null,
      tags: Array.isArray(tags) ? tags : [], pinned: !!pinned,
      timestamp: Date.now(), source: source || 'api',
      refs: Array.isArray(refs) ? refs.slice(0, 5) : [],
    };
    all.push(m); save(all); mdMirror(m);
    requestIndex('memory-add');
    const said = [`Saved to memory (${m.category}): ${m.text}`];
    if (normalized.changed) said.push(`Reworded from "${m.originalText}" so it reads as being about you when AEON recalls it.`);
    if (normalized.residualPerson) said.push('It still says "I" or "you" somewhere; recalled into a prompt, that reads as the model. Consider editing it in Memory Core.');
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
    const all = load();
    const m = all.find(x => x.id === req.params.id);
    if (!m) return res.status(404).json({ error: 'not found' });
    for (const k of ['text', 'category', 'type', 'title', 'tags', 'pinned']) {
      if ((req.body || {})[k] !== undefined) m[k] = req.body[k];
    }
    save(all); mdMirror(m);
    requestIndex('memory-edit');
    res.json({ ok: true, memory: m });
  });

  // ── POST /memory/:id/pin — toggle ───────────────────────────────────
  router.post('/memory/:id/pin', (req, res) => {
    const all = load();
    const m = all.find(x => x.id === req.params.id);
    if (!m) return res.status(404).json({ error: 'not found' });
    m.pinned = !m.pinned;
    save(all); mdMirror(m);
    res.json({ ok: true, pinned: m.pinned });
  });

  // ── DELETE /memory/:id ──────────────────────────────────────────────
  router.delete('/memory/:id', (req, res) => {
    const all = load();
    const idx = all.findIndex(x => x.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });
    const [gone] = all.splice(idx, 1);
    save(all); mdRemove(gone.id);
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
    const selection = memoryPolicy.selectForInjection({
      memories: load(),
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
      tokensUsed: selection.tokensUsed,
      budget: budgetTokens,
      budgetUnit: 'tokens',
    });
  });

  // ── POST /memory/distill — transcript → typed candidate memories ────
  router.post('/memory/distill', async (req, res) => {
    if (!kernelLLM) return res.status(503).json({ error: 'kernelLLM unavailable' });
    let transcript = req.body?.transcript;
    // Provenance rides on every distilled memory: cite the transcript span (or
    // caller-supplied refs) so no memory is ever flat/no-provenance.
    let refs = Array.isArray(req.body?.refs) ? req.body.refs.slice(0, 5) : null;
    if (transcript && !refs) {
      refs = [{ kind: 'transcript', sha: crypto.createHash('sha256').update(String(transcript)).digest('hex').slice(0, 12), at: new Date().toISOString() }];
    }
    // WHERE THE CONVERSATION ACTUALLY IS.
    //
    // "Distill session" sends an empty body, so this fell straight through to
    // db/aeon_terminal_history.json — a file only host_os writes, and which
    // does not exist on a normal install. The operator got "no transcript
    // supplied and terminal history unreadable" over a terminal visibly full
    // of conversation.
    //
    // The conversation is saved, just somewhere else: the terminal writes each
    // session to Vault/Agents/Aeon/chat_sessions/<id>.json. So look there
    // first, newest by updatedAt, which IS the session the operator is sitting
    // in. A caller that knows better may name one with `sessionId`.
    let usedSession = null;
    if (!transcript) {
      try {
        const CHAT_DIR = path.join(MEM_DIR, '..', 'chat_sessions');
        const wanted = typeof req.body?.sessionId === 'string' ? req.body.sessionId : null;
        const files = fs.readdirSync(CHAT_DIR).filter(f => f.endsWith('.json'));
        if (!files.length) throw new Error('no saved sessions');
        let pick = null;
        for (const f of files) {
          let j; try { j = JSON.parse(fs.readFileSync(path.join(CHAT_DIR, f), 'utf8')); } catch { continue; }
          const msgs = Array.isArray(j) ? j : (j.messages || []);
          if (!msgs.length) continue;
          if (wanted && j.id !== wanted && f !== `${wanted}.json`) continue;
          const at = Date.parse(j.updatedAt || j.savedAt || '') || 0;
          if (!pick || at > pick.at) pick = { at, file: f, name: j.name || f, msgs };
        }
        if (!pick) throw new Error(wanted ? 'that session has no messages' : 'every saved session is empty');
        // Assistant turns are included: the meaning of an exchange usually
        // lives in the exchange. They are safe here in a way they are NOT safe
        // in the document index (ingest.cjs, doctrine R09) because a distilled
        // memory is written, reviewed and owned by the operator, and carries a
        // ref back to the session it came from.
        transcript = pick.msgs.slice(-30)
          .map(m => `${m.role}: ${String(m.content || '').slice(0, 400)}`).join('\n');
        usedSession = pick.name;
        refs = [{ kind: 'chat-session', file: `Agents/Aeon/chat_sessions/${pick.file}`,
                  span: `last-${Math.min(pick.msgs.length, 30)}-turns`, at: new Date().toISOString() }];
      } catch (sessionErr) {
        // The old path, kept: an install where host_os does write that file
        // should not lose a working button.
        try {
          if (!TERMINAL_HISTORY_FILE) throw new Error('TERMINAL_HISTORY_FILE not injected');
          const h = JSON.parse(fs.readFileSync(TERMINAL_HISTORY_FILE, 'utf8'));
          const msgs = Array.isArray(h) ? h : h.messages || [];
          if (!msgs.length) throw new Error('terminal history is empty');
          transcript = msgs.slice(-30).map(m => `${m.role}: ${String(m.content).slice(0, 400)}`).join('\n');
          refs = [{ kind: 'terminal-history', file: 'db/aeon_terminal_history.json', span: `last-${Math.min(msgs.length, 30)}-turns`, at: new Date().toISOString() }];
        } catch (histErr) {
          // Say what was looked for and where. The old sentence named a file
          // the operator has never heard of and gave them nothing to do.
          return res.status(400).json({
            error: 'Nothing to distill. No transcript was sent, no saved chat session could be read '
              + `(${sessionErr.message}), and the terminal history file is unavailable (${histErr.message}). `
              + 'Send a message in the terminal first, or pass a transcript.',
          });
        }
      }
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
    try {
      const out = await kernelLLM(prompt, { role: 'chat', background: true, max_tokens: 2048 });
      const raw = (typeof out === 'string' ? out : out?.text || '') + '';
      const arr = JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] || '[]');
      const all = load();
      const added = [];
      for (const c of arr.slice(0, 5)) {
        if (!c.text || c.text.length < 10) continue;
        if (all.find(m => m.text.trim().toLowerCase() === c.text.trim().toLowerCase())) continue;
        const m = {
          id: newId(), text: c.text.trim(), category: c.category || 'fact',
          type: ['outline', 'algorithm', 'decision', 'milestone'].includes(c.type) ? c.type : null,
          title: c.title || null, tags: [], pinned: false,
          timestamp: Date.now(), source: 'distill', refs: refs || [],
        };
        all.push(m); mdMirror(m); added.push(m);
      }
      if (added.length) { save(all); requestIndex('memory-distill'); }
      // Name the session that was read. A button that silently distils
      // something is a button nobody trusts twice.
      res.json({ ok: true, added, candidates: arr.length, session: usedSession });
    } catch (e) { res.status(500).json({ error: 'distill failed: ' + e.message }); }
  });

  return router;
};
