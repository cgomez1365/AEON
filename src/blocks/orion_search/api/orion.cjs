/**
 * Orion Unified Search — one query, three lenses, real links on everything.
 *
 *   POST /api/orion/search { query, k? }
 *   → { ok, query, results: [{ title, url, excerpt, source, score? }] }
 *     source: "web" (search chain) | "brain" (Second Brain, url = file path)
 *           | "block" (installed block whose brief matches)
 *
 * Fans out in parallel to the existing engines — no new providers, no keys
 * of its own. VP's orion_search tool and the /orion command both land here.
 */
const express = require('express');

// NOTE: single named param, NO default — blockHost dispatches on factory.length===1;
// a default value makes length 0 and misroutes this into the plugin pattern.
module.exports = function (deps) {
  const router = express.Router();
  const PORT = Number(process.env.PORT) || 3001;

  const jfetch = async (url, init) => {
    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
      return await r.json();
    } catch (e) { return { error: e.message }; }
  };

  router.post('/orion/search', async (req, res) => {
    const { query, k = 5 } = req.body || {};
    if (!query || !String(query).trim()) return res.status(400).json({ ok: false, error: 'query required' });
    const q = String(query).trim();

    // Self-fetch host: on Vercel there's no persistent loopback server to hit per
    // invocation, so route back through the public host from the incoming request
    // instead (same host-swap pattern as dashboard/api/chat.cjs). Locally, the
    // Express server is a long-lived loopback listener on PORT.
    const base = deps.isVercel && req.headers.host ? `https://${req.headers.host}` : `http://127.0.0.1:${PORT}`;

    const [web, brain, blocks] = await Promise.all([
      // Web: existing provider chain (Tavily → Serper → Brave → DDG)
      // BO-H4d — synthesize=0: this leg parses `results` and never reads
      // `answer`, so asking for prose cost 80-219s and guaranteed the 15s
      // budget below would abort. The budget stays at 15s deliberately —
      // raising it would have hidden the defect instead of removing it.
      jfetch(`${base}/api/search-web?q=${encodeURIComponent(q)}&synthesize=0`),
      // Second Brain: RAG retrieve (returns passages with doc refs)
      jfetch(`${base}/api/crn/second-brain/retrieve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, k }),
      }),
      // Blocks: match the live registry briefs (local, sync, no fetch)
      Promise.resolve().then(() => {
        try {
          const { getBlockBriefs } = require('../../../kernel/blockAwareness.cjs');
          const ql = q.toLowerCase();
          return getBlockBriefs().filter(b =>
            b.id.includes(ql) || b.label.toLowerCase().includes(ql) || b.brief.toLowerCase().includes(ql));
        } catch { return []; }
      }),
    ]);

    const results = [];

    // /api/search-web returns markdown blocks: "- **Title**\n  snippet\n  Source: [url](url)"
    // Parse them back into structured results so every web hit carries its link.
    // BO-H4c — jfetch returns { error } on abort/failure. This read only ever
    // looked at `results`, so a hard failure became an empty string and the
    // response still said ok:true — "no results found" for a query a working
    // engine answered in one second. R-05: no silent failures.
    const webError = web?.error || null;
    const webRaw = typeof web?.results === 'string' ? web.results : '';
    const webBlocks = webRaw.split(/\n\n+/).filter(b => b.trim().startsWith('- **'));
    for (const block of webBlocks.slice(0, k)) {
      const title = block.match(/-\s*\*\*(.+?)\*\*/)?.[1] || 'untitled';
      const url = block.match(/Source:\s*\[[^\]]*\]\((https?:\/\/[^)]+)\)/)?.[1] || null;
      const excerpt = block.split('\n').slice(1).filter(l => !l.includes('Source:')).join(' ').trim().slice(0, 300);
      results.push({ title, url, excerpt, source: 'web' });
    }

    // retrieve.cjs returns { documents: [{ id, content, similarity, metadata }] }
    // legacy/other callers may use passages/results — check all three
    const brainDocs = brain?.documents || brain?.passages || brain?.results || [];
    for (const p of brainDocs.slice(0, k)) {
      results.push({
        title: p.metadata?.source || p.title || p.filename || p.docId || p.id || 'Second Brain document',
        url: p.id || p.docId || p.ref || p.path || null,
        excerpt: (p.content || p.text || p.summary || '').slice(0, 300),
        score: p.similarity ?? p.score,
        source: 'brain',
      });
    }

    for (const b of (blocks || []).slice(0, k)) {
      results.push({
        title: `${b.label} (block)`,
        url: b.route,
        excerpt: b.brief.slice(0, 300),
        source: 'block',
      });
    }

    res.json({
      ok: true, query: q,
      counts: { web: webBlocks.length, brain: brainDocs.length, block: (blocks || []).length },
      results,
      ...(webError ? { degraded: { web: webError } } : {}),
    });
  });

  return router;
};
