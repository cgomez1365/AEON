const fs = require('fs');
const path = require('path');
const { vaultSync } = require('../../../kernel/vaultSync.cjs');

module.exports = (app, deps) => {
  const { supabase, NOTES_FILE, getVaultFile } = deps;
  const isVercel = !!process.env.VERCEL;
  // On Vercel /tmp is the only writable dir — but it's ephemeral per-invocation.
  // Supabase is the source of truth; /tmp is just a within-request cache.
  // Locally, documents live inside the Vault (Vault/blocks/writer/) so Writer
  // gets real long-term storage and every doc is a first-class Matrix node —
  // no separate secrets/ folder, no best-effort mirror to keep in sync.
  const DOCS_DIR = isVercel
    ? '/tmp/aeon_writer'
    : (getVaultFile ? getVaultFile('blocks/writer') : path.join(__dirname, '..', '..', '..', '..', 'secrets', 'documents'));
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

  function callKernelLLM(prompt, role = 'creative') {
    const http = require('http');
    const port = process.env.PORT || 3001;
    const body = JSON.stringify({ prompt, role });
    return new Promise((resolve, reject) => {
      const r = http.request({ hostname: '127.0.0.1', port, path: '/api/kernel/llm', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, (resp) => { let d = ''; resp.on('data', c => d += c); resp.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error(d)); } }); });
      r.on('error', reject);
      r.write(body); r.end();
    });
  }

  function callKernelChat(messages) {
    const http = require('http');
    const port = process.env.PORT || 3001;
    const body = JSON.stringify({ messages });
    return new Promise((resolve, reject) => {
      const r = http.request({ hostname: '127.0.0.1', port, path: '/api/kernel/llm', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, (resp) => { let d = ''; resp.on('data', c => d += c); resp.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error(d)); } }); });
      r.on('error', reject);
      r.write(body); r.end();
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
    try { vaultSync('writer', { docs: { value: docs.length, unit: 'count', context: 'total saved documents' }, last_doc: { value: title || 'Untitled', unit: 'text', context: 'last saved document title' }, last_saved: { value: new Date(now).toISOString(), unit: 'timestamp', context: 'last document save time' }, _summary: `Doc saved: "${title || 'Untitled'}" (${docs.length} total)` }); } catch(e) { /* non-critical */ }
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
      try { vaultSync('writer', { docs: { value: _docsAfterDelete.length, unit: 'count', context: 'total saved documents' }, last_saved: { value: new Date().toISOString(), unit: 'timestamp', context: 'last document operation time' }, _summary: `Doc deleted (${_docsAfterDelete.length} remaining)` }); } catch(e) { /* non-critical */ }
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
      const result = await callKernelLLM(
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
        const match = (result.text || '').match(/\{[\s\S]*\}/);
        profile = JSON.parse(match ? match[0] : result.text);
      } catch {
        profile = { summary: result.text || '', traits: [], formality: 'unknown', avgSentenceLength: 'unknown', toneKeywords: [] };
      }
      profile.analyzedAt = new Date().toISOString();
      profile.sampleCount = samples.length;
      fs.writeFileSync(STYLE_FILE, JSON.stringify(profile, null, 2));
      res.json({ profile, sampleCount: samples.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
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

      const result = await callKernelLLM(`${system}\n\n${userMsg}`);
      res.json({ content: result.text || '', usedStyle: !!profile });
    } catch (e) { res.status(500).json({ error: e.message }); }
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
      if (selection && selection.trim() && text.includes(selection)) {
        const result = await callKernelLLM(`${instr}${styleNote}\n\nReturn ONLY the rewritten fragment:\n\n${selection}`);
        const rewritten = (result.text || '').trim();
        return res.json({ content: text.replace(selection, rewritten), selectionReplaced: true });
      }
      const result = await callKernelLLM(`${instr}${styleNote}\n\nReturn ONLY the result:\n\n${text}`);
      res.json({ content: result.text || '' });
    } catch (e) { res.status(500).json({ error: e.message }); }
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
      const result = await callKernelLLM(fullPrompt);
      res.json({ response: result.text || '' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── PUSH DOC TO MEMORY (save to notes) ───────────────────────────────────────

  app.post('/api/writer/doc/:id/to-memory', async (req, res) => {
    const fp = path.join(DOCS_DIR, `${req.params.id}.md`);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
    const docs = loadDocs();
    const doc = docs.find(d => d.id === req.params.id);
    const content = fs.readFileSync(fp, 'utf8');
    const newNote = {
      id: Date.now().toString(36),
      title: doc?.title || 'Writer Draft',
      body: content.slice(0, 8000),
      tags: ['writer', 'draft'],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    // Write to local notes file directly — no block-to-block HTTP
    if (NOTES_FILE) {
      try {
        let notes = [];
        try { notes = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8')); } catch {}
        notes.unshift(newNote);
        fs.writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2));
      } catch {}
    }
    // Mirror to Supabase if available
    if (supabase) {
      supabase.from('aeon_notes').insert([newNote]).then(() => {}).catch(() => {});
    }
    res.json({ ok: true });
  });

  // ── LEGACY AI ASSIST (kept for backwards compat) ─────────────────────────────

  app.post('/api/writer/ai', async (req, res) => {
    const { text, action = 'improve' } = req.body || {};
    if (!text) return res.status(400).json({ error: 'text required' });
    const prompts = {
      improve: `Improve this text. Return ONLY the improved text:\n\n${text}`,
      expand: `Expand this text with more detail. Return ONLY the expanded text:\n\n${text}`,
      summarize: `Summarize this text concisely. Return ONLY the summary:\n\n${text}`,
      formal: `Rewrite formally. Return ONLY the rewritten text:\n\n${text}`,
      casual: `Rewrite casually. Return ONLY the rewritten text:\n\n${text}`,
      bullets: `Convert to bullet points. Return ONLY the bullets:\n\n${text}`,
    };
    try {
      const result = await callKernelLLM(prompts[action] || prompts.improve);
      res.json({ ok: true, result: result.text || '' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
