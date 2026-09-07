const express = require('express');
const fs = require('fs');
const path = require('path');
const { loadSettings } = require('../../../../services/settings.js');
const { isCloud: _isCloud } = require('../../../kernel/runtime.cjs');
const kernelContext = require('../../../kernel/context.cjs');

module.exports = function createChatRouter(deps) {
  const router = express.Router();
  const {
    isVercel, supabase, LOG_FILE, AUDIT_FILE,
    getLocalFile, getDailyCost, addRunCost,
    KILL_SWITCH_THRESHOLD, GEMINI_PRICE_PER_TOKEN, GROQ_PRICE_PER_TOKEN,
    geminiRequest, groqRequest, writeOSAudit, fetchDuckDuckGo,
    aeonTerminalStream, TERMINAL_HISTORY_FILE, DEFAULT_LOCAL_MODEL, defaultLocalModel,
    // Naming a chat is a model call; the block declares permissions.ai, so the
    // loader hands it kernelLLM rather than the block reaching for a provider.
    kernelLLM,
    VAULT_ROOT,
  } = deps;

  // ── Chat session persistence (Vault/Agents/Aeon/chat_sessions/) ──────────
  //
  // These are the operator's saved conversations. They are NOT part of the
  // indexed record: aeon_matrix prunes this directory from both the scan and
  // the graph (BO-MEM T1), because a saved feed carries the assistant's own
  // turns and R09 forbids those entering the record automatically — a model
  // turn stored as an ordinary document becomes a source a later answer can
  // cite. A conversation joins the record only when the operator says so.
  const SESSIONS_DIR = path.join(
    VAULT_ROOT || path.join(__dirname, '..', '..', 'aeon_matrix', 'data', 'Vault'),
    'Agents', 'Aeon', 'chat_sessions'
  );
  const ensureSessionsDir = () => { try { if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {} };

  // A session id becomes a filename, so it is validated before it touches a
  // path — the same shape deep_research validates on every route that takes
  // one (SESSION_ID_RE, deep_research/api/index.cjs:18). GET and DELETE
  // interpolated req.params.id straight into a path and DELETE then unlinked.
  const SESSION_ID_RE = /^[a-zA-Z0-9-]{1,128}$/;
  const sessionPath = (id) => {
    if (!SESSION_ID_RE.test(String(id || ''))) return null;
    return path.join(SESSIONS_DIR, `${id}.json`);
  };
  const readSession = (id) => {
    const f = sessionPath(id);
    if (!f || !fs.existsSync(f)) return null;
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
  };
  const writeSession = (record) => {
    ensureSessionsDir();
    fs.writeFileSync(path.join(SESSIONS_DIR, `${record.id}.json`), JSON.stringify(record, null, 2));
    return record;
  };

  /**
   * A title before any model is asked.
   *
   * Doctrine R10 tier 1: deterministic, free, always available — the title
   * exists the moment the chat is saved, offline, with no embedder and no chat
   * model. The model only ever REFINES this, and only while nobody has renamed
   * the chat by hand.
   */
  const deterministicTitle = (messages) => {
    const first = (Array.isArray(messages) ? messages : [])
      .find(m => m && m.role === 'user' && typeof m.content === 'string' && m.content.trim());
    if (!first) return null;
    const flat = first.content.replace(/\s+/g, ' ').trim();
    return flat.length <= 48 ? flat : `${flat.slice(0, 47).trimEnd()}…`;
  };

  // GET /api/terminal/sessions — list saved sessions, newest first
  router.get('/terminal/sessions', (req, res) => {
    try {
      ensureSessionsDir();
      const files = fs.readdirSync(SESSIONS_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => {
          try {
            const raw = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
            return {
              id: raw.id, name: raw.name, savedAt: raw.savedAt,
              updatedAt: raw.updatedAt || raw.savedAt,
              autoSaved: !!raw.autoSaved,
              // Who chose this name. The UI needs it to show an operator title
              // as settled rather than provisional, and the naming route needs
              // it to refuse to overwrite one (R10).
              nameSetBy: raw.nameSetBy || 'auto',
              inRecord: !!raw.inRecord,
              messageCount: raw.messageCount || 0,
            };
          } catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
      res.json(files);
    } catch (e) {
      res.json([]);
    }
  });

  // POST /api/terminal/sessions — save a session, or update the one named by `id`.
  //
  // Without the update path this route minted a fresh id on EVERY call
  // (`const id = new Date()...`), so save-after-load forked the conversation
  // and the unload beacon wrote a brand-new record on every page refresh. One
  // conversation became a pile of near-duplicates, each of which the operator
  // then had to tell apart by timestamp.
  router.post('/terminal/sessions', (req, res) => {
    try {
      ensureSessionsDir();
      const { id: incomingId, name, messages, autoSaved } = req.body || {};
      if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'messages required' });
      }

      const existing = incomingId ? readSession(incomingId) : null;
      if (incomingId && !existing) {
        return res.status(404).json({ error: 'Session not found', id: incomingId });
      }

      const now = new Date().toISOString();
      const id = existing ? existing.id : now.replace(/[:.]/g, '-');

      // R10 — an operator-set name is never overwritten, not even by a later
      // save that happens to carry a different one.
      let resolvedName = existing?.name;
      let nameSetBy = existing?.nameSetBy || 'auto';
      if (name && nameSetBy !== 'operator') {
        resolvedName = name;
        nameSetBy = 'operator';
      } else if (!resolvedName) {
        resolvedName = deterministicTitle(messages)
          || `Chat — ${new Date(now).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
        nameSetBy = 'auto';
      }

      const record = writeSession({
        ...(existing || {}),
        id,
        name: resolvedName,
        nameSetBy,
        savedAt: existing?.savedAt || now,
        updatedAt: now,
        autoSaved: !!autoSaved,
        messageCount: messages.length,
        messages,
      });
      res.json({ ok: true, id, name: record.name, nameSetBy: record.nameSetBy, updated: !!existing });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // PATCH /api/terminal/sessions/:id — rename. The operator's word is final.
  router.patch('/terminal/sessions/:id', (req, res) => {
    const record = readSession(req.params.id);
    if (!record) return res.status(404).json({ error: 'Session not found' });
    const name = String((req.body || {}).name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required. Send the new title as { name }.' });
    if (name.length > 200) return res.status(400).json({ error: 'name must be 200 characters or fewer' });
    try {
      const saved = writeSession({ ...record, name, nameSetBy: 'operator', updatedAt: new Date().toISOString() });
      res.json({ ok: true, id: saved.id, name: saved.name, nameSetBy: 'operator' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/terminal/sessions/:id/name — let the model propose a title.
  //
  // R10 tier 2. Deliberately a separate, opt-in route rather than something
  // POST /sessions does on its own: naming costs a model call, and a chat the
  // operator already named must never spend one. It REFUSES rather than
  // overwrites, so the refusal is visible instead of the rename being lost.
  router.post('/terminal/sessions/:id/name', async (req, res) => {
    const record = readSession(req.params.id);
    if (!record) return res.status(404).json({ error: 'Session not found' });
    if (record.nameSetBy === 'operator') {
      return res.status(409).json({
        ok: false, code: 'operator_named',
        error: 'This chat was named by you, so it is left alone. Rename it yourself to change it.',
        name: record.name,
      });
    }
    if (typeof kernelLLM !== 'function') {
      return res.status(503).json({
        ok: false, code: 'no_model',
        error: 'No model is assigned to name chats.',
        remedy: 'Assign a model to the chat role in Settings → Model Assignment, or rename the chat yourself.',
        name: record.name,
      });
    }

    const turns = (record.messages || [])
      .filter(m => m && m.role === 'user' && typeof m.content === 'string')
      .slice(0, 3)
      .map(m => m.content.replace(/\s+/g, ' ').slice(0, 300))
      .join('\n');
    if (!turns) return res.json({ ok: true, name: record.name, nameSetBy: record.nameSetBy, unchanged: true });

    try {
      const raw = await kernelLLM(
        `Title this conversation in 2 to 6 words. Reply with the title alone: no quotes, no punctuation at the end, no preamble.\n\n${turns}`,
        { role: 'naming' },
      );
      const name = String(raw || '').trim().split('\n')[0].replace(/^["'“]|["'”.]$/g, '').slice(0, 80).trim();
      // A model that answers with a sentence, an apology, or nothing usable
      // leaves the existing title alone. The deterministic title is already
      // serviceable, so a bad refinement must never make things worse.
      if (!name || name.length < 2 || name.split(/\s+/).length > 10) {
        return res.json({ ok: true, name: record.name, nameSetBy: record.nameSetBy, unchanged: true, reason: 'unusable_title' });
      }
      const saved = writeSession({ ...record, name, nameSetBy: 'model', updatedAt: new Date().toISOString() });
      res.json({ ok: true, id: saved.id, name: saved.name, nameSetBy: 'model' });
    } catch (e) {
      // Naming is a nicety. It must never fail a save or block the operator.
      res.status(200).json({ ok: true, name: record.name, nameSetBy: record.nameSetBy, unchanged: true, reason: e.message });
    }
  });

  // POST /api/terminal/sessions/:id/remember — put this conversation INTO the
  // indexed record, on purpose.
  //
  // Doctrine R09. Conversations are pruned from the automatic scan precisely so
  // that entering the record is a decision. This is that decision, and it
  // routes to the block that owns the record rather than writing the index
  // here. ingest/chat stores OPERATOR turns only — the model's own words do not
  // become a source a later answer can cite.
  router.post('/terminal/sessions/:id/remember', async (req, res) => {
    const record = readSession(req.params.id);
    if (!record) return res.status(404).json({ error: 'Session not found' });
    const messages = (record.messages || []).filter(m => m && m.role === 'user');
    if (!messages.length) {
      return res.status(400).json({ error: 'This conversation has nothing of yours to remember yet.' });
    }
    try {
      const base = process.env.AEON_KERNEL_URL || `http://127.0.0.1:${process.env.PORT || 3001}`;
      const r = await fetch(`${base}/api/crn/second-brain/ingest/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Same lesson as the recall path: an internal call carries no session
          // unless it is forwarded, and the ingest route is guarded.
          ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
          ...(req.headers.cookie ? { Cookie: req.headers.cookie } : {}),
        },
        body: JSON.stringify({ session_id: record.id, messages }),
        signal: AbortSignal.timeout(20000),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        return res.status(r.status).json({
          ok: false,
          error: data.error || `The record could not be written (${r.status}).`,
          remedy: r.status === 401 || r.status === 403
            ? 'Unlock the vault and try again.'
            : 'Check that the Aeon Matrix block is mounted.',
        });
      }
      writeSession({ ...record, inRecord: true, rememberedAt: new Date().toISOString() });
      res.json({ ok: true, ingested: data.ingested || 0, file: data.file || null });
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message });
    }
  });

  // GET /api/terminal/sessions/:id — load one session
  router.get('/terminal/sessions/:id', (req, res) => {
    const record = readSession(req.params.id);
    if (!record) return res.status(404).json({ error: 'Session not found' });
    res.json(record);
  });

  // DELETE /api/terminal/sessions/:id — delete one session
  router.delete('/terminal/sessions/:id', (req, res) => {
    const file = sessionPath(req.params.id);
    if (!file) return res.status(400).json({ error: 'Invalid session id' });
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  const localModel = (defaultLocalModel ? defaultLocalModel() : null) || DEFAULT_LOCAL_MODEL || null;

  // GET /api/chat — retrieve chat history
  router.get('/chat', async (req, res) => {
    try {
      if (supabase) {
        const { data, error } = await supabase.from('aeon_chat_log').select('*').order('timestamp', { ascending: false }).limit(200);
        if (!error && data) {
          const chatLog = data.reverse();
          fs.writeFileSync(LOG_FILE, JSON.stringify(chatLog, null, 2), 'utf8');
          return res.json(chatLog);
        }
      }
    } catch (e) {
      console.error('[AEON] Supabase chat sync failed:', e.message);
    }

    try {
      const data = fs.readFileSync(LOG_FILE, 'utf8');
      res.json(JSON.parse(data));
    } catch (error) {
      res.status(500).json({ correlation_id: req.correlationId || 'AEON-SYS', error: 'Failed to read chat log' });
    }
  });

  // POST /api/chat — post message & optional AI generation
  router.post('/chat', async (req, res) => {
    try {
      const { sender, name, content, color, prompt, model } = req.body;
      const userContent = content || prompt || '';

      const newMessage = {
        id: `chat_${Date.now()}`,
        sender: sender || 'system',
        name: name || 'System',
        content: userContent,
        color: color || '#888',
        timestamp: new Date().toISOString(),
        meta: { model }
      };

      if (supabase) {
        (async () => { try { const { error } = await supabase.from('aeon_chat_log').upsert([newMessage], { onConflict: 'id' }); if (error) console.error('[AEON] Supabase chat sync error:', error.message); } catch {} })();
      }

      let chat = [];
      try { chat = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch {}
      chat.push(newMessage);

      if (prompt) {
        const startTime = Date.now();
        let aiResponse = '';
        // Read role config from settings — no hardcoded fallback.
        // Via the settings authority (services/settings.js), not a per-request
        // readFileSync + JSON.parse against a hand-built relative path. This
        // ran on every chat message and was one of three modules that bypassed
        // the declared single reader (BO-F1).
        let activeModel;
        try {
          const _s = loadSettings();
          const rc = _s.models?.chat || {};
          activeModel = model && model !== 'gemini' ? model : (rc.model || 'gemini-2.0-flash');
        } catch { activeModel = (model === 'gemini' || !model) ? 'gemini-2.0-flash' : model; }
        let provider = 'Google Cloud';
        let throttle_active = false;
        let currentCost = getDailyCost();

        let modifiedPrompt = prompt;
        const lowerContent = (content || '').toLowerCase();

        if (lowerContent.startsWith('/link ')) {
          const urlMatch = content.match(/https?:\/\/[^\s]+/);
          if (urlMatch) {
            const url = urlMatch[0];
            let linkName = url.replace('https://', '').replace('http://', '').split('/')[0];
            const linksFile = getLocalFile('quick-links.json');
            let links = [];
            if (fs.existsSync(linksFile)) {
              try { links = JSON.parse(fs.readFileSync(linksFile, 'utf8')); } catch(e){}
            }
            const newId = links.length > 0 ? Math.max(...links.map(l => l.id)) + 1 : 1;
            links.push({ id: newId, name: linkName + ' (Auto)', url: url, category: 'Quick Links' });
            fs.writeFileSync(linksFile, JSON.stringify(links, null, 2));

            const sysResp = `[LINK CAPTURED] Automatically intercepted and saved ${url} to Quick Links database.`;
            const sysMsg = { id: `chat_${Date.now()}`, sender: 'system', name: 'AEON_CORTEX', content: sysResp, timestamp: new Date().toISOString(), color: '#00f2ff' };
            chat.push(sysMsg);
            try { fs.writeFileSync(LOG_FILE, JSON.stringify(chat.slice(-200), null, 2), 'utf8'); } catch {}
            if (supabase) supabase.from('aeon_chat_log').insert([sysMsg]).then(() => {});
            return res.json({ success: true, aiResponse: sysResp, provider: 'System Automaton', model: 'cortex-system', cost: 0, throttle: false });
          }
        }

        if (lowerContent.startsWith('/scrape ')) {
          const scrapeQuery = content.substring(8).trim();
          try {
            const host = _isCloud() && req.headers.host ? `https://${req.headers.host}` : (process.env.AEON_KERNEL_URL || `http://localhost:${process.env.PORT || 3001}`);
            // Was /api/orion-scrape — a route nothing has ever mounted, so
            // /scrape has always failed. The orion_search block owns this and
            // serves /api/orion/search.
            const resScrape = await fetch(`${host}/api/orion/search`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ query: scrapeQuery, k: 8 }),
              signal: AbortSignal.timeout(20000),
            });
            const orionData = await resScrape.json();
            const results = (orionData && orionData.results) || [];
            const scrapeData = results.length ? {
              answer: results.map((r, i) => `[${i + 1}] ${r.title}\n${r.excerpt || ''}`).join('\n\n'),
              citations: results.map((r, i) => ({ id: i + 1, url: r.url, title: r.title })),
            } : null;

            if (scrapeData && scrapeData.answer) {
              const sysResp = `[ORION GLOBAL INTELLIGENCE]\n\n${scrapeData.answer}\n\n**Citations:**\n${(scrapeData.citations||[]).map(c=>`[${c.id}] ${c.url}`).join('\n')}`;
              const sysMsg = { id: `chat_${Date.now()}`, sender: 'system', name: 'AEON_ORION', content: sysResp, timestamp: new Date().toISOString(), color: '#ffaa00' };
              chat.push(sysMsg);
              try { fs.writeFileSync(LOG_FILE, JSON.stringify(chat.slice(-200), null, 2), 'utf8'); } catch {}
              if (supabase) supabase.from('aeon_chat_log').insert([sysMsg]).then(() => {});
              return res.json({ success: true, aiResponse: sysResp, provider: 'Orion Intelligence', model: 'orion-deep-crawl', cost: 0, throttle: false });
            }
          } catch(e) {
            return res.json({ success: false, aiResponse: '[ORION ERROR] ' + e.message, provider: 'System', model: 'error', cost: 0, throttle: false });
          }
        }

        if (lowerContent.startsWith('/web') || lowerContent.includes('search the web') || lowerContent.includes('latest news')) {
          const correlationId = req.correlationId || 'AEON-SYS';
          writeOSAudit('DDG_SEARCH_START', `Intercepted search intent for: ${content}`, 200, 0, correlationId);
          const searchContext = await fetchDuckDuckGo(content, correlationId);
          if (searchContext) {
            modifiedPrompt = `USER PROMPT:\n${prompt}\n\n[AEON BACKGROUND SEARCH INJECT]\nUse the following web search results to answer the user's query. Always cite your sources using the provided URLs:\n\n${searchContext}`;
          }
        }

        // Second Brain recall — /matrix <request> forces it explicitly; otherwise it's
        // gated locally (mirrors retrieve.cjs's isRecallQuery) so ordinary chat never
        // pays for a lookup. Calls /api/crn/second-brain/retrieve, the block's own
        // unambiguous route. (This used to be a workaround for /api/search being
        // shadowed by another block; both claimants are resolved now and
        // tests/route-collisions keeps it that way — but naming the route you
        // actually mean is still the better habit.)
        // BO-MEM M1. This was a verbatim second copy of the gate in
        // chat-stream.cjs, and it had drifted in ways that made it worse than
        // useless on this route:
        //   * it gated on `content` but queried with `content || prompt`, and
        //     both live callers send only `prompt` — so the gate could never
        //     fire here for any real request;
        //   * it read `d.metadata.source` unguarded, throwing into a bare catch
        //     on any document without metadata;
        //   * it passed no timeout, so a wedged index hung the turn;
        //   * it built its base URL from the Host header, which lets a caller
        //     choose where the operator's query and vault content are sent;
        //   * it carried no credentials, so with the guard on it 401'd and the
        //     refusal read as "your vault is empty".
        // One policy, one place (Doctrine R05).
        const sbRecall = await kernelContext.buildRecallContext(content || prompt, {
          auth: { authorization: req.headers.authorization, cookie: req.headers.cookie },
        });
        if (sbRecall.forced) modifiedPrompt = sbRecall.query;
        if (sbRecall.context) modifiedPrompt = `${modifiedPrompt}${sbRecall.context}`;

        if (currentCost >= KILL_SWITCH_THRESHOLD && activeModel !== localModel) {
          console.warn(`[KILL SWITCH ACTIVATED] Local server burned $${currentCost.toFixed(4)}. Forcing Local Enclave.`);
          activeModel = localModel;
          throttle_active = true;
        }

        try {
          provider = 'Gemini Key Pool';
          aiResponse = await geminiRequest(modifiedPrompt, activeModel);
        } catch (err) {
          console.error('[AEON] Chat AI generation failed, falling back to Gemini:', err);
          try {
            aiResponse = await geminiRequest(modifiedPrompt, 'gemini-2.0-flash');
            provider = 'Gemini Fallback';
            activeModel = 'gemini-2.0-flash';
          } catch (geminiErr) {
            console.error('[AEON] Gemini Fallback failed, routing to Groq roulette fallback:', geminiErr);
            try {
              aiResponse = await groqRequest(modifiedPrompt, 'llama-3.1-8b-instant');
              provider = 'Groq Roulette Fallback';
              activeModel = 'llama-3.1-8b-instant';
            } catch (fatalErr) {
              console.error('[AEON] Fatal AI Error during fallback:', fatalErr);
              aiResponse = `**System Alert:** I encountered a critical neural link error while processing that request (Error: ${fatalErr.message.substring(0, 100)}...). This is often caused by safety filters or API rate limits on the external model.`;
              provider = 'Offline Failsafe';
            }
          }
        }

        let runCost = 0;
        const approxTokens = Math.ceil((userContent.length + aiResponse.length) / 4);
        if (provider.includes('Google') || provider.includes('Gemini')) {
          runCost = approxTokens * GEMINI_PRICE_PER_TOKEN;
        } else if (provider.includes('Groq')) {
          runCost = approxTokens * GROQ_PRICE_PER_TOKEN;
        }
        currentCost = addRunCost(runCost);

        const latencyMs = Date.now() - startTime;
        const aiMessage = {
          id: Date.now() + 1,
          sender: 'assistant',
          name: 'CORE',
          content: aiResponse,
          time: new Date().toLocaleTimeString(),
          color: '#00f2ff'
        };
        chat.push(aiMessage);
        try { fs.writeFileSync(LOG_FILE, JSON.stringify(chat.slice(-200), null, 2)); } catch {}
        if (supabase) { supabase.from('aeon_chat_log').insert([aiMessage]).then(() => {}); }

        let toolCall = null;
        try {
          const jsonMatch = aiResponse.match(/```json\n([\s\S]*?)\n```/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[1]);
            if (parsed && parsed.type === 'tool_call') {
              toolCall = parsed;
            }
          }
        } catch (e) {
          try {
            const logDir = getLocalFile('logs');
            if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);
            fs.appendFileSync(require('path').join(logDir, 'audit_low.log'), `[TRIVIAL][${new Date().toISOString()}] ${e.message}\n`);
            if (typeof global.broadcastTerminalEvent === 'function') {
              global.broadcastTerminalEvent('SYSTEM_METRIC', `[SILENT-ERR] ${e.message}`);
            }
          } catch(err) {}
        }

        return res.json({
          ...newMessage,
          response: aiResponse,
          toolCall: toolCall,
          meta: {
            model: activeModel,
            provider: provider,
            latencyMs,
            throttle_active,
            current_cost: currentCost
          }
        });
      }

      try { fs.writeFileSync(LOG_FILE, JSON.stringify(chat.slice(-200), null, 2)); } catch {}
      if (supabase) { (async () => { try { await supabase.from('aeon_chat_log').upsert([newMessage], { onConflict: 'id' }); } catch {} })(); }
      res.json(newMessage);
    } catch (error) {
      console.error('[AEON] Error in /api/chat:', error);
      res.status(500).json({ correlation_id: req.correlationId || 'AEON-SYS', error: 'Failed to process chat: ' + error.message });
    }
  });

  // DELETE /api/chat — clear chat
  router.delete('/chat', async (req, res) => {
    try {
      const init = [
        { id: `chat_${Date.now()}`, sender: 'system', name: 'AEON_CORTEX', content: 'SYSTEM RESET. READY.', timestamp: new Date().toISOString(), color: '#00f2ff' }
      ];
      if (isVercel && supabase) {
        await supabase.from('aeon_chat_log').delete().neq('id', '0');
        await supabase.from('aeon_chat_log').insert(init);
      } else {
        fs.writeFileSync(LOG_FILE, JSON.stringify(init, null, 2));
      }
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ correlation_id: req.correlationId || 'AEON-SYS', error: 'Failed to clear chat log' });
    }
  });

  // SSE BRIDGE: NEURAL TERMINAL STREAM
  const activeSSEClients = new Set();
  router.get('/terminal-stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    if (isVercel) {
      req.on('close', () => {});
      return;
    }
    const onLog = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    aeonTerminalStream.on('log', onLog);
    activeSSEClients.add(req);
    req.on('close', () => {
      aeonTerminalStream.removeListener('log', onLog);
      activeSSEClients.delete(req);
    });
  });

  // GET /api/terminal-history
  router.get('/terminal-history', async (req, res) => {
    try {
      if (supabase) {
        const { data, error } = await supabase.from('aeon_terminal_history').select('messages').eq('session_id', 'default').single();
        if (!error && data && data.messages) {
          return res.json(data.messages);
        }
      }
    } catch (e) {
      console.error('[AEON] Supabase terminal history read failed, falling back to local.', e.message);
    }

    try {
      if (fs.existsSync(TERMINAL_HISTORY_FILE)) {
        const data = fs.readFileSync(TERMINAL_HISTORY_FILE, 'utf-8');
        return res.json(JSON.parse(data));
      }
    } catch (e) {
      console.error('[AEON] Error reading terminal history:', e);
    }
    res.json([{ role: 'system', content: 'AEON CORTEX Link established. All neural synapses synchronized.' }]);
  });

  // POST /api/terminal-history
  router.post('/terminal-history', async (req, res) => {
    try {
      const { history } = req.body;
      if (!Array.isArray(history)) {
        return res.status(400).json({ correlation_id: req.correlationId || 'AEON-SYS', error: 'History must be an array' });
      }
      const limitedHistory = history.slice(-50);

      fs.writeFileSync(TERMINAL_HISTORY_FILE, JSON.stringify(limitedHistory, null, 2), 'utf-8');

      if (supabase) {
        await supabase.from('aeon_terminal_history').upsert({
          session_id: 'default',
          messages: limitedHistory,
          updated_at: new Date().toISOString()
        }, { onConflict: 'session_id' });
      }

      res.json({ success: true });
    } catch (e) {
      console.error('[AEON] Error saving terminal history:', e);
      res.status(500).json({ correlation_id: req.correlationId || 'AEON-SYS', error: 'Failed to save terminal history' });
    }
  });

  // Expose activeSSEClients for telemetry engine in server.cjs
  router.activeSSEClients = activeSSEClients;

  return router;
};
