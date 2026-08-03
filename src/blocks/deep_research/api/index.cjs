// routes/research.js — Deep Research router
// LLM-in-the-loop autonomous web search, synthesis, and comparison engine.
// Stores research state as JSON files on disk under WORKSPACE/deep_research/.
const express = require('express');
const { vaultSync } = require('../../../kernel/vaultSync.cjs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const EventEmitter = require('events');
const { isCloud: _isCloud } = require('../../../kernel/runtime.cjs');

const SESSION_ID_RE = /^[a-zA-Z0-9-]{1,128}$/;

// ── APA 7th-edition reference list (deterministic, not LLM-written) ────────
// The LLM used to write its own "## References" section under a loose
// "APA7-style" instruction. LLMs are unreliable at exact citation mechanics
// (they kept using "Retrieved from URL", which APA 7 actually dropped for
// most web sources — that convention is APA 6) and every run produced
// slightly different formatting. Building it here means every report gets
// the same correct element order and a real hyperlink, every time.
// Note: in-text citations stay the existing bracketed [N] numbered scheme
// (cross-referenced to this list in citation order) rather than switching to
// APA's (Author, Year) parenthetical style — that would mean rewriting the
// citation-chip linking, the writer prompt's citation rules, and chart
// placement, none of which this pass touches. This scoping covers what
// "resolves in APA 7" most commonly means for a generated report: correct,
// consistent, real reference entries — not a full in-text citation rewrite.
// The URL-harvest regex excludes brackets/quotes/whitespace but not
// parentheses (a legitimate part of some URLs, e.g. Wikipedia's
// "/wiki/Example_(disambiguation)"), so a URL cited in prose as
// "(https://example.com)" was capturing its wrapping close-paren as part of
// the URL — creating a duplicate, malformed source with a broken archive
// lookup and a stray ")" in the rendered citation. Only strips a trailing
// ')' when it isn't balanced by an earlier '(' in the same URL.
function cleanUrl(u) {
  u = (u || '').replace(/[.,;:!?'"]+$/, '');
  while (u.endsWith(')') && (u.match(/\(/g) || []).length < (u.match(/\)/g) || []).length) {
    u = u.slice(0, -1);
  }
  return u;
}

function siteNameFromUrl(url) {
  try {
    const labels = new URL(url).hostname.split('.');
    // "en.wikipedia.org" -> "wikipedia": the registrable-domain label is the
    // one immediately before the TLD, not everything before the last dot —
    // joining all of them turned subdomains like "en." or "www." into part
    // of the name itself ("En Wikipedia" instead of "Wikipedia").
    const base = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
    return base.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  } catch { return 'Unknown Source'; }
}

function buildApaReferences(sources) {
  if (!sources || !sources.length) return '';
  const entries = sources.map((s, i) => {
    const site = siteNameFromUrl(s.url || '');
    const title = (s.title || site).replace(/\s+/g, ' ').trim();
    // APA 7 web-page format: Author/Site. (Date or n.d.). *Title*. URL
    // No "Retrieved from" — that phrase is only added for content expected
    // to change (a live wiki page, a social feed), which search-derived
    // sources aren't assumed to be by default.
    let line = `${i + 1}. ${site}. (n.d.). *${title}*. [${s.url}](${s.url})`;
    // A real "·" character, not an HTML entity — the whole markdown string
    // passes through esc() before any of this is rendered, so a literal
    // "&nbsp;" here would come out the other side as the visible text
    // "&amp;nbsp;" instead of a space.
    if (s.archived_url) line += ` · [Archived version](${s.archived_url})`;
    return line;
  });
  return `## References\n\n${entries.join('\n\n')}`;
}

// Strip whatever "## References" section the model wrote (defensive — the
// writer prompt no longer asks for one, but older/other-model behavior can't
// be fully guaranteed) so the deterministic one below is the only one.
function stripLlmReferences(markdown) {
  return markdown.replace(/\n##\s*References[\s\S]*$/i, '').trimEnd();
}

// Best-effort Wayback Machine lookup — an EXISTING snapshot only, never
// triggers a new capture (that would be slow and hammer archive.org for
// every report). A citation link that later 404s is a known research-report
// failure mode; this gives readers a fallback without adding real latency
// risk (short timeout, run in parallel, failures are silently absent).
async function resolveArchivedUrl(url) {
  try {
    const r = await fetch(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(3000) });
    const d = await r.json();
    return d?.archived_snapshots?.closest?.url || null;
  } catch { return null; }
}
async function attachArchivedLinks(sources) {
  const results = await Promise.allSettled(sources.map(s => resolveArchivedUrl(s.url)));
  results.forEach((r, i) => { if (r.status === 'fulfilled' && r.value) sources[i].archived_url = r.value; });
  return sources;
}

module.exports = function createResearchRouter(deps) {
  const router = express.Router();
  const { getLocalFile, getDataFile, geminiRequest, kernelLLM, writeOSAudit,
          fetchDuckDuckGo, fetchBraveSearch, fetchSerperSearch, fetchTavilySearch, fetchWebSearch } = deps;

  // max_tokens must be explicit — every provider path in services/ai.js
  // defaults to a 4096-token output cap when none is passed, which is fine
  // for short planning/extraction calls but silently starves the long-form
  // report write (the multi-section academic report plus references routinely
  // runs past 4096 tokens and throws mid-generation instead of truncating).
  const llm = (prompt, opts = {}) => kernelLLM
    ? kernelLLM(prompt, { role: 'research', background: true, max_tokens: 4096, ...opts })
    : geminiRequest(prompt, 'AEON-RESEARCH', opts);

  // searchFor: pick the right search function by explicit provider name
  const searchFor = (provider) => {
    if (provider === 'tavily'     && fetchTavilySearch) return fetchTavilySearch;
    if (provider === 'serper'     && fetchSerperSearch) return fetchSerperSearch;
    if (provider === 'brave'      && fetchBraveSearch)  return fetchBraveSearch;
    if (provider === 'duckduckgo')                      return fetchDuckDuckGo;
    return fetchWebSearch || fetchDuckDuckGo; // auto
  };

  // On Vercel the repo FS is read-only and block data dirs are vercelignored —
  // an unguarded mkdir here crashed the whole factory, 404ing every /research
  // route on the web. Local disk is the source locally; Supabase on the web.
  const isVercel = require('../../../kernel/runtime.cjs').isCloud();
  // Was `path.join(__dirname, '../../data')` — from src/blocks/deep_research/api/,
  // '../../data' resolves to src/blocks/data/, NOT src/blocks/deep_research/data/
  // as intended. Reports had been silently landing in a stray sibling folder
  // (which also carried a hollow, code-less "data" block manifest) since
  // whenever that path was written. getDataFile() resolves from repo ROOT and
  // namespaces by block id, so this class of depth miscalculation can't recur.
  const RESEARCH_DIR = getDataFile
    ? getDataFile('deep_research/reports')
    : (isVercel ? require('path').join('/tmp', 'deep_research') : require('path').join(__dirname, '../../data'));
  try { if (!fs.existsSync(RESEARCH_DIR)) fs.mkdirSync(RESEARCH_DIR, { recursive: true }); } catch {}

  // ── In-memory task registry ────────────────────────────────────
  // { [sessionId]: { status, query, owner, progress, result, sources,
  //                  raw_findings, started_at, category, _proc, _emitter } }
  const activeTasks = {};

  // ── Helpers ────────────────────────────────────────────────────

  function validateSessionId(id) {
    if (!SESSION_ID_RE.test(id)) return false;
    return true;
  }

  function readResearchJSON(sessionId) {
    const p = path.join(RESEARCH_DIR, `${sessionId}.json`);
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
  }

  function writeResearchJSON(sessionId, data) {
    const p = path.join(RESEARCH_DIR, `${sessionId}.json`);
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  }

  function ownsTask(sessionId, _user) {
    const entry = activeTasks[sessionId];
    if (entry) return true;
    const disk = readResearchJSON(sessionId);
    if (!disk) return false;
    return true;
  }

  // ── Research engine (runs in-process) ──────────────────────────
  // Instead of a Python subprocess, this uses the LLM endpoint directly
  // via the server's existing geminiRequest helper + DuckDuckGo scraping.

  async function runResearchLoop(sessionId, opts) {
    const task = activeTasks[sessionId];
    if (!task) return;

    const { query: rawQuery, maxRounds, maxTime, searchProvider, category } = opts;
    const startTime = Date.now();
    const deadline = startTime + (maxTime || 300) * 1000;
    const rounds = maxRounds || 8;

    const allSources = [];
    const allFindings = [];
    let subQueries = [];
    let charts = [];

    const updateProgress = (phase, extra = {}) => {
      task.progress = {
        phase,
        round: extra.round || task.progress.round || 0,
        queries: extra.queries || 0,
        total_sources: allSources.length,
        total_findings: allFindings.length,
        ...extra,
      };
      task._emitter.emit('progress', task.progress);
    };

    try {
      // Phase 0: Query cleanup — the user's input may have dropped characters
      // (a flaky keyboard misses keys under light presses) or be an unpunctuated
      // brain-dump. Reconstruct intent before it ever hits a search engine or an
      // LLM prompt, so garbage-in doesn't become garbage-out downstream.
      updateProgress('cleaning_query');
      let query = rawQuery;
      try {
        const cleanupPrompt = `Reconstruct the user's intended research query from raw, possibly-broken input.

Known input issues to correct for:
- Dropped/missing letters from specific keys on a flaky keyboard (frequently affected keys: s, c, t, p, 7, -, +, 6, \\). A missing letter often turns a real word into a near-word (e.g. "erch" -> "search", "reearch" -> "research", "-1" or missing dashes/numbers in things like model names or dates).
- Unpunctuated stream-of-consciousness phrasing ("brain dump") that should be read as a single coherent topic/question, not corrected into different content.
- Ordinary typos and missing spaces.

Rules:
- Fix spelling, missing letters, and grammar ONLY. Never add a topic, entity, or fact that wasn't implied by the raw input.
- Preserve proper nouns, tickers, model numbers, and dates as closely as possible to what was typed — only repair them if the correction is unambiguous (e.g. "nvda" for a company clearly about GPUs stays as-is or expands to "Nvidia" only if contextually obvious).
- If the raw input is already clean, return it unchanged.
- Return ONLY the corrected query as one line of plain text. No quotes, no explanation, no markdown.

Raw input: "${rawQuery}"`;
        const fixed = await llm(cleanupPrompt);
        const t = (fixed || '').trim().replace(/^["'`]+|["'`]+$/g, '').split('\n')[0].trim();
        if (t && t.length > 1 && t.length < 400) query = t;
      } catch {}
      const queryWasCorrected = query.trim().toLowerCase() !== rawQuery.trim().toLowerCase();

      // Phase 1: Planning — ask the LLM to generate sub-queries
      updateProgress('planning');

      const planPrompt = `You are a research assistant. Given the following research query, generate 3-5 specific web search sub-queries that would help thoroughly answer it. Return ONLY a JSON array of strings, no other text.

Research query: "${query}"

${category ? `Research category/format: ${category}` : ''}

Return format: ["sub-query 1", "sub-query 2", ...]`;

      try {
        const planResult = await llm(planPrompt);
        const cleaned = (planResult || '').replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed)) subQueries = parsed.slice(0, 6);
      } catch (e) {
        subQueries = [query];
      }

      if (!subQueries.length) subQueries = [query];

      // Phase 1.5: Orion scrape — seed with structured data before deep rounds
      try {
        updateProgress('searching', { round: 0, queries: 0 });
        const orionSearches = [query, `${query} contact email phone`];
        for (const oq of orionSearches) {
          let orionCtx = '';
          try { orionCtx = await searchFor(searchProvider)(oq, `RESEARCH-${sessionId}`); } catch {}
          if (orionCtx && orionCtx.length > 50) {
            const urlMatches = (orionCtx.match(/https?:\/\/[^\s<>"{}|\\^`\[\]]+/g) || []).map(cleanUrl);
            for (const url of urlMatches.slice(0, 3)) {
              if (!allSources.some(s => s.url === url)) {
                allSources.push({ url, title: url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0] });
              }
            }
            allFindings.push({ title: `Orion Scrape: ${oq}`, url: '', summary: orionCtx.slice(0, 3000), round: 0 });
          }
        }
        if (allFindings.length > 0) {
          console.log(`[RESEARCH] Orion seeded ${allFindings.length} findings, ${allSources.length} sources`);
        }
      } catch {}

      // Phase 2: Search + Read rounds
      for (let round = 1; round <= rounds; round++) {
        if (Date.now() > deadline) break;
        if (task.status === 'cancelled') return;

        const roundQuery = round <= subQueries.length
          ? subQueries[round - 1]
          : `${query} — deeper aspect ${round}`;

        updateProgress('searching', { round, queries: round });

        // Web search — Brave if keyed, DuckDuckGo as fallback
        let searchContext = '';
        try {
          searchContext = await searchFor(searchProvider)(roundQuery, `RESEARCH-${sessionId}`);
        } catch (e) {
          searchContext = '';
        }

        if (!searchContext || searchContext.length < 50) continue;

        // Parse out source URLs from the search context
        const urlMatches = (searchContext.match(/https?:\/\/[^\s<>"{}|\\^`\[\]]+/g) || []).map(cleanUrl);
        const newUrls = urlMatches.slice(0, 5).filter(u => !allSources.some(s => s.url === u));
        for (const url of newUrls) {
          allSources.push({ url, title: url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0] });
        }

        updateProgress('reading', { round, total_sources: allSources.length });

        // Phase: Analyze this round's findings with LLM
        updateProgress('analyzing', { round, total_findings: allFindings.length });

        const analyzePrompt = `You are a research analyst. Extract the key findings from these search results related to the query "${roundQuery}".

Search results:
${searchContext.slice(0, 6000)}

Return a concise summary of the most important facts, data points, and claims found. Focus on accuracy and specificity.`;

        try {
          const finding = await llm(analyzePrompt);
          if (finding) {
            allFindings.push({
              title: roundQuery,
              url: newUrls[0] || '',
              summary: finding,
              round,
            });
          }
        } catch (e) {
          // Continue to next round
        }

        if (task.status === 'cancelled') return;
      }

      // Phase 2.5: Data extraction — pull real, sourced numbers into chartable
      // series. This only fires when the findings actually contain figures;
      // it never invents data, and skips silently (empty array) otherwise.
      updateProgress('extracting_data', { total_sources: allSources.length });
      try {
        const dataPrompt = `Look at these research findings for the query "${query}" and decide whether they contain real, quantifiable data worth charting — financial figures, statistics over time, percentages, counts, or named-entity comparisons.

FINDINGS:
${allFindings.map(f => `${f.title}: ${f.summary}`).join('\n\n').slice(0, 8000)}

Rules:
- Only extract numbers that are explicitly present in the findings above. Never invent, estimate, or interpolate a number that isn't stated.
- If nothing in the findings is genuinely chartable, return an empty array: []
- Otherwise return up to 3 charts as a JSON array. Each item:
  {"type": "bar" | "line", "title": "short chart title", "labels": ["...", "..."], "series": [{"name": "series name", "data": [number, ...]}]}
- "labels" are the x-axis categories (e.g. quarters, years, competitor names) and must line up 1:1 with each series' "data" array.
- Use "line" for a trend over time, "bar" for a comparison across categories.

Return ONLY the JSON array, no other text.`;
        const raw = await llm(dataPrompt);
        const cleanedJson = (raw || '').replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(cleanedJson);
        if (Array.isArray(parsed)) {
          charts = parsed.filter(c => c && c.title && Array.isArray(c.labels) && Array.isArray(c.series) && c.series.length > 0
            && c.series.every(s => Array.isArray(s.data) && s.data.length === c.labels.length && s.data.every(v => typeof v === 'number' && Number.isFinite(v)))
          ).slice(0, 3);
        }
      } catch { charts = []; }

      // Phase 3: Write final report
      updateProgress('writing', { total_sources: allSources.length });

      const categoryInstruction = category
        ? `Additionally, lean the analysis toward a "${category}" angle (${
            category === 'comparison' ? 'use comparison tables and side-by-side analysis' :
            category === 'product' ? 'focus on product specs, pricing, pros/cons' :
            category === 'howto' ? 'use numbered steps and practical instructions' :
            category === 'factcheck' ? 'use claim → evidence → verdict structure' :
            'standard research report'
          }) without dropping any of the required sections below.`
        : '';

      const numberedSources = allSources.map((s, i) => `[${i + 1}] ${s.title || s.url} — ${s.url}`).join('\n') || '(no live sources retrieved — state this explicitly in the report and do not use any [N] citations)';

      const writePrompt = `You are a research analyst producing a college-level report. Write to the rigor of an academic deliverable — this is true even for simple or narrow queries; a one-fact query still gets the full structure below, just with shorter sections.

ORIGINAL QUERY: ${query}
${categoryInstruction}

FINDINGS (raw material — synthesize, do not just restate):
${allFindings.map((f, i) => `\n--- Finding ${i + 1}: ${f.title} ---\n${f.summary}`).join('\n')}

NUMBERED SOURCE LIST — cite ONLY from this exact list, using its exact numbers:
${numberedSources}

CHARTS AVAILABLE ${charts.length ? `(index them from 0)` : '(none)'}:
${charts.length ? charts.map((c, i) => `[CHART:${i}] ${c.title}`).join('\n') : '(no chartable data was found — do not insert any [CHART:i] placeholders)'}
${charts.length ? 'Insert each chart placeholder (e.g. "[CHART:0]") on its own line at the single most relevant point in the Findings section, immediately after the sentence(s) it supports. Use every chart listed exactly once. Do not describe the chart\'s data in prose right before it if the chart already shows it — reference it briefly instead (e.g. "as shown below [CHART:0]").' : ''}

CITATION RULES (mandatory, non-negotiable):
- Every factual claim, statistic, date, or quote must end with an inline citation in the form [N], where N matches the NUMBERED SOURCE LIST above.
- Never invent a citation number that isn't in the list. Never leave a specific claim uncited.
- A sentence can carry multiple citations if multiple sources support it, e.g. "...grew sharply in 2023 [2][4]."
- If a claim is your own synthesis/inference rather than a sourced fact, don't cite it — but keep synthesis clearly separated from sourced fact.

REQUIRED STRUCTURE (Markdown headings, in this order — do not skip or merge sections even for a simple topic):
# ${query}
## Abstract
A 3-5 sentence summary of what was researched and the core answer/finding, written for someone who will only read this section.
## Introduction
Frame the topic: what it is, why it matters, and the scope of this report.
## Methodology
1-2 sentences on how this was researched (live web search across ${allSources.length} source${allSources.length === 1 ? '' : 's'}, multi-round query expansion). Be honest about coverage limits.
## Findings
The core body. Organize into thematic subsections (## or ### headings) rather than a flat list — group related facts, don't just restate findings 1-by-1. Every claim cited per the rules above.
## Discussion
Synthesize across findings: what patterns, tensions, or open questions emerge. This is where you connect the dots the raw findings don't connect on their own.
## Limitations
What this report could not confirm, where sources disagreed, or what a deeper investigation would need to check.
## Conclusion
Direct answer to the original query in 3-5 sentences, plus one forward-looking note if relevant.

Do NOT write a References section — it is generated automatically after your report from the exact source list, in proper APA 7th-edition format. Stop after Conclusion.

Write in full prose (not bullet dumps) except where a table or numbered steps genuinely serve the content better. Be thorough but do not pad — every sentence should carry information.`;

      let report = '';
      let writeError = null;
      try {
        report = await llm(writePrompt, { max_tokens: 8192, timeout_ms: 300000 });
      } catch (e) {
        writeError = e && e.message ? e.message : String(e);
        try { console.error(`[RESEARCH] report write failed for "${query}": ${writeError}`); } catch {}
        // Retry once with a compressed prompt — the first attempt may have
        // failed on provider input-size limits (some free-tier models cap
        // total context well under what the full findings dump needs), not
        // just output length. Trim findings and drop the heaviest instructions.
        try {
          const compactFindings = allFindings.map((f, i) => `\n--- Finding ${i + 1}: ${f.title} ---\n${(f.summary || '').slice(0, 800)}`).join('\n');
          const compactPrompt = `Write a well-structured research report in Markdown answering: "${query}"

Use these numbered sources for inline [N] citations (cite exact numbers only):
${numberedSources}

FINDINGS:
${compactFindings}

Structure: # Title, ## Abstract, ## Findings (thematic, cited), ## Conclusion. Do NOT write a References section — it is generated automatically afterward. Be thorough but concise.`;
          report = await llm(compactPrompt, { max_tokens: 6144 });
          writeError = null;
        } catch (e2) {
          report = `# ${query}\n\n**Report generation failed after retry** — the research provider returned an error (${writeError}). Raw findings are listed below; check /api/system/provider-health for account/key status.\n\n${
            allFindings.map(f => `## ${f.title}\n${f.summary}\n${f.url ? `Source: ${f.url}` : ''}`).join('\n\n')
          }`;
        }
      }

      // Deterministic, correctly-formatted APA 7 reference list — replaces
      // whatever (unreliable) References section the model may still have
      // written, then attaches a best-effort archived-snapshot link per
      // source so a citation surviving a dead live link isn't a dead end.
      updateProgress('citing', { total_sources: allSources.length });
      await attachArchivedLinks(allSources);
      report = `${stripLlmReferences(report)}\n\n${buildApaReferences(allSources)}`;

      // Persist to disk
      const elapsed = Date.now() - startTime;
      const researchData = {
        query,
        original_query: queryWasCorrected ? rawQuery : undefined,
        query_corrected: queryWasCorrected,
        category: category || '',
        result: report,
        sources: allSources,
        raw_findings: allFindings,
        charts,
        status: 'done',
        started_at: Math.floor(startTime / 1000),
        completed_at: Math.floor(Date.now() / 1000),
        stats: {
          Duration: `${Math.round(elapsed / 1000)}s`,
          Rounds: String(Math.min(allFindings.length, rounds)),
          Sources: String(allSources.length),
        },
      };

      writeResearchJSON(sessionId, researchData);

      // vault sync — fire-and-forget
      try {
        const _rdFiles = fs.readdirSync(RESEARCH_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));
        vaultSync('research', { reports: { value: _rdFiles.length, unit: 'count', context: 'completed research reports on disk' }, last_report: { value: query, unit: 'text', context: 'last research query completed' }, status: { value: 'completed', unit: 'text', context: 'latest research status' }, _summary: `Research completed: "${query}" — ${allSources.length} sources` });
      } catch(e) { /* non-critical */ }

      task.status = 'done';
      task.result = report;
      task.sources = allSources;
      task.raw_findings = allFindings;
      task.charts = charts;
      task.query = query;
      task.original_query = queryWasCorrected ? rawQuery : undefined;
      task.query_corrected = queryWasCorrected;
      task.progress = { phase: 'done', total_sources: allSources.length, total_findings: allFindings.length };
      task._emitter.emit('progress', { ...task.progress, status: 'done', final: true });

      if (writeOSAudit) {
        writeOSAudit(`RESEARCH-${sessionId}`, `Deep Research completed: "${query}" — ${allSources.length} sources, ${allFindings.length} findings`);
      }

    } catch (err) {
      task.status = 'error';
      task.result = err.message;
      task.progress = { phase: 'error' };
      task._emitter.emit('progress', { status: 'error', error: err.message, final: true });
    }
  }

  // ── Routes ─────────────────────────────────────────────────────

  // GET /research/active — list running tasks
  router.get('/research/active', (req, res) => {
    const active = [];
    for (const [sid, entry] of Object.entries(activeTasks)) {
      if (entry.status === 'running') {
        active.push({
          session_id: sid,
          query: entry.query || '',
          status: 'running',
          progress: entry.progress || {},
          started_at: entry.started_at || 0,
        });
      }
    }
    res.json({ active });
  });

  // GET /research/status/:sessionId
  router.get('/research/status/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    if (!validateSessionId(sessionId)) return res.status(400).json({ error: 'Invalid session ID' });

    const entry = activeTasks[sessionId];
    if (entry) {
      return res.json({
        status: entry.status,
        progress: entry.progress || {},
        query: entry.query,
      });
    }
    const disk = readResearchJSON(sessionId);
    if (disk) {
      return res.json({
        status: disk.status || 'done',
        progress: {},
        query: disk.query,
      });
    }
    res.status(404).json({ error: 'No research found' });
  });

  // POST /research/cancel/:sessionId
  router.post('/research/cancel/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    if (!validateSessionId(sessionId)) return res.status(400).json({ error: 'Invalid session ID' });

    const entry = activeTasks[sessionId];
    if (!entry) return res.json({ cancelled: false });

    entry.status = 'cancelled';
    entry._emitter.emit('progress', { status: 'cancelled', final: true });
    res.json({ cancelled: true });
  });

  // POST /research/result/:sessionId — get + clear
  router.post('/research/result/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    if (!validateSessionId(sessionId)) return res.status(400).json({ error: 'Invalid session ID' });

    const entry = activeTasks[sessionId];
    if (entry && entry.result) {
      const result = entry.result;
      const sources = entry.sources || [];
      const raw_findings = entry.raw_findings || [];
      const charts = entry.charts || [];
      const query = entry.query;
      const original_query = entry.original_query;
      const query_corrected = !!entry.query_corrected;
      delete activeTasks[sessionId];
      return res.json({ result, sources, raw_findings, charts, query, original_query, query_corrected });
    }
    const disk = readResearchJSON(sessionId);
    if (disk) {
      return res.json({
        result: disk.result || '',
        sources: disk.sources || [],
        raw_findings: disk.raw_findings || [],
        charts: disk.charts || [],
        query: disk.query,
        original_query: disk.original_query,
        query_corrected: !!disk.query_corrected,
      });
    }
    res.status(404).json({ error: 'No research result available' });
  });

  // POST /research/result-peek/:sessionId — get WITHOUT clearing
  router.post('/research/result-peek/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    if (!validateSessionId(sessionId)) return res.status(400).json({ error: 'Invalid session ID' });

    const entry = activeTasks[sessionId];
    if (entry && entry.result) {
      return res.json({
        result: entry.result,
        sources: entry.sources || [],
        raw_findings: entry.raw_findings || [],
        charts: entry.charts || [],
        category: entry.category || '',
        query: entry.query,
        original_query: entry.original_query,
        query_corrected: !!entry.query_corrected,
      });
    }
    const disk = readResearchJSON(sessionId);
    if (disk) {
      return res.json({
        result: disk.result || '',
        sources: disk.sources || [],
        raw_findings: disk.raw_findings || [],
        charts: disk.charts || [],
        category: disk.category || '',
        query: disk.query,
        original_query: disk.original_query,
        query_corrected: !!disk.query_corrected,
      });
    }
    res.status(404).json({ error: 'No research result available' });
  });

  // GET /research/report/:sessionId — visual HTML report
  router.get('/research/report/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    if (!validateSessionId(sessionId)) return res.status(400).json({ error: 'Invalid session ID' });

    const disk = readResearchJSON(sessionId);
    if (!disk || !disk.result) return res.status(404).json({ error: 'No report available' });

    const html = buildReportHTML(disk);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });

  // GET /research/library — list completed research
  // Local: JSON files on disk. Web/Vercel: the Supabase mirror the UI writes
  // on every completed run (aeon_blocks · block_tag=research_library) — all
  // data flows through Supabase so the library is identical on every device.
  router.get('/research/library', async (req, res) => {
    const { search, sort = 'recent', limit = 50, archived = 'false' } = req.query;
    const wantArchived = archived === 'true';
    const items = [];

    if (isVercel && deps.supabase) {
      try {
        const { data: rows } = await deps.supabase
          .from('aeon_blocks').select('payload').eq('block_tag', 'research_library');
        let cloud = rows?.[0]?.payload || [];
        if (search) cloud = cloud.filter(i => (i.query || '').toLowerCase().includes(String(search).toLowerCase()));
        cloud.sort((a, b) => (b.completed_at || 0) - (a.completed_at || 0));
        return res.json({ research: cloud.slice(0, parseInt(limit) || 50), total: cloud.length });
      } catch (e) { return res.json({ research: [], total: 0, error: e.message }); }
    }

    let files;
    // Exclude dotfiles (.aeon.runtime.json) and _-prefixed internals — they are
    // not research runs; listing them showed a bogus row that failed to delete.
    try { files = fs.readdirSync(RESEARCH_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_') && !f.startsWith('.')); } catch { files = []; }

    for (const f of files) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(RESEARCH_DIR, f), 'utf8'));
        if (!!d.archived !== wantArchived) continue;
        const query = d.query || '';
        if (search && !query.toLowerCase().includes(search.toLowerCase())) continue;
        const sources = d.sources || [];
        items.push({
          id: f.replace('.json', ''),
          query,
          category: d.category || '',
          source_count: sources.length,
          status: d.status || 'done',
          duration: (d.stats && d.stats.Duration) || '',
          rounds: (d.stats && d.stats.Rounds) || '',
          started_at: d.started_at || 0,
          completed_at: d.completed_at || 0,
          archived: !!d.archived,
        });
      } catch { continue; }
    }

    // Sort
    if (sort === 'recent') items.sort((a, b) => (b.completed_at || 0) - (a.completed_at || 0));
    else if (sort === 'oldest') items.sort((a, b) => (a.completed_at || 0) - (b.completed_at || 0));
    else if (sort === 'most-messages') items.sort((a, b) => b.source_count - a.source_count);
    else if (sort === 'alpha') items.sort((a, b) => a.query.toLowerCase().localeCompare(b.query.toLowerCase()));

    res.json({ research: items.slice(0, parseInt(limit) || 50), total: items.length });
  });

  // GET /research/detail/:sessionId
  router.get('/research/detail/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    if (!validateSessionId(sessionId)) return res.status(400).json({ error: 'Invalid session ID' });
    const disk = readResearchJSON(sessionId);
    if (!disk) return res.status(404).json({ error: 'Research not found' });
    res.json(disk);
  });

  // POST /research/:sessionId/archive
  router.post('/research/:sessionId/archive', (req, res) => {
    const { sessionId } = req.params;
    if (!validateSessionId(sessionId)) return res.status(400).json({ error: 'Invalid session ID' });
    const wantArchived = req.query.archived !== 'false';
    const disk = readResearchJSON(sessionId);
    if (!disk) return res.status(404).json({ error: 'Research not found' });
    disk.archived = wantArchived;
    writeResearchJSON(sessionId, disk);
    res.json({ ok: true, id: sessionId, archived: wantArchived });
  });

  // DELETE /research/:sessionId
  router.delete('/research/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    if (!validateSessionId(sessionId)) return res.status(400).json({ error: 'Invalid session ID' });
    const p = path.join(RESEARCH_DIR, `${sessionId}.json`);
    let deleted = false;
    if (fs.existsSync(p)) { fs.unlinkSync(p); deleted = true; }
    res.json({ deleted });
  });

  // POST /research/:sessionId/hide-image
  router.post('/research/:sessionId/hide-image', (req, res) => {
    const { sessionId } = req.params;
    if (!validateSessionId(sessionId)) return res.status(400).json({ error: 'Invalid session ID' });
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });
    const disk = readResearchJSON(sessionId);
    if (!disk) return res.status(404).json({ error: 'Research not found' });
    if (!disk.hidden_images) disk.hidden_images = [];
    if (!disk.hidden_images.includes(url)) disk.hidden_images.push(url);
    writeResearchJSON(sessionId, disk);
    res.json({ ok: true });
  });

  // POST /research/:sessionId/unhide-images
  router.post('/research/:sessionId/unhide-images', (req, res) => {
    const { sessionId } = req.params;
    if (!validateSessionId(sessionId)) return res.status(400).json({ error: 'Invalid session ID' });
    const disk = readResearchJSON(sessionId);
    if (!disk) return res.status(404).json({ error: 'Research not found' });
    disk.hidden_images = [];
    writeResearchJSON(sessionId, disk);
    res.json({ ok: true });
  });

  // POST /research/start — launch a new research job
  router.post('/research/start', async (req, res) => {
    if (_isCloud()) {
      return res.status(503).json({ error: 'Deep Research requires the local AEON server (multi-round LLM pipeline exceeds cloud timeout). Run from localhost or relay via /scrape in the terminal.' });
    }
    const { query, max_rounds = 0, search_provider, max_time = 300, category } = req.body;
    if (!query || !query.trim()) return res.status(400).json({ error: 'query is required' });

    const sessionId = `rp-${crypto.randomBytes(6).toString('hex')}`;
    const effectiveMaxRounds = max_rounds > 0 ? Math.min(max_rounds, 20) : 8;

    const emitter = new EventEmitter();
    activeTasks[sessionId] = {
      status: 'running',
      query: query.trim(),
      category: category || '',
      progress: { phase: 'planning', round: 0 },
      result: null,
      sources: [],
      raw_findings: [],
      started_at: Math.floor(Date.now() / 1000),
      _emitter: emitter,
    };

    // Fire-and-forget — the SSE stream will relay progress
    runResearchLoop(sessionId, {
      query: query.trim(),
      maxRounds: effectiveMaxRounds,
      maxTime: Math.min(Math.max(max_time, 60), 1800),
      searchProvider: search_provider || null,
      category: category || null,
    }).catch(err => {
      const task = activeTasks[sessionId];
      if (task) {
        task.status = 'error';
        task.result = err.message;
        task._emitter.emit('progress', { status: 'error', error: err.message, final: true });
      }
    });

    res.json({ session_id: sessionId, status: 'running', query: query.trim() });
  });

  // GET /research/stream/:sessionId — SSE progress stream
  router.get('/research/stream/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    if (!validateSessionId(sessionId)) return res.status(400).json({ error: 'Invalid session ID' });

    const entry = activeTasks[sessionId];
    if (!entry) {
      // Already finished — send final status from disk
      const disk = readResearchJSON(sessionId);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('Connection', 'keep-alive');
      if (disk) {
        res.write(`data: ${JSON.stringify({ status: disk.status || 'done', final: true })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ status: 'not_found' })}\n\n`);
      }
      res.end();
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Connection', 'keep-alive');

    // Send current state immediately
    const current = { ...entry.progress, status: entry.status };
    res.write(`data: ${JSON.stringify(current)}\n\n`);

    const onProgress = (progress) => {
      try {
        const payload = { ...progress, status: entry.status };
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
        if (progress.final) {
          setTimeout(() => res.end(), 100);
        }
      } catch {}
    };

    entry._emitter.on('progress', onProgress);

    req.on('close', () => {
      entry._emitter.removeListener('progress', onProgress);
    });
  });

  // GET /research/search/providers — available search providers
  router.get('/research/search/providers', (req, res) => {
    res.json([
      { id: 'duckduckgo', label: 'DuckDuckGo', available: true,                          note: 'Free scrape — no key needed' },
      { id: 'brave',      label: 'Brave Search', available: !!process.env.BRAVE_API_KEY,  note: process.env.BRAVE_API_KEY  ? 'Active' : 'Set BRAVE_API_KEY in .env' },
      { id: 'serper',     label: 'Serper (Google)', available: !!process.env.SERPER_API_KEY, note: process.env.SERPER_API_KEY ? 'Active' : 'Set SERPER_API_KEY in .env' },
      { id: 'tavily',     label: 'Tavily',       available: !!process.env.TAVILY_API_KEY,  note: process.env.TAVILY_API_KEY ? 'Active' : 'Set TAVILY_API_KEY in .env' },
    ]);
  });

  // POST /research/search — standalone web search
  router.post('/research/search', async (req, res) => {
    const { query, q } = req.body;
    const searchQuery = (query || q || '').trim();
    if (!searchQuery) return res.json({ context: '', sources: [], error: 'query is required' });
    try {
      const context = await searchFor(req.body.search_provider)(searchQuery, 'RESEARCH-SEARCH');
      const urls = ((context || '').match(/https?:\/\/[^\s<>"{}|\\^`\[\]]+/g) || []).map(cleanUrl);
      const sources = [...new Set(urls)].slice(0, 10).map(u => ({
        url: u,
        title: u.replace(/^https?:\/\/(www\.)?/, '').split('/')[0],
      }));
      res.json({ context, sources });
    } catch (e) {
      res.json({ context: '', sources: [], error: e.message });
    }
  });

  return router;
};

// ── HTML report generator ────────────────────────────────────────
function buildReportHTML(data) {
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const hiddenSet = new Set(data.hidden_images || []);
  const sources = (data.sources || []).map((s, i) => {
    const safeUrl = esc(s.url || '');
    const safeTitle = esc(s.title || s.url || 'Source');
    // Archived-snapshot link (Wayback Machine, best-effort) rides alongside
    // the live URL — if the live link ever 404s, the citation still resolves.
    const archived = s.archived_url
      ? ` <a class="archived-link" href="${esc(s.archived_url)}" target="_blank" rel="noopener" title="Archived snapshot">🔒 archived</a>`
      : '';
    return `<tr><td class="src-num">${i + 1}</td><td><a href="${safeUrl}" target="_blank" rel="noopener">${safeTitle}</a>${archived}</td><td class="src-url">${safeUrl.replace(/https?:\/\//, '').split('/')[0]}</td></tr>`;
  }).join('\n');

  // Convert markdown-style formatting to HTML
  let resultHTML = esc(data.result || '');
  resultHTML = resultHTML
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 class="section-title">$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Markdown links [text](url) -> real <a> tags. Was missing entirely —
    // the deterministic References section uses standard markdown link
    // syntax, and with no transform for it, citations rendered as literal
    // "[text](url)" text instead of clickable links.
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/^[\-\*] (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`)
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br>');
  resultHTML = `<p>${resultHTML}</p>`;
  // Link [N] citation chips to their matching numbered source
  const srcListForCites = data.sources || [];
  resultHTML = resultHTML.replace(/\[(\d+)\]/g, (m, n) => {
    const s = srcListForCites[parseInt(n, 10) - 1];
    if (!s) return `<span class="cite">${n}</span>`;
    const safeUrl = esc(s.url || '');
    const safeTitle = esc(s.title || s.url || 'Source');
    return `<a class="cite" href="${safeUrl}" target="_blank" rel="noopener" title="${safeTitle}" aria-label="Citation ${n}: ${safeTitle}">${n}</a>`;
  });
  // Swap [CHART:i] placeholders for real inline SVG charts built from extracted data
  const chartList = data.charts || [];
  resultHTML = resultHTML.replace(/\[CHART:(\d+)\]/g, (m, i) => {
    const c = chartList[parseInt(i, 10)];
    return c ? chartToSVG(c, esc) : '';
  });

  const stats = data.stats || {};
  const date = new Date(data.completed_at ? data.completed_at * 1000 : Date.now());
  const dateStr = date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AEON Research: ${esc(data.query || 'Report')}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap');
  :root { --bg: #0a0a0a; --surface: #141414; --surface2: #1a1a1a; --border: #222; --text: #e8e8e8; --accent: #00f2ff; --accent2: #0099aa; --dim: #666; --red: #ff4466; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Inter', -apple-system, sans-serif; background: var(--bg); color: var(--text); line-height: 1.8; }

  /* Header */
  .header { background: linear-gradient(135deg, #0a0a0a 0%, #0d1117 100%); border-bottom: 1px solid var(--border); padding: 40px 0 32px; }
  .header-inner { max-width: 900px; margin: 0 auto; padding: 0 32px; }
  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 24px; }
  .brand-mark { font-size: 11px; font-weight: 800; letter-spacing: 4px; color: var(--accent); text-transform: uppercase; }
  .brand-line { height: 1px; flex: 1; background: linear-gradient(90deg, var(--accent) 0%, transparent 100%); opacity: 0.3; }
  .report-title { font-size: 2em; font-weight: 800; color: #fff; line-height: 1.2; margin-bottom: 8px; }
  .report-query { font-size: 1.05em; color: var(--accent); font-style: italic; margin-bottom: 20px; opacity: 0.9; }
  .meta-bar { display: flex; gap: 20px; flex-wrap: wrap; font-size: 0.8em; color: var(--dim); }
  .meta-item { display: flex; align-items: center; gap: 5px; }
  .meta-dot { width: 4px; height: 4px; border-radius: 50%; background: var(--accent); }

  /* Body */
  .body { max-width: 900px; margin: 0 auto; padding: 40px 32px; }
  .report-content { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 40px; margin-bottom: 32px; }
  .report-content h1.section-title { font-size: 1.4em; color: #fff; margin: 32px 0 12px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
  .report-content h1.section-title:first-child { margin-top: 0; }
  .report-content h2 { font-size: 1.2em; color: var(--accent); margin: 24px 0 8px; }
  .report-content h3 { font-size: 1.05em; color: #ccc; margin: 20px 0 8px; }
  .report-content p { margin-bottom: 12px; }
  .report-content ul { margin: 8px 0 16px 20px; }
  .report-content li { margin-bottom: 4px; }
  .report-content strong { color: #fff; }
  .cite { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; border-radius: 3px; background: rgba(0,242,255,0.12); color: var(--accent); font-size: 10px; font-weight: 700; text-decoration: none; margin: 0 1px; vertical-align: super; padding: 0 3px; }
  .cite:hover { background: var(--accent); color: #000; }
  .chart-block { background: var(--surface2); border: 1px solid var(--border); border-radius: 10px; padding: 20px; margin: 16px 0; }
  .chart-title { font-size: 0.85em; font-weight: 700; color: #fff; margin-bottom: 12px; }
  .chart-legend { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 8px; }
  .query-note { font-size: 0.78em; color: var(--dim); margin-top: 6px; }
  .query-note strong { color: var(--accent); font-weight: 600; }

  /* Sources */
  .sources { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 32px; margin-bottom: 32px; }
  .sources h2 { font-size: 1.1em; margin-bottom: 16px; color: #fff; display: flex; align-items: center; gap: 8px; }
  .sources h2 .count { font-size: 0.75em; background: var(--accent); color: #000; padding: 2px 8px; border-radius: 10px; font-weight: 700; }
  .src-table { width: 100%; border-collapse: collapse; font-size: 0.85em; }
  .src-table tr { border-bottom: 1px solid var(--border); }
  .src-table tr:last-child { border-bottom: none; }
  .src-table td { padding: 8px 4px; vertical-align: top; }
  .src-num { color: var(--dim); width: 30px; font-weight: 600; }
  .src-url { color: var(--dim); font-size: 0.85em; }
  .src-table a { color: var(--accent); text-decoration: none; }
  .src-table a:hover { text-decoration: underline; }
  .archived-link { font-size: 0.75em; color: var(--dim) !important; margin-left: 6px; white-space: nowrap; }
  .archived-link:hover { color: var(--accent) !important; }

  /* Footer */
  .footer { max-width: 900px; margin: 0 auto; padding: 24px 32px; text-align: center; font-size: 0.75em; color: var(--dim); border-top: 1px solid var(--border); }

  @media print {
    body { background: #fff; color: #222; }
    .header { background: #fff; border-bottom: 2px solid #000; }
    .brand-mark { color: #000; }
    .report-title { color: #000; }
    .report-query { color: #333; }
    .report-content, .sources { background: #fff; border: 1px solid #ddd; }
    .report-content h2 { color: #333; }
    .src-table a { color: #0066cc; }
    .archived-link { color: #666 !important; }
    .chart-block { background: #fff; border: 1px solid #ddd; }
  }
</style>
</head>
<body>
<div class="header">
  <div class="header-inner">
    <div class="brand">
      <span class="brand-mark">AEON Intelligence</span>
      <span class="brand-line"></span>
    </div>
    <div class="report-title">Research Report</div>
    <div class="report-query">${esc(data.query || '')}</div>
    ${data.query_corrected && data.original_query ? `<div class="query-note">Interpreted from your input: <strong>&ldquo;${esc(data.original_query)}&rdquo;</strong></div>` : ''}
    <div class="meta-bar">
      <span class="meta-item"><span class="meta-dot"></span> ${dateStr}</span>
      ${stats.Duration ? `<span class="meta-item"><span class="meta-dot"></span> ${esc(stats.Duration)}</span>` : ''}
      ${stats.Rounds ? `<span class="meta-item"><span class="meta-dot"></span> ${esc(stats.Rounds)} rounds</span>` : ''}
      <span class="meta-item"><span class="meta-dot"></span> ${(data.sources || []).length} sources</span>
      <span class="meta-item"><span class="meta-dot"></span> Prepared by AEON Command Center</span>
    </div>
  </div>
</div>
<div class="body">
  <div class="report-content">${resultHTML}</div>
  ${sources ? `<div class="sources"><h2 id="src-heading">Source References <span class="count">${(data.sources || []).length}</span></h2><table class="src-table" aria-labelledby="src-heading"><thead><tr><th scope="col" class="src-num">#</th><th scope="col">Source</th><th scope="col" class="src-url">Domain</th></tr></thead><tbody>${sources}</tbody></table></div>` : ''}
</div>
<div class="footer">
  AEON Intelligence &middot; Broken Gear Industries &middot; Generated ${dateStr} &middot; Confidential
</div>
</body>
</html>`;
}

// ── Dependency-free chart renderer ──────────────────────────────────
// Renders a bar or line chart to an inline SVG string from real,
// LLM-extracted data points (see the data-extraction phase in
// runResearchLoop). Never invents values — this only draws whatever
// numbers were actually pulled from the findings.
function chartToSVG(c, esc) {
  const W = 640, H = 260, PAD_L = 44, PAD_R = 16, PAD_T = 16, PAD_B = 34;
  const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
  const colors = ['#00f2ff', '#7c3aed', '#ff9f40', '#22c55e', '#ff4466'];
  const labels = c.labels || [];
  const series = c.series || [];
  const n = labels.length || 1;
  const allVals = series.flatMap(s => s.data || []);
  const max = Math.max(...allVals, 0);
  const min = Math.min(...allVals, 0);
  const range = (max - min) || 1;

  let marks = '';
  if (c.type === 'line') {
    series.forEach((s, si) => {
      const color = colors[si % colors.length];
      const pts = (s.data || []).map((v, i) => {
        const x = PAD_L + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
        const y = PAD_T + plotH - ((v - min) / range) * plotH;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      });
      marks += `<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="2"/>`;
      pts.forEach(p => { const [x, y] = p.split(','); marks += `<circle cx="${x}" cy="${y}" r="3" fill="${color}"/>`; });
    });
  } else {
    const groupW = plotW / n;
    const barW = groupW / (series.length + 1);
    labels.forEach((lab, i) => {
      series.forEach((s, si) => {
        const v = (s.data || [])[i] || 0;
        const bh = ((v - Math.min(0, min)) / range) * plotH;
        const x = PAD_L + i * groupW + si * barW + barW * 0.4;
        const y = PAD_T + plotH - bh;
        marks += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(barW * 0.8).toFixed(1)}" height="${Math.max(bh, 0).toFixed(1)}" fill="${colors[si % colors.length]}" rx="2"/>`;
      });
    });
  }

  const labelSVG = labels.map((lab, i) => {
    const x = PAD_L + (n === 1 ? plotW / 2 : (i + 0.5) * (plotW / n));
    return `<text x="${x.toFixed(1)}" y="${H - 10}" font-size="10" fill="#5a6a80" text-anchor="middle">${esc(String(lab).slice(0, 14))}</text>`;
  }).join('');

  const legend = series.length > 1
    ? `<div class="chart-legend">${series.map((s, si) => `<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:#9fb0c3"><span style="width:8px;height:8px;border-radius:2px;background:${colors[si % colors.length]};display:inline-block"></span>${esc(s.name || '')}</span>`).join('')}</div>`
    : '';

  return `<div class="chart-block"><div class="chart-title">${esc(c.title || '')}</div><svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px;height:auto;display:block"><line x1="${PAD_L}" y1="${PAD_T + plotH}" x2="${W - PAD_R}" y2="${PAD_T + plotH}" stroke="#1b2233"/>${marks}${labelSVG}</svg>${legend}</div>`;
}
