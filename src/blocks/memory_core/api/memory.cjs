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
const crypto = require('crypto');

module.exports = function createMemoryRouter(deps) {
  const router = express.Router();
  const { kernelLLM, VAULT_ROOT } = deps;

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
    if (q) { const s = String(q).toLowerCase(); out = out.filter(m => (m.text + ' ' + (m.title || '')).toLowerCase().includes(s)); }
    res.json({ memories: out, count: out.length, dir: MEM_DIR });
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
    if (dupe) return res.json({ ok: true, memory: dupe, deduped: true });
    const m = {
      id: newId(), text: normalized.text,
      ...(normalized.changed ? { originalText: String(text).trim() } : {}),
      category: category || 'fact', type: type || null, title: title || null,
      tags: Array.isArray(tags) ? tags : [], pinned: !!pinned,
      timestamp: Date.now(), source: source || 'api',
      refs: Array.isArray(refs) ? refs.slice(0, 5) : [],
    };
    all.push(m); save(all); mdMirror(m);
    res.json({
      ok: true, memory: m, normalized: normalized.changed,
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
      if (req.body[k] !== undefined) m[k] = req.body[k];
    }
    save(all); mdMirror(m);
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
    if (!transcript) {
      // Pull the tail of terminal history if none supplied
      try {
        const HIST = path.join(__dirname, '..', '..', '..', '..', 'db', 'aeon_terminal_history.json');
        const h = JSON.parse(fs.readFileSync(HIST, 'utf8'));
        const msgs = Array.isArray(h) ? h : h.messages || [];
        transcript = msgs.slice(-30).map(m => `${m.role}: ${String(m.content).slice(0, 400)}`).join('\n');
        refs = [{ kind: 'terminal-history', file: 'db/aeon_terminal_history.json', span: `last-${Math.min(msgs.length, 30)}-turns`, at: new Date().toISOString() }];
      } catch { return res.status(400).json({ error: 'no transcript supplied and terminal history unreadable' }); }
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
      if (added.length) save(all);
      res.json({ ok: true, added, candidates: arr.length });
    } catch (e) { res.status(500).json({ error: 'distill failed: ' + e.message }); }
  });

  return router;
};
