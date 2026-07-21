module.exports = (deps) => {
  const express = require('express');
  const router = express.Router();
  const fs = require('fs');
  const path = require('path');

  const {
    isVercel, supabase, getLocalFile,
    AUDIT_FILE, LOG_FILE, TOKEN_LEDGER_FILE,
    GEMINI_PRICE_PER_TOKEN, GROQ_PRICE_PER_TOKEN,
    validateSDI
  } = deps;
  // pdfTextCache was never part of baseDeps (sandbox warned on every access) —
  // a local per-process cache does the same job without touching the sandbox.
  const pdfTextCache = {};

  router.post('/search', async (req, res) => {
    try {
      const { query } = req.body;
      if (!query) return res.json({ documents: [] });

      if (isVercel && supabase) {
        const results = [];
        // Search notes
        const { data: notes } = await supabase.from('aeon_notes').select('*').ilike('content', `%${query}%`).limit(5);
        if (notes) results.push(...notes.map(d => ({ id: d.id, title: d.title, content: d.content, metadata: { source: 'notes', path: 'Supabase Cloud' }, similarity: 0.7 })));
        // Search documents (Second Brain matrix)
        const { data: docs } = await supabase.from('documents').select('*').ilike('content', `%${query}%`).limit(10);
        if (docs) results.push(...docs.map(d => ({ id: d.id, title: d.metadata?.title || d.id, content: (d.content || '').slice(0, 500), metadata: { source: d.metadata?.source || 'Second Brain', path: d.metadata?.original_id || '' }, similarity: 0.6 })));
        // Search memory block if synced
        const { data: memBlock } = await supabase.from('aeon_blocks').select('payload').eq('block_tag', 'memory').single().then(r => r).catch(() => ({ data: null }));
        if (memBlock?.payload && Array.isArray(memBlock.payload)) {
          const q = query.toLowerCase();
          const memMatches = memBlock.payload.filter(m => (m.text || '').toLowerCase().includes(q)).slice(0, 5);
          results.push(...memMatches.map(m => ({ id: m.id, title: m.text?.slice(0, 60), content: m.text, metadata: { source: 'memory', category: m.category }, similarity: 0.8 })));
        }
        return res.json({ documents: results });
      }

      const stopWords = new Set(['the', 'is', 'at', 'which', 'on', 'a', 'an', 'and', 'or', 'to', 'in', 'of', 'for', 'with', 'about']);
      const keywords = query.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(' ').filter(w => w.length > 2 && !stopWords.has(w));
      if (keywords.length === 0) return res.json({ documents: [] });

      // aeon213: self-contained — resolve relative to the repo root, never a
      // hardcoded machine path. (Ideally the kernel/settings would broker this.)
      const AEON_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
      const searchDirs = [
        path.join(AEON_ROOT, 'Data', 'Second_Brain', 'Projects'),
        path.join(AEON_ROOT, 'Data', 'Second_Brain', 'Reading_Library'),
        path.join(AEON_ROOT, 'Data', 'Second_Brain', 'System'),
        path.join(AEON_ROOT, 'Data', 'Second_Brain', 'Training_Bank')
      ];

      const pdf = require('pdf-parse');

      let allFiles = [];
      for (const dir of searchDirs) {
        if (!fs.existsSync(dir)) continue;
        const walkSync = function(dir, filelist) {
          const files = fs.readdirSync(dir);
          filelist = filelist || [];
          files.forEach(function(file) {
            if (fs.statSync(path.join(dir, file)).isDirectory()) {
              filelist = walkSync(path.join(dir, file), filelist);
            } else {
              if (file.endsWith('.md') || file.endsWith('.pdf')) {
                filelist.push(path.join(dir, file));
              }
            }
          });
          return filelist;
        };
        allFiles = allFiles.concat(walkSync(dir));
      }

      const scoredDocs = [];

      for (const file of allFiles) {
        let fileContent = '';
        try {
          if (file.endsWith('.pdf')) {
            if (pdfTextCache[file]) {
              fileContent = pdfTextCache[file];
            } else {
              const dataBuffer = fs.readFileSync(file);
              const pdfData = await pdf(dataBuffer);
              fileContent = pdfData.text;
              pdfTextCache[file] = fileContent;
            }
          } else {
            fileContent = fs.readFileSync(file, 'utf-8');
          }
        } catch (e) {
          console.error('Failed to read/parse:', file, e.message);
          continue;
        }

        const contentLower = fileContent.toLowerCase();
        let score = 0;

        for (const kw of keywords) {
          const regex = new RegExp(`\b${kw}\b`, 'g');
          const matches = contentLower.match(regex);
          if (matches) {
            score += matches.length;
          }
        }

        if (score > 0) {
          scoredDocs.push({
            content: fileContent.substring(0, 2000),
            similarity: Math.min(score / 10.0, 1.0),
            metadata: {
              source: path.basename(file),
              path: file
            },
            score: score
          });
        }
      }

      scoredDocs.sort((a, b) => b.score - a.score);
      const topDocs = scoredDocs.slice(0, 5);

      topDocs.forEach(d => delete d.score);

      res.json({ documents: topDocs });

    } catch (err) {
      console.error('Local Matrix Search Error:', err);
      res.json({ documents: [] });
    }
  });

  // Kernel telemetry lives at /core/telemetry (aliased to /api/llm-telemetry) —
  // src/kernel/routers/telemetry.cjs. Same-process router, but blocks are
  // dynamically mounted (src/kernel/blockHost.cjs) with no shared handler
  // reference, so this stays an HTTP hop; build the base from env instead of
  // a hardcoded machine/port (matches tools/autopilot-daemon.cjs).
  const KERNEL_BASE = process.env.AEON_KERNEL_URL || `http://localhost:${process.env.PORT || 3001}`;

  router.get('/telemetry/live', async (req, res) => {
    try {
      const liveRes = await fetch(`${KERNEL_BASE}/api/llm-telemetry`);
      const live = await liveRes.json();
      return res.json(live);
    } catch { return res.json({ totalCalls: 0, totalTokens: 0, models: [] }); }
  });

  router.get('/telemetry', async (req, res) => {
    try {
      let auditData = [];
      let chatData = [];
      let tokenData = { cost: 0 };

      if (isVercel && supabase) {
        const { data: audit } = await supabase.from('aeon_audit_log').select('*').order('timestamp', { ascending: false }).limit(200);
        const { data: chat } = await supabase.from('aeon_chat_log').select('*').order('timestamp', { ascending: false }).limit(200);
        if (audit) auditData = audit;
        if (chat) chatData = chat;
      } else {
        if (fs.existsSync(AUDIT_FILE)) auditData = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
        if (fs.existsSync(LOG_FILE)) chatData = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
        if (fs.existsSync(TOKEN_LEDGER_FILE)) tokenData = JSON.parse(fs.readFileSync(TOKEN_LEDGER_FILE, 'utf8'));
      }

      // Usage is aggregated from what the log ACTUALLY contains — the model
      // or provider stamped on each message. No hardcoded roster, and a
      // blank slate stays blank (the old code injected 12 fake calls here
      // so the charts "looked alive"; a trusted meter never fakes data).
      const staffUsage = {};
      chatData.forEach(msg => {
        const key = (msg.model || msg.provider || msg.engine || msg.name || msg.sender || '')
          .toString().toLowerCase().trim();
        if (!key || key === 'user' || key === 'you' || key === 'operator') return;
        if (!staffUsage[key]) staffUsage[key] = { requests: 0, tokens: 0 };
        staffUsage[key].requests++;
        staffUsage[key].tokens += Number(msg.tokens) || 150;
      });

      let totalTokens = Object.values(staffUsage).reduce((acc, s) => acc + s.tokens, 0);
      const extraTokens = Math.floor((tokenData.cost || 0) / GEMINI_PRICE_PER_TOKEN);
      totalTokens += extraTokens;

      const totalRequests = Object.values(staffUsage).reduce((acc, s) => acc + s.requests, 0);

      res.json({
        totalTokens,
        totalRequests,
        totalCost: tokenData.cost || 0,
        staffUsage
      });
    } catch (error) {
      console.error('Error reading telemetry:', error);
      res.status(500).json({ error: 'Failed to read telemetry data' });
    }
  });

  router.get('/pipeline-metrics', (req, res) => {
    try {
      let drafted = 0, ready = 0, identified = 0;
      const clientsFile = path.join(__dirname, '..', 'clients.json');
      if (fs.existsSync(clientsFile)) {
        const clients = JSON.parse(fs.readFileSync(clientsFile, 'utf8'));
        clients.forEach(c => {
          const value = parseInt(c.scale?.replace(/[^0-9]/g, '') || '0') * 100 || 500;
          const status = c.status?.toLowerCase() || '';
          if (status.includes('draft') || status.includes('pitch')) drafted += value;
          else if (status.includes('ready') || status.includes('outbox')) ready += value;
          else identified += value;
        });
      }

      res.json({
        drafted: `$${drafted.toLocaleString()}/mo`,
        ready: `$${ready.toLocaleString()}/mo`,
        identified: `$${identified.toLocaleString()}/mo`
      });
    } catch (error) {
      res.status(500).json({ correlation_id: req.correlationId, error: 'Failed to generate pipeline metrics' });
    }
  });

  router.get('/audit', async (req, res) => {
    try {
      if (supabase) {
        const { data, error } = await supabase.from('aeon_audit_log').select('*').order('timestamp', { ascending: false }).limit(200);
        if (!error && data) {
          const auditLog = data.reverse();
          fs.writeFileSync(AUDIT_FILE, JSON.stringify(auditLog, null, 2), 'utf8');
          return res.json(auditLog);
        }
      }
    } catch (e) {
      console.error('[AEON] Supabase audit sync failed:', e.message);
    }

    try {
      if (!fs.existsSync(AUDIT_FILE)) fs.writeFileSync(AUDIT_FILE, JSON.stringify([], null, 2));
      const data = fs.readFileSync(AUDIT_FILE, 'utf8');
      res.json(JSON.parse(data));
    } catch (error) {
      res.status(500).json({ correlation_id: req.correlationId, error: 'Failed to read audit log' });
    }
  });

  router.post('/audit', (req, res) => {
    const sdiCheck = validateSDI('audit', req.body);
    if (!sdiCheck.valid) return res.status(400).json({ correlation_id: req.correlationId, error: 'SDI Validation Failed', errors: sdiCheck.errors });
    try {
      const { agent, action, details } = req.body;
      const newEntry = {
        id: `audit_${Date.now()}`,
        agent: agent || 'SYSTEM',
        action: action || 'UNKNOWN',
        details: details || '',
        status_code: 200,
        telemetry_tokens: 0,
        timestamp: new Date().toISOString()
      };

      if (supabase) {
        supabase.from('aeon_audit_log').insert([newEntry]).then();
      }

      if (!fs.existsSync(AUDIT_FILE)) {
        fs.writeFileSync(AUDIT_FILE, JSON.stringify([], null, 2));
      }
      const data = fs.readFileSync(AUDIT_FILE, 'utf8');
      const audit = JSON.parse(data);
      audit.push(newEntry);
      if (audit.length > 50) audit.shift();
      fs.writeFileSync(AUDIT_FILE, JSON.stringify(audit, null, 2));
      res.json(newEntry);
    } catch (error) {
      res.status(500).json({ correlation_id: req.correlationId, error: 'Failed to write audit log' });
    }
  });

  return router;
};
