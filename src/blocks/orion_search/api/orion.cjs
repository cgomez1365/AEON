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
      // `count=k` — the depth control (8/16/24) used to stop here: the route
      // was never told, so its provider default (3 on DDG) came back whatever
      // the page said, and the slice below had nothing more to slice.
      jfetch(`${base}/api/search-web?q=${encodeURIComponent(q)}&synthesize=0&count=${encodeURIComponent(k)}`),
      // Second Brain: RAG retrieve (returns passages with doc refs)
      jfetch(`${base}/api/crn/second-brain/retrieve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, k }),
      }),
      // Blocks: match the live registry briefs (local, sync, no fetch)
      //
      // Matched on TERMS, not on the whole query as one substring. The old
      // test was `b.id.includes(ql)` with ql the entire lowercased query, so
      // "trading strategy" asked whether the id "trading" contains the string
      // "trading strategy" — false — and this lens returned nothing for any
      // query longer than one word. It appeared to work only because the
      // obvious thing to type while testing is a single word.
      //
      // Scored rather than filtered, so the closest block sorts first: id and
      // label are what someone is naming when they type it, the brief is
      // weaker evidence.
      Promise.resolve().then(() => {
        try {
          const { getBlockBriefs } = require('../../../kernel/blockAwareness.cjs');
          const terms = q.toLowerCase().match(/[a-z0-9]{2,}/g) || [];
          if (!terms.length) return [];
          return getBlockBriefs()
            .map((b) => {
              const id = String(b.id || '').toLowerCase();
              const label = String(b.label || '').toLowerCase();
              const brief = String(b.brief || '').toLowerCase();
              let score = 0;
              for (const t of terms) {
                if (id.includes(t)) score += 3;
                if (label.includes(t)) score += 3;
                if (brief.includes(t)) score += 1;
              }
              return { b, score };
            })
            .filter(x => x.score > 0)
            .sort((x, y) => y.score - x.score)
            .map(x => x.b);
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
    // Snippets arrive HTML-escaped from the engines ("Matt&#x27;s"); this is the
    // one place they are turned into fields, so decode here, once.
    const unescapeHtml = (s) => String(s || '')
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
    for (const block of webBlocks.slice(0, k)) {
      const title = unescapeHtml(block.match(/-\s*\*\*(.+?)\*\*/)?.[1] || 'untitled');
      const url = block.match(/Source:\s*\[[^\]]*\]\((https?:\/\/[^)]+)\)/)?.[1] || null;
      const excerpt = unescapeHtml(block.split('\n').slice(1).filter(l => !l.includes('Source:')).join(' ').trim()).slice(0, 300);
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

    // The brain leg has the same two failure modes the web leg does, and
    // reported neither. `error` is the fetch dying; `unavailable` is retrieve
    // saying the index could not be searched at all — no embedding model,
    // nothing indexed, or an index built in a different vector space. Both
    // used to arrive here as an empty document list and leave via ok:true
    // with no results, which reads to the operator as "your vault has nothing
    // about this" when the vault was never actually searched.
    const brainError = brain?.error || null;
    const brainUnavailable = brain?.unavailable || null;
    // Both brain signals go into ONE key, so they must be joined rather than
    // spread — an object literal with two `brain:` entries silently keeps the
    // last, and the fetch-level error would vanish behind the index message.
    // They come from mutually exclusive paths today; joining them means that
    // staying true is not a precondition for the report being complete.
    const brainNote = [
      brainError,
      brainUnavailable ? `${brainUnavailable.message} ${brainUnavailable.action}` : null,
    ].filter(Boolean).join(' — ');

    const degraded = {
      ...(webError ? { web: webError } : {}),
      ...(brainNote ? { brain: brainNote } : {}),
    };

    // ── Read the pages and answer, with numbered sources ──────────────
    //
    // /orion used to stop at the search and hand the terminal raw JSON — a list
    // of titles and 300-character excerpts, nothing read, nothing answered, no
    // links (CEO, 2026-09-07). The model does not browse; this block does:
    // fetch the top web hits, extract their text through the kernel, and hand
    // the model numbered sources it must cite. Second Brain hits ride along
    // as sources too, so an answer can draw on the vault and the web at once.
    const webHits = results.filter(r => r.source === 'web' && r.url).slice(0, 3);
    const { htmlToText } = require('../../../kernel/extract.cjs');
    const pageText = async (url) => {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'AEON/3 (+local)', Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' } });
        if (!r.ok) return null;
        const ct = r.headers.get('content-type') || '';
        const body = await r.text();
        const text = /html/i.test(ct) ? htmlToText(body) : body;
        return text.replace(/\s+/g, ' ').trim().slice(0, 6000) || null;
      } catch { return null; }
    };
    const pages = await Promise.all(webHits.map(h => pageText(h.url)));
    const sources = [];
    webHits.forEach((h, i) => sources.push({ n: sources.length + 1, title: h.title, url: h.url, text: pages[i] || h.excerpt || '', read: !!pages[i], kind: 'web' }));
    for (const r of results.filter(r => r.source === 'brain').slice(0, 2)) sources.push({ n: sources.length + 1, title: r.title, url: null, text: r.excerpt || '', read: true, kind: 'vault' });

    let answer = null, answerReason = null;
    if (typeof deps.kernelLLM === 'function' && sources.some(s => s.text)) {
      try {
        const packet = sources.filter(s => s.text).map(s => `[${s.n}] ${s.title}${s.url ? ` — ${s.url}` : ' (Second Brain)'}\n${s.text}`).join('\n\n');
        answer = String(await deps.kernelLLM(
          `Answer the operator's question from the numbered sources below and nothing else. Cite every claim with its source number in square brackets, like [2]. If the sources do not answer it, say so plainly. Be concrete and brief.\n\nQUESTION: ${q}\n\nSOURCES:\n${packet}`,
          { role: 'chat' },
        ) || '').trim() || null;
        if (!answer) answerReason = 'the model returned nothing';
      } catch (e) { answerReason = e.message; }
    } else if (typeof deps.kernelLLM !== 'function') {
      answerReason = 'no model is assigned to the chat role';
    } else {
      answerReason = 'nothing could be read';
    }

    // What the terminal prints — markdown, so the links are links.
    const lines = [];
    if (answer) lines.push(answer);
    else lines.push(`No synthesized answer — ${answerReason}.`);
    if (sources.length) {
      lines.push('', '**Sources**');
      for (const s of sources) lines.push(s.url ? `${s.n}. [${s.title}](${s.url})${s.read ? '' : ' — could not be read; excerpt only'}` : `${s.n}. ${s.title} — Second Brain`);
    }
    const blockHits = results.filter(r => r.source === 'block');
    if (blockHits.length) lines.push('', `Blocks: ${blockHits.map(b => b.title).join(', ')}`);
    if (degraded.web) lines.push('', `Web search unavailable — ${degraded.web}`);
    if (degraded.brain) lines.push('', `Second Brain: ${degraded.brain}`);

    res.json({
      ok: true, query: q,
      counts: { web: webBlocks.length, brain: brainDocs.length, block: (blocks || []).length },
      results,
      answer, ...(answerReason ? { answerReason } : {}),
      sources: sources.map(({ text, ...rest }) => rest),
      text: lines.join('\n'),
      ...(Object.keys(degraded).length ? { degraded } : {}),
    });
  });

  return router;
};
