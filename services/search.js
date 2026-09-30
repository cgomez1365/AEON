/**
 * AEON Jarvis — Web Search Service
 * DuckDuckGo scrape + Brave Search API → LLM synthesis. Powers /web.
 */
const express = require('express');
const https = require('https');
const crypto = require('crypto');

// How many hits a caller gets when it does not say. 5 is what the keyed
// providers always returned; DDG returned 3. The ceiling bounds one scrape.
const DEFAULT_COUNT = 5;
const MAX_COUNT = 30;
const clampCount = (n) => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? Math.min(v, MAX_COUNT) : DEFAULT_COUNT;
};

// A search key is printable ASCII with no spaces. Anything else (an inline
// .env comment, a pasted newline, quotes) cannot go in a header — Node throws
// "Invalid character in header content" and the whole web leg failed. Treat
// it as unset, once in the log, and let the next provider answer.
const _warnedKeys = new Set();
function searchKey(name) {
  const v = process.env[name];
  if (!v) return null;
  if (/^[\x21-\x7e]+$/.test(v)) return v;
  if (!_warnedKeys.has(name)) {
    _warnedKeys.add(name);
    console.warn(`[SEARCH] ${name} is set but is not a usable key (spaces or non-ASCII) — skipped. Re-enter it in Settings → Keys.`);
  }
  return null;
}

// What each keyed provider last said about its key. A 401/403 is the provider
// refusing the key (expired, revoked, a pasted "quoted" value — quotes pass the
// shape check above). The handlers never read the status: the error JSON parsed
// as "no results", every search paid a round trip and fell to DuckDuckGo with
// no log and no audit, and Settings kept showing "● connected". Keyed by env
// name and a fingerprint of the key, so a re-entered key starts clean.
const LABELS = { TAVILY_API_KEY: 'Tavily', SERPER_API_KEY: 'Serper', BRAVE_API_KEY: 'Brave' };
const _verdicts = new Map(); // name -> { fp, status, at }
const fingerprint = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const isRefusal = (status) => status === 401 || status === 403;
function recordKeyAnswer(name, key, status) {
  if (isRefusal(status)) _verdicts.set(name, { fp: fingerprint(key), status, at: new Date().toISOString() });
  else if (status >= 200 && status < 300) _verdicts.delete(name);
}

/**
 * The state of one search key, for Settings and anything that lists
 * providers: 'unset', 'malformed' (cannot be sent), 'rejected' (the provider
 * refused this exact key) or 'ok' (usable as far as AEON knows). No secrets.
 */
function searchKeyStatus(name) {
  const v = process.env[name];
  const label = LABELS[name] || name;
  if (!v) return { state: 'unset' };
  if (!/^[\x21-\x7e]+$/.test(v)) {
    return { state: 'malformed', reason: `${name} is set but is not a usable key (spaces or non-ASCII). Re-enter it in Settings → Keys.` };
  }
  const verdict = _verdicts.get(name);
  if (verdict && verdict.fp === fingerprint(v)) {
    return { state: 'rejected', status: verdict.status, at: verdict.at, reason: `${label} refused this key (HTTP ${verdict.status}). Re-enter it in Settings → Keys.` };
  }
  return { state: 'ok' };
}

// The cheapest request each provider answers with its verdict on the key —
// a one-result search. Sent only when asked for by name (test-provider with
// {probe:true}); never by a search, never by Settings opening.
const PROBES = {
  TAVILY_API_KEY: (key) => ['https://api.tavily.com/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: key, query: 'test', max_results: 1, search_depth: 'basic' }),
  }],
  SERPER_API_KEY: (key) => ['https://google.serper.dev/search', {
    method: 'POST', headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: 'test', num: 1 }),
  }],
  BRAVE_API_KEY: (key) => ['https://api.search.brave.com/res/v1/web/search?q=test&count=1', {
    method: 'GET', headers: { Accept: 'application/json', 'X-Subscription-Token': key },
  }],
};

/** Ask the provider whether the key works. { ok, status?, error? } */
async function probeSearchKey(name, fetchImpl = globalThis.fetch) {
  const label = LABELS[name] || name;
  if (!PROBES[name]) return { ok: false, error: `Unknown search provider: ${name}` };
  const st = searchKeyStatus(name);
  if (st.state === 'unset') return { ok: false, error: `No ${label} key (set ${name} in Settings → Keys)` };
  if (st.state === 'malformed') return { ok: false, error: st.reason };
  const key = process.env[name];
  const [url, init] = PROBES[name](key);
  let r;
  try { r = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(8000) }); }
  catch (e) { return { ok: false, error: `${label} could not be reached: ${e.message}` }; }
  recordKeyAnswer(name, key, r.status);
  if (r.ok) return { ok: true, status: r.status };
  return {
    ok: false, status: r.status,
    error: isRefusal(r.status)
      ? `${label} refused the key (HTTP ${r.status}). Re-enter it in Settings → Keys.`
      : `${label} answered HTTP ${r.status}.`,
  };
}

