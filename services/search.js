/**
 * AEON Jarvis — Web Search Service
 * DuckDuckGo scrape + Brave Search API → LLM synthesis. Powers /web.
 */
const express = require('express');
const https = require('https');

module.exports = ({ writeOSAudit, kernelLLM }) => {

  const fetchDuckDuckGo = (query, correlationId) => {
    return new Promise((resolve) => {
      const url = 'https://lite.duckduckgo.com/lite/';
      const options = {
        method: 'POST',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      };

      const req = https.request(url, options, (res) => {
        let html = '';
        res.on('data', (c) => html += c);
        res.on('end', () => {
          const linkRegex = /<a rel="nofollow" href="([^"]+)" class='result-link'>([\s\S]*?)<\/a>/g;
          const snippetRegex = /<td class='result-snippet'>([\s\S]*?)<\/td>/g;

          const links = [];
          let match;
          while ((match = linkRegex.exec(html)) !== null) {
            links.push({ url: match[1], title: match[2].replace(/<[^>]*>?/gm, '').trim() });
          }
          const snippets = [];
          while ((match = snippetRegex.exec(html)) !== null) {
            snippets.push(match[1].replace(/<[^>]*>?/gm, '').trim());
          }

          if (links.length === 0) {
            writeOSAudit('SEARCH_PARSE_ERROR', 'DDG regex yielded 0 results', 500, 0, correlationId);
            return resolve(null);
          }

          const results = [];
          for (let i = 0; i < Math.min(3, links.length, snippets.length); i++) {
            let actualUrl = links[i].url;
            if (actualUrl.includes('uddg=')) {
              const params = new URLSearchParams(actualUrl.split('?')[1]);
              if (params.has('uddg')) actualUrl = decodeURIComponent(params.get('uddg'));
            } else if (actualUrl.startsWith('//')) {
              actualUrl = 'https:' + actualUrl;
            }
            results.push(`- **${links[i].title}**\n  ${snippets[i]}\n  Source: [${actualUrl}](${actualUrl})`);
          }
          writeOSAudit('DDG_SEARCH_SUCCESS', `Query: ${query}`, 200, results.length, correlationId);
          resolve(results.join('\n\n'));
        });
      });

      req.on('error', (err) => {
        writeOSAudit('SEARCH_PARSE_ERROR', `Scrape failed: ${err.message}`, 500, 0, correlationId);
        resolve(null);
      });

      req.setTimeout(5000, () => {
        req.destroy();
        writeOSAudit('SEARCH_TIMEOUT', `Scrape timed out after 5s`, 504, 0, correlationId);
        resolve(null);
      });

      req.write(`q=${encodeURIComponent(query)}`);
      req.end();
    });
  };

  // ── Brave Search API ────────────────────────────────────────────────────
  const fetchBraveSearch = (query, correlationId) => {
    const apiKey = process.env.BRAVE_API_KEY;
    if (!apiKey) return Promise.resolve(null);
    return new Promise((resolve) => {
      const options = {
        hostname: 'api.search.brave.com',
        path: `/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
        method: 'GET',
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': apiKey },
      };
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const hits = (json.web?.results || []).slice(0, 5);
            if (!hits.length) return resolve(null);
            const results = hits.map(h =>
              `- **${h.title}**\n  ${h.description || ''}\n  Source: [${h.url}](${h.url})`
            );
            writeOSAudit('BRAVE_SEARCH_SUCCESS', `Query: ${query}`, 200, hits.length, correlationId);
            resolve(results.join('\n\n'));
          } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(6000, () => { req.destroy(); resolve(null); });
      req.end();
    });
  };

  // ── Serper (Google via serper.dev) ──────────────────────────────────
  const fetchSerperSearch = (query, correlationId) => {
    const apiKey = process.env.SERPER_API_KEY;
    if (!apiKey) return Promise.resolve(null);
    return new Promise((resolve) => {
      const body = JSON.stringify({ q: query, num: 5 });
      const req = https.request({
        hostname: 'google.serper.dev',
        path: '/search',
        method: 'POST',
        headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const hits = (json.organic || []).slice(0, 5);
            if (!hits.length) return resolve(null);
            const results = hits.map(h =>
              `- **${h.title}**\n  ${h.snippet || ''}\n  Source: [${h.link}](${h.link})`
            );
            writeOSAudit('SERPER_SEARCH_SUCCESS', `Query: ${query}`, 200, hits.length, correlationId);
            resolve(results.join('\n\n'));
          } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(6000, () => { req.destroy(); resolve(null); });
      req.write(body);
      req.end();
    });
  };

  // ── Tavily ──────────────────────────────────────────────────────────
  const fetchTavilySearch = (query, correlationId) => {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) return Promise.resolve(null);
    return new Promise((resolve) => {
      const body = JSON.stringify({ api_key: apiKey, query, max_results: 5, search_depth: 'basic' });
      const req = https.request({
        hostname: 'api.tavily.com',
        path: '/search',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const hits = (json.results || []).slice(0, 5);
            if (!hits.length) return resolve(null);
            const results = hits.map(h =>
              `- **${h.title}**\n  ${h.content || ''}\n  Source: [${h.url}](${h.url})`
            );
            writeOSAudit('TAVILY_SEARCH_SUCCESS', `Query: ${query}`, 200, hits.length, correlationId);
            resolve(results.join('\n\n'));
          } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(8000, () => { req.destroy(); resolve(null); });
      req.write(body);
      req.end();
    });
  };

  // ── Unified search: best keyed provider, then DDG fallback ──────────
  // Priority: Tavily > Serper > Brave > DDG (Tavily returns answer+sources,
  // Serper hits Google, Brave is privacy-first — all better than DDG scraping)
  const fetchWebSearch = async (query, correlationId) => {
    if (process.env.TAVILY_API_KEY) {
      const r = await fetchTavilySearch(query, correlationId);
      if (r) return r;
    }
    if (process.env.SERPER_API_KEY) {
      const r = await fetchSerperSearch(query, correlationId);
      if (r) return r;
    }
    if (process.env.BRAVE_API_KEY) {
      const r = await fetchBraveSearch(query, correlationId);
      if (r) return r;
    }
    return fetchDuckDuckGo(query, correlationId);
  };

  // Router: GET /api/search-web
  const router = express.Router();
  router.get('/search-web', async (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q) return res.status(400).json({ ok: false, error: 'q (query) required' });
    try {
      const results = await fetchWebSearch(q, req.correlationId);
      if (!results) return res.json({ ok: false, query: q, results: '', answer: 'No web results found.' });
      let answer = results;
      try {
        answer = await kernelLLM(
          `Live web search results for "${q}":\n\n${results}\n\nUsing ONLY these results, give a concise, accurate answer to the query. Cite sources inline as [title](url). If the results don't answer it, say so.`,
          { role: 'chat' }
        );
      } catch (e) { /* fall back to raw results if synthesis fails */ }
      res.json({ ok: true, query: q, results, answer });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return { fetchDuckDuckGo, fetchBraveSearch, fetchSerperSearch, fetchTavilySearch, fetchWebSearch, router };
};
