const express = require('express');
const fs = require('fs');
const path = require('path');
const { loadSettings } = require('../../../../services/settings.js');

module.exports = function createChatRouter(deps) {
  const router = express.Router();
  const {
    isVercel, supabase, LOG_FILE, AUDIT_FILE,
    getLocalFile, getDailyCost, addRunCost,
    KILL_SWITCH_THRESHOLD, GEMINI_PRICE_PER_TOKEN, GROQ_PRICE_PER_TOKEN,
    geminiRequest, groqRequest, writeOSAudit, fetchDuckDuckGo,
    aeonTerminalStream, TERMINAL_HISTORY_FILE, DEFAULT_LOCAL_MODEL, defaultLocalModel
  } = deps;
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
            const host = process.env.VERCEL && req.headers.host ? `https://${req.headers.host}` : (process.env.AEON_KERNEL_URL || `http://localhost:${process.env.PORT || 3001}`);
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
        const SB_RECALL_PATTERNS = [
          /\b(remember|told|said|mentioned|last time|earlier|before|yesterday|history|historical|conversation|we discussed|i asked)\b/i,
          /\b(my notes?|my docs?|my files?|second brain|brain|knowledge base|what do i know)\b/i,
          /\b(find|search|look up|retrieve|recall|pull up)\b/i,
          /\b(aeon )?matrix\b/i,
          /\b(vault|reading library)\b/i,
          /\b(collected|on file|our (data|records|knowledge)|existing (data|notes|documentation))\b/i,
        ];
        const isMatrixCommand = lowerContent.startsWith('/matrix ');
        let sbQuery = content || prompt;
        if (isMatrixCommand) {
          sbQuery = content.slice(8).trim().replace(/^"(.*)"$/, '$1');
          modifiedPrompt = sbQuery; // strip the "/matrix " prefix out of what the model sees
        }
        if (isMatrixCommand || SB_RECALL_PATTERNS.some(p => p.test(lowerContent))) {
          try {
            const host = process.env.VERCEL && req.headers.host ? `https://${req.headers.host}` : (process.env.AEON_KERNEL_URL || `http://localhost:${process.env.PORT || 3001}`);
            const sbRes = await fetch(`${host}/api/crn/second-brain/retrieve`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ query: sbQuery }),
            });
            const sbData = await sbRes.json();
            if (sbData.documents && sbData.documents.length) {
              const sbContext = sbData.documents
                .map(d => `[${d.metadata.source}] ${d.content}`)
                .join('\n\n');
              modifiedPrompt = `${modifiedPrompt}\n\n[AEON SECOND BRAIN CONTEXT]\nRelevant indexed knowledge — cite the source file when you use it. If nothing here is relevant, ignore it:\n\n${sbContext}`;
            } else if (isMatrixCommand) {
              modifiedPrompt = `${modifiedPrompt}\n\n[AEON SECOND BRAIN CONTEXT]\nNo relevant indexed documents were found for this request — say so plainly rather than inventing sources.`;
            }
          } catch (e) { /* best-effort — never block chat on Second Brain being unavailable */ }
        }

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
        { id: `chat_${Date.now()}`, sender: 'system', name: 'AEON_CORTEX', content: 'SYSTEM RESET. WAITING FOR CEO COMMAND.', timestamp: new Date().toISOString(), color: '#00f2ff' }
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