// DuckDuckGo Lite's result page → [{ title, url, snippet }], or null when the
// page carries no results (a block page, a layout change, an empty answer).
function parseDuckDuckGoLite(html, count = DEFAULT_COUNT) {
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
  if (links.length === 0) return null;

  const hits = [];
  for (let i = 0; i < Math.min(count, links.length, snippets.length); i++) {
    let actualUrl = links[i].url;
    if (actualUrl.includes('uddg=')) {
      const params = new URLSearchParams(actualUrl.split('?')[1]);
      if (params.has('uddg')) actualUrl = decodeURIComponent(params.get('uddg'));
    } else if (actualUrl.startsWith('//')) {
      actualUrl = 'https:' + actualUrl;
    }
    hits.push({ title: links[i].title, url: actualUrl, snippet: snippets[i] });
  }
  return hits;
}

const formatHit = (h) => `- **${h.title}**\n  ${h.snippet}\n  Source: [${h.url}](${h.url})`;

module.exports = ({ writeOSAudit, kernelLLM }) => {

  // A keyed provider that did not answer 2xx is said out loud — audited every
  // time, logged once per key and status — and handed on as "no results" so
  // the next provider answers. Returns true when the caller should stop.
  const _warnedAnswers = new Set();
  const refusedAnswer = (name, key, status, correlationId) => {
    recordKeyAnswer(name, key, status);
    if (status >= 200 && status < 300) return false;
    const label = LABELS[name];
    const refused = isRefusal(status);
    writeOSAudit(refused ? 'SEARCH_KEY_REJECTED' : 'SEARCH_PROVIDER_ERROR',
      `${label} answered HTTP ${status}${refused ? ` — ${name} was refused` : ''}; trying the next provider`,
      status, 0, correlationId);
    const once = `${name}:${status}:${fingerprint(key)}`;
    if (!_warnedAnswers.has(once)) {
      _warnedAnswers.add(once);
      console.warn(`[SEARCH] ${label} answered HTTP ${status}${refused ? ` — ${name} was refused. Re-enter it in Settings → Keys.` : ''} Trying the next provider.`);
    }
    return true;
  };

  // The hits themselves, [{ title, url, snippet }] or null. The citation gate
  // needs these; it was handed the markdown string below, read it as "no
  // results", and so Class 4 refused every question even when online
  // (reported by agent C2, 2026-09-23). One parse feeds both.
  const fetchDuckDuckGoHits = (query, correlationId, count = DEFAULT_COUNT) => {
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
          const hits = parseDuckDuckGoLite(html, count);
          if (!hits) {
            writeOSAudit('SEARCH_PARSE_ERROR', 'DDG regex yielded 0 results', 500, 0, correlationId);
            return resolve(null);
          }
          writeOSAudit('DDG_SEARCH_SUCCESS', `Query: ${query}`, 200, hits.length, correlationId);
          resolve(hits);
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

  // The chat and Deep Research read results as markdown.
  const fetchDuckDuckGo = async (query, correlationId, count = DEFAULT_COUNT) => {
    const hits = await fetchDuckDuckGoHits(query, correlationId, count);
    return hits ? hits.map(formatHit).join('\n\n') : null;
  };

  // ── Brave Search API ────────────────────────────────────────────────────
  const fetchBraveSearch = (query, correlationId, count = DEFAULT_COUNT) => {
    const apiKey = searchKey('BRAVE_API_KEY');
    if (!apiKey) return Promise.resolve(null);
    return new Promise((resolve) => {
      const options = {
        hostname: 'api.search.brave.com',
        path: `/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(count, 20)}`,
        method: 'GET',
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': apiKey },
      };
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          if (refusedAnswer('BRAVE_API_KEY', apiKey, res.statusCode, correlationId)) return resolve(null);
          try {
            const json = JSON.parse(data);
            const hits = (json.web?.results || []).slice(0, count);
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
  const fetchSerperSearch = (query, correlationId, count = DEFAULT_COUNT) => {
    const apiKey = searchKey('SERPER_API_KEY');
    if (!apiKey) return Promise.resolve(null);
    return new Promise((resolve) => {
      const body = JSON.stringify({ q: query, num: count });
      const req = https.request({
        hostname: 'google.serper.dev',
        path: '/search',
        method: 'POST',
        headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          if (refusedAnswer('SERPER_API_KEY', apiKey, res.statusCode, correlationId)) return resolve(null);
          try {
            const json = JSON.parse(data);
            const hits = (json.organic || []).slice(0, count);
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
  const fetchTavilySearch = (query, correlationId, count = DEFAULT_COUNT) => {
    const apiKey = searchKey('TAVILY_API_KEY');
    if (!apiKey) return Promise.resolve(null);
    return new Promise((resolve) => {
      const body = JSON.stringify({ api_key: apiKey, query, max_results: Math.min(count, 20), search_depth: 'basic' });
      const req = https.request({
        hostname: 'api.tavily.com',
        path: '/search',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          if (refusedAnswer('TAVILY_API_KEY', apiKey, res.statusCode, correlationId)) return resolve(null);
          try {
            const json = JSON.parse(data);
            const hits = (json.results || []).slice(0, count);
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
  //
  // `count` is how many hits the caller wants. Every provider used to hardcode
  // its own number (DDG 3, the keyed ones 5), so Orion's depth control — 8, 16,
  // 24 — changed nothing: the page said "24" and showed 3 (CEO, 2026-09-10).
  // Default stays 5 for callers that never asked.
  const fetchWebSearch = async (query, correlationId, count = DEFAULT_COUNT) => {
    count = clampCount(count);
    // A keyed provider that fails hands off to the next, down to DuckDuckGo —
    // one bad key must not take the whole web leg with it.
    for (const [name, fetcher] of [['TAVILY_API_KEY', fetchTavilySearch], ['SERPER_API_KEY', fetchSerperSearch], ['BRAVE_API_KEY', fetchBraveSearch]]) {
      if (!searchKey(name)) continue;
      try {
        const r = await fetcher(query, correlationId, count);
        if (r) return r;
      } catch (e) { console.warn(`[SEARCH] ${name.split('_')[0].toLowerCase()} failed (${e.message}) — trying the next provider`); }
    }
    return fetchDuckDuckGo(query, correlationId, count);
  };

  // Router: GET /api/search-web
  const router = express.Router();
  router.get('/search-web', async (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q) return res.status(400).json({ ok: false, error: 'q (query) required' });
    // BO-H4a — synthesis is the only slow leg here. Measured on 2026-08-08 with
    // no cloud key configured: DDG returned in ~1s, kernelLLM took 80-219s on a
    // local CPU model. Orion parses `results` and discards `answer` entirely, so
    // it was waiting minutes for prose it threw away — then aborting at its own
    // 15s budget and reporting zero web hits. Let a caller decline the half it
    // does not want instead of paying for it and timing out.
    const synthesize = req.query.synthesize !== '0';
    // `count` — how many hits to return; provider caps apply (Brave/Tavily 20).
    const count = clampCount(req.query.count);
    try {
      const results = await fetchWebSearch(q, req.correlationId, count);
      if (!results) return res.json({ ok: false, query: q, results: '', answer: 'No web results found.' });
      if (!synthesize) return res.json({ ok: true, query: q, results, answer: null });
      let answer = results;
      try {
        // BO-H4b — the catch below only fires on an error; a hang walks straight
        // past it, which is how this route blocked for 219s with a fallback
        // sitting right here. Bound it so the fallback is actually reachable.
        answer = await Promise.race([
          kernelLLM(
            `Live web search results for "${q}":\n\n${results}\n\nUsing ONLY these results, give a concise, accurate answer to the query. Cite sources inline as [title](url). If the results don't answer it, say so.`,
            { role: 'chat' }
          ),
          new Promise((_, rej) => setTimeout(() => rej(new Error('synthesis timed out')), 30000)),
        ]);
      } catch (e) { answer = results; /* raw results still ship — a complete answer with links beats nothing */ }
      res.json({ ok: true, query: q, results, answer });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return { fetchDuckDuckGo, fetchDuckDuckGoHits, parseDuckDuckGoLite, fetchBraveSearch, fetchSerperSearch, fetchTavilySearch, fetchWebSearch, router, clampCount, DEFAULT_COUNT, MAX_COUNT, searchKeyStatus, probeSearchKey };
};

// Stateless readers, usable without building the service (Settings lists
// provider state and runs the Test button through these).
module.exports.searchKeyStatus = searchKeyStatus;
module.exports.probeSearchKey = probeSearchKey;
