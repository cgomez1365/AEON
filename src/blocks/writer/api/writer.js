const fs = require('fs');
const path = require('path');

module.exports = (app, deps) => {
  const { supabase, getBlockDataFile, kernelLLM, VAULT_ROOT } = deps;
  const isVercel = !!process.env.VERCEL;
  // On Vercel /tmp is the only writable dir — ephemeral per-invocation; Supabase
  // is the source of truth. Locally, drafts live in the PRIVATE data root
  // (data/writer/), NOT the Vault: a document editor's autosaved drafts must
  // never be auto-indexed into the Matrix / Second Brain. Use the explicit
  // "Push to Memory" action to deliberately promote a finished piece into recall.
  const DOCS_DIR = isVercel
    ? '/tmp/aeon_writer'
    : (getBlockDataFile ? getBlockDataFile('writer') : path.join(__dirname, '..', '..', '..', '..', 'data', 'writer'));
  const STYLE_FILE = path.join(DOCS_DIR, '_style-profile.json');
  try { fs.mkdirSync(DOCS_DIR, { recursive: true }); } catch {}

  function loadDocs() {
    try { return JSON.parse(fs.readFileSync(path.join(DOCS_DIR, '_index.json'), 'utf8')); }
    catch { return []; }
  }
  function saveDocs(docs) { fs.writeFileSync(path.join(DOCS_DIR, '_index.json'), JSON.stringify(docs, null, 2)); }

  function loadStyle() {
    if (!fs.existsSync(STYLE_FILE)) return null;
    try { return JSON.parse(fs.readFileSync(STYLE_FILE, 'utf8')); } catch { return null; }
  }

  function styleSystemSnippet(profile) {
    if (!profile) return '';
    return `\n\nWRITING STYLE PROFILE (match this author's voice):\n${profile.summary}\nKey traits: ${profile.traits.join(' · ')}`;
  }

  // Writer used to POST to its own server at /api/kernel/llm over loopback. That
  // request carried no session, so with the auth guard armed the kernel answered
  // 401 — and the old client never read resp.statusCode, so the error body parsed
  // as a result. result.text was undefined, every handler fell back to '', and the
  // editor wrote that empty string over the user's document. kernelLLM is already
  // injected here (manifest declares permissions.ai: true); call it directly. An
  // in-process block does not authenticate to itself over the network.
  //
  // Returns a string. Throws on failure — callers must surface, never substitute
  // empty content for an error (that substitution WAS the data-loss bug).
  async function llm(prompt, opts = {}) {
    if (typeof kernelLLM !== 'function') {
      const e = new Error('AI is unavailable: this block was mounted without the kernel LLM service.');
      e.aiUnavailable = true;
      throw e;
    }
    const out = await kernelLLM(prompt, { role: 'creative', ...opts });
    const text = typeof out === 'string' ? out : out?.text;
    if (typeof text !== 'string' || text.trim() === '') {
      const e = new Error('AI returned no content. Check the Creative model in Settings.');
      e.aiUnavailable = true;
      throw e;
    }
    return text;
  }

  // One shape for every AI failure, so the UI can always say something true.
  function aiError(res, e) {
    const status = e.needsLocalConfirm ? 409 : (e.noProviderAvailable || e.aiUnavailable) ? 503 : 502;
    return res.status(status).json({
      error: e.message || 'AI request failed',
      aiUnavailable: !!(e.aiUnavailable || e.noProviderAvailable),
    });
  }

  // ── DOCS CRUD ────────────────────────────────────────────────────────────────

  app.get('/api/writer/docs', async (req, res) => {
    if (isVercel && supabase) {
      try {
        const { data } = await supabase.from('writer_docs')
          .select('id, title, tags, updated_at')
          .order('updated_at', { ascending: false })
          .limit(100);
        if (data) return res.json(data.map(d => ({ id: d.id, title: d.title, tags: d.tags || [], updated: new Date(d.updated_at).getTime(), size: 0 })));
      } catch {}
    }
    res.json(loadDocs());
  });

  app.get('/api/writer/doc/:id', async (req, res) => {
    if (isVercel && supabase) {
      try {
        const { data } = await supabase.from('writer_docs').select('id, title, content').eq('id', req.params.id).single();
        if (data) return res.json({ id: data.id, content: data.content || '' });
      } catch {}
    }
    const fp = path.join(DOCS_DIR, `${req.params.id}.md`);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
    res.json({ id: req.params.id, content: fs.readFileSync(fp, 'utf8') });
  });

  app.post('/api/writer/doc', async (req, res) => {
    const { id, title, content, tags } = req.body || {};
    const docId = id || `doc-${Date.now().toString(36)}`;
    const now = Date.now();

    // ── Version snapshot — every save preserves what it overwrites ──
    // (keeps the last 25 versions per doc; restore via /api/writer/versions)
    try {
      const prevPath = path.join(DOCS_DIR, `${docId}.md`);
      if (fs.existsSync(prevPath)) {
        const prev = fs.readFileSync(prevPath, 'utf8');
        if (prev && prev !== (content || '')) {
          const vDir = path.join(DOCS_DIR, 'versions', docId);
          fs.mkdirSync(vDir, { recursive: true });
          fs.writeFileSync(path.join(vDir, `${now}.md`), prev);
          const versions = fs.readdirSync(vDir).filter(f => f.endsWith('.md')).sort();
          while (versions.length > 25) fs.unlinkSync(path.join(vDir, versions.shift()));
        }
      }
    } catch { /* versioning must never block a save */ }

    fs.writeFileSync(path.join(DOCS_DIR, `${docId}.md`), content || '');

    const docs = loadDocs().filter(d => d.id !== docId);
    docs.unshift({ id: docId, title: title || 'Untitled', tags: tags || [], updated: now, size: (content || '').length });
    saveDocs(docs);
    // NOTE: Writer deliberately does NOT publish doc state to the Vault/Matrix —
    // drafts stay private in data/writer/. Promotion to memory is explicit only.
    // Supabase mirror — best-effort, never blocks the local save
    if (supabase) {
      supabase.from('writer_docs').upsert({
        id: docId, title: title || 'Untitled', content: content || '',
        tags: tags || [], updated_at: new Date(now).toISOString(),
      }).then(() => {}).catch(() => {});
    }
    res.json({ ok: true, id: docId });
  });

  app.delete('/api/writer/doc/:id', async (req, res) => {
    if (isVercel && supabase) {
      try { await supabase.from('writer_docs').delete().eq('id', req.params.id); } catch {}
    } else {
      try { fs.unlinkSync(path.join(DOCS_DIR, `${req.params.id}.md`)); } catch {}
      const _docsAfterDelete = loadDocs().filter(d => d.id !== req.params.id);
      saveDocs(_docsAfterDelete);
    }
    res.json({ ok: true });
  });

  // ── WRITING DNA / STYLE ──────────────────────────────────────────────────────

  app.get('/api/writer/style', (req, res) => {
    const profile = loadStyle();
    res.json({ profile, hasProfile: !!profile });
  });

  app.post('/api/writer/style/analyze', async (req, res) => {
    try {
      const docs = loadDocs();
      const samples = [];
      for (const d of docs.slice(0, 15)) {
        try {
          const fp = path.join(DOCS_DIR, `${d.id}.md`);
          const text = fs.readFileSync(fp, 'utf8');
          if (text.length > 80) samples.push({ title: d.title, text: text.slice(0, 2500) });
        } catch {}
      }
      if (samples.length === 0) return res.status(400).json({ error: 'No documents found. Save some writing first.' });

      const corpus = samples.map(s => `--- ${s.title} ---\n${s.text}`).join('\n\n');
      const text = await llm(
        `Analyze the writing style of these samples and return a JSON object with:
- "summary": 2-3 sentence description of voice and style
- "traits": array of 6-10 style traits
- "formality": casual | semi-formal | formal | academic
- "avgSentenceLength": short | medium | long | varied
- "toneKeywords": 3-5 tone words
Return ONLY valid JSON.\n\nSamples:\n${corpus}`
      );

      let profile;
      try {
        const match = text.match(/\{[\s\S]*\}/);
        profile = JSON.parse(match ? match[0] : text);
      } catch {
        // An unparseable answer is a failed analysis, not an empty profile. The
        // old code wrote a blank fallback to disk, overwriting a good profile
        // with garbage and lighting up "Style DNA" as if it had succeeded.
        return res.status(502).json({ error: 'Could not read a style profile from the model response. Nothing was changed.' });
      }
      if (!profile || typeof profile !== 'object' || !profile.summary) {
        return res.status(502).json({ error: 'Style analysis returned an incomplete profile. Nothing was changed.' });
      }
      profile.traits = Array.isArray(profile.traits) ? profile.traits : [];
      profile.analyzedAt = new Date().toISOString();
      profile.sampleCount = samples.length;
      fs.writeFileSync(STYLE_FILE, JSON.stringify(profile, null, 2));
      res.json({ profile, sampleCount: samples.length });
    } catch (e) { aiError(res, e); }
  });

  // ── GENERATE (write / braindump / continue / stylecheck) ─────────────────────

  app.post('/api/writer/generate', async (req, res) => {
    const { prompt, tone, length, mode = 'write', draft = '' } = req.body || {};
    if (!prompt && mode !== 'continue' && mode !== 'stylecheck') {
      return res.status(400).json({ error: 'prompt is required' });
    }
    try {
      const profile = loadStyle();
      let system, userMsg;

      if (mode === 'braindump') {
        system = `You are an expert writer. The user has given you a raw brain dump. Restructure into coherent, well-organized prose. Preserve every idea. Add structure, clarity, and flow.${styleSystemSnippet(profile)}\nReturn ONLY the restructured prose.`;
        userMsg = prompt;
      } else if (mode === 'continue') {
        system = `You are a writing collaborator. Continue the provided draft naturally — match its tone and direction exactly. Pick up where it left off.${styleSystemSnippet(profile)}\nReturn ONLY the continuation.`;
        userMsg = draft || prompt;
      } else if (mode === 'stylecheck') {
        if (!profile) return res.json({ content: 'No Writing DNA profile found. Use "Analyze My Writing" first.' });
        system = 'You are a literary editor. Compare text against the style profile and give specific feedback. Bullet points preferred.';
        userMsg = `Style profile:\n${profile.summary}\nTraits: ${profile.traits.join(', ')}\n\nText to check:\n\n${draft || prompt}`;
      } else {
        system = `You are an expert writer. Write in a ${tone || 'clear and professional'} tone. Aim for ${length || 'medium'} length.${styleSystemSnippet(profile)}\nReturn only the written content.`;
        userMsg = prompt;
      }

      const content = await llm(`${system}\n\n${userMsg}`);
      res.json({ content, usedStyle: !!profile });
    } catch (e) { aiError(res, e); }
  });

  // ── IMPROVE (improve/expand/shorten/casual/professional/critique) ─────────────

  app.post('/api/writer/improve', async (req, res) => {
    const { text, action = 'improve', selection } = req.body || {};
    if (!text) return res.status(400).json({ error: 'text required' });
    const profile = loadStyle();
    const ACTIONS = {
      improve:      'Improve this text — fix grammar, clarity, flow. Keep the voice.',
      expand:       'Expand with more detail and complete sentences. Keep the tone.',
      shorten:      'Shorten — remove filler, keep every key point. Aim for half the length.',
      casual:       'Rewrite in a casual, warm, conversational tone.',
      professional: 'Rewrite in a formal professional tone. Clear, direct, polished.',
      critique:     'Give honest editorial feedback. Identify weaknesses in tone, clarity, structure. Do NOT rewrite — only give feedback as bullet points.',
    };
    const instr = ACTIONS[action] || ACTIONS.improve;
    const styleNote = profile ? `\nAuthor style traits: ${profile.traits.slice(0, 4).join(', ')}` : '';

    try {
      // llm() throws rather than returning '' — previously a failure here
      // returned { content: '' } with no error key, and the editor wrote that
      // over the whole document. Never return empty content from this route.
      if (selection && selection.trim() && text.includes(selection)) {
        const rewritten = (await llm(`${instr}${styleNote}\n\nReturn ONLY the rewritten fragment:\n\n${selection}`)).trim();
        return res.json({ content: text.replace(selection, rewritten), selectionReplaced: true });
      }
      const content = await llm(`${instr}${styleNote}\n\nReturn ONLY the result:\n\n${text}`);
      res.json({ content });
    } catch (e) { aiError(res, e); }
  });

  // ── CO-WRITE CHAT ────────────────────────────────────────────────────────────

  app.post('/api/writer/cowrite', async (req, res) => {
    const { prompt, draft = '', history = [] } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'prompt required' });
    try {
      const profile = loadStyle();
      const styleNote = profile ? `\nAuthor style: ${profile.summary}` : '';
      const wordCount = draft.trim().split(/\s+/).filter(Boolean).length;
      const draftNote = draft.trim()
        ? `\n\nCURRENT DRAFT (${wordCount} words):\n"""\n${draft.slice(0, 3000)}${draft.length > 3000 ? '\n...[truncated]' : ''}\n"""`
        : '\n\n(No draft yet)';

      const systemMsg = `You are AEON, a creative writing collaborator. You always have access to the user's current draft and help them write, refine, expand, continue, or reflect on it. Be concise and direct.${styleNote}${draftNote}`;

      const historyMsgs = history.flatMap(h => [
        `User: ${h.q}`,
        `Assistant: ${h.a}`
      ]).join('\n');

      const fullPrompt = `${systemMsg}\n\n${historyMsgs ? historyMsgs + '\n\n' : ''}User: ${prompt}\n\nAssistant:`;
      const response = await llm(fullPrompt);
      res.json({ response });
    } catch (e) { aiError(res, e); }
  });

  // ── PUSH DOC TO MEMORY CORE ──────────────────────────────────────────────────
  //
  // Was: wrote a row into <data>/aeon_notes.json and answered `{ ok: true }`
  // unconditionally, with the only write inside a bare `catch {}`. The button
  // said "Saved to Memory" while Memory Core showed 0 MEMORIES — both true about
  // different files. Destination is now Memory Core's own store.
  //
  // MATRIX DECISION (F1d): pushing promotes into Memory Core ONLY — it does not
  // also copy the document into the Vault as a second file. Memory Core already
  // mirrors every record to VAULT_ROOT/Agents/vp/memory/<id>.md
  // (memory_core/api/memory.cjs mdMirror), and aeon_matrix/api/ingest.cjs walks
  // all of VAULT_ROOT, so one push is both a memory and an indexable vault file.
  // A second copy of the same draft would be a second source of truth to keep in
  // sync, and drafts stay private in data/writer/ by design.
  //
  // TRANSPORT: in-process, not loopback HTTP. commandRegistry.cjs and
  // security/api/guardian.cjs forward Authorization/Cookie on their internal
  // fetches because they dispatch to routes only known at runtime; this
  // destination is fixed and known at build time. A loopback call here would
  // build its URL from `process.env.PORT || 3001` and, from a test or a second
  // instance, write into whatever install owns that port. Memory Core resolves
  // its store from the same VAULT_ROOT dep writer is handed, so calling its
  // router directly hits the exact store Memory Core reads.

  // /api/memory/context stops filling at the FIRST record that overruns its
  // budget (memory.cjs `break`), so one novel-length memory would starve every
  // other memory out of the injection payload. The full draft stays in
  // data/writer/ and is cited in refs.
  const MEMORY_TEXT_LIMIT = 2000;

  let _memoryCore = null;
  function memoryCore() {
    if (_memoryCore) return _memoryCore;
    const createMemoryRouter = require('../../memory_core/api/memory.cjs');
    _memoryCore = createMemoryRouter({ VAULT_ROOT, kernelLLM });
    return _memoryCore;
  }

  // Drive one of Memory Core's own routes in-process. No port, no auth gate —
  // the caller already cleared the gate to reach this route. Every outcome
  // resolves to a status + body; nothing is swallowed.
  function callMemory(method, url, body) {
    return new Promise((resolve) => {
      let router;
      try { router = memoryCore(); }
      catch (e) {
        return resolve({ status: 503, body: { reason: 'memory_core_unavailable', error: `Memory Core is not installed on this runtime (${e.message}).` } });
      }
      const req = { method, url, originalUrl: url, headers: {}, body: body || {}, params: {}, query: {} };
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(payload) { resolve({ status: this.statusCode, body: payload }); },
      };
      try {
        router(req, res, (err) => resolve(err
          ? { status: 502, body: { reason: 'memory_core_threw', error: `Memory Core could not write the record: ${err.message}` } }
          : { status: 502, body: { reason: 'memory_core_no_route', error: `Memory Core has no route for ${method} ${url}.` } }));
      } catch (e) {
        resolve({ status: 502, body: { reason: 'memory_core_threw', error: `Memory Core could not write the record: ${e.message}` } });
      }
    });
  }

  app.post('/api/writer/doc/:id/to-memory', async (req, res) => {
    try {
      const fp = path.join(DOCS_DIR, `${req.params.id}.md`);
      if (!fs.existsSync(fp)) return res.status(404).json({ ok: false, reason: 'doc_not_found', error: 'Document not found.' });
      const doc = loadDocs().find(d => d.id === req.params.id);
      const title = doc?.title || 'Writer Draft';
      const raw = fs.readFileSync(fp, 'utf8').trim();
      // Memory Core rejects text under 6 chars; say so here rather than let it
      // come back as an opaque 400.
      if (raw.length < 6) {
        return res.status(400).json({ ok: false, reason: 'doc_too_short', error: 'Nothing to promote — the document is empty.' });
      }

      const truncated = raw.length > MEMORY_TEXT_LIMIT;
      const text = `${title}\n\n${truncated ? `${raw.slice(0, MEMORY_TEXT_LIMIT)}\n…[truncated — full draft in data/writer/${req.params.id}.md]` : raw}`;

      const add = await callMemory('POST', '/memory/add', {
        text, title, category: 'project', type: 'outline', tags: ['writer', 'draft'],
        source: 'writer',
        refs: [{ kind: 'file', file: `data/writer/${req.params.id}.md`, at: new Date().toISOString() }],
      });
      const memoryId = add.body?.memory?.id;
      if (add.status >= 400 || !add.body?.ok || !memoryId) {
        return res.status(add.status >= 400 ? add.status : 502).json({
          ok: false,
          reason: add.body?.reason || 'memory_core_rejected',
          error: add.body?.error || 'Memory Core did not accept the record.',
        });
      }

      // R-05: "saved" is a claim about what is on disk, not about what we sent.
      // Read the store back THROUGH Memory Core before saying ok.
      const list = await callMemory('GET', '/memory', null);
      if (!Array.isArray(list.body?.memories) || !list.body.memories.some(m => m.id === memoryId)) {
        return res.status(502).json({
          ok: false, reason: 'memory_not_persisted',
          error: 'Memory Core accepted the record but it is not in the store.',
        });
      }

      // No aeon_notes mirror any more: that table is the Notes block's, and
      // writing it was the original lie. This route promotes to Memory Core or
      // it reports why it could not.
      res.json({ ok: true, memoryId, deduped: !!add.body.deduped, truncated, store: 'memory_core' });
    } catch (e) {
      res.status(500).json({ ok: false, reason: 'push_failed', error: `Push to Memory Core failed: ${e.message}` });
    }
  });

  // BO-A2d: POST /api/writer/ai is gone. It was labelled "kept for backwards
  // compat" and had no caller anywhere in the tree — the UI uses
  // /api/writer/improve. Proven dead by grep across the repo, then deleted.
};
