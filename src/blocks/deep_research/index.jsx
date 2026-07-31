import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Search, Play, X, Copy, Check, Trash2, ExternalLink, RefreshCw, ChevronDown, ChevronUp, MessageSquare, Archive, Settings } from 'lucide-react';

const CATEGORIES = [
  { value: '', label: 'Auto' },
  { value: 'product', label: 'Product' },
  { value: 'comparison', label: 'Compare' },
  { value: 'howto', label: 'How-to' },
  { value: 'factcheck', label: 'Fact-check' },
];

const HINTS = [
  'e.g. Compare Rust and Go for building a high-throughput web API',
  'e.g. Fact-check whether honey actually never spoils',
  'e.g. Best M.2 NVMe SSDs under $200 for a home AI workstation',
  'e.g. How does end-to-end encryption work in Signal, step by step',
  'e.g. Side effects and benefits of long-term creatine supplementation',
  'e.g. The history of the printing press in East Asia, 700 CE to 1600 CE',
];

const PHASE_LABELS = {
  cleaning_query: 'Reading your query...',
  planning: 'Planning research strategy...',
  searching: 'Searching',
  reading: 'Reading sources',
  analyzing: 'Analyzing findings',
  extracting_data: 'Extracting chartable data...',
  writing: 'Writing report',
  citing: 'Verifying reference links...',
  error: 'Error',
  done: 'Complete',
};

// Dependency-free inline SVG chart string, mirrored from the server-side
// renderer in api/index.cjs so client-rendered and server-rendered reports
// look identical. Only ever draws numbers the backend actually extracted
// from search findings — never invents data client-side either.
function chartToSvgStr(c) {
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

function formatElapsed(ms) {
  if (!ms) return '0:00';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function formatPhase(progress, maxRounds) {
  if (!progress || !progress.phase) return 'Starting...';
  const rn = progress.round
    ? (maxRounds ? `Round ${progress.round}/${maxRounds}: ` : `Round ${progress.round}: `)
    : '';
  const base = PHASE_LABELS[progress.phase] || progress.phase;
  if (progress.phase === 'searching') return `${rn}Searching (${progress.queries || 0} queries)`;
  if (progress.phase === 'reading') return `${rn}Reading ${progress.total_sources || 0} sources`;
  if (progress.phase === 'analyzing') return `${rn}Analyzing ${progress.total_findings || 0} findings`;
  if (progress.phase === 'writing') return `Writing report — ${progress.total_sources || 0} sources`;
  return `${rn}${base}`;
}

export default function DeepResearch() {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [maxRounds, setMaxRounds] = useState(0);
  const [jobs, setJobs] = useState([]);
  const [library, setLibrary] = useState([]);
  const [librarySort, setLibrarySort] = useState('recent');
  const [librarySearch, setLibrarySearch] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const [searchProvider, setSearchProvider] = useState('auto');
  const [availableProviders, setAvailableProviders] = useState([
    { id: 'auto', label: 'Auto', available: true, note: '' },
    { id: 'duckduckgo', label: 'DuckDuckGo', available: true, note: 'Free scrape' },
    { id: 'brave', label: 'Brave Search', available: false, note: 'Set BRAVE_API_KEY' },
  ]);
  const [copied, setCopied] = useState(null);
  const [hint] = useState(() => HINTS[Math.floor(Math.random() * HINTS.length)]);
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;

  // ── Load active tasks + recent library on mount ──
  const loadActive = useCallback(async () => {
    try {
      const res = await fetch('/api/research/active');
      if (!res.ok) return;
      const data = await res.json();
      setJobs(prev => {
        const existing = new Set(prev.map(j => j.id));
        const newJobs = (data.active || [])
          .filter(t => !existing.has(t.session_id))
          .map(t => ({
            id: t.session_id,
            query: t.query,
            status: 'running',
            progress: t.progress || {},
            startedAt: t.started_at ? t.started_at * 1000 : Date.now(),
            elapsed: 0,
            result: null,
            sources: null,
          }));
        return [...prev, ...newJobs];
      });
    } catch {}
  }, []);

  const loadLibrary = useCallback(async () => {
    // Try local API first
    try {
      const params = new URLSearchParams({ sort: librarySort, limit: '50' });
      if (librarySearch) params.set('search', librarySearch);
      const res = await fetch(`/api/research/library?${params}`);
      if (res.ok) { const data = await res.json(); setLibrary(data.research || []); return; }
    } catch {}
    // Supabase fallback — read research_library from aeon_blocks
    try {
      const sbUrl = import.meta.env.VITE_SUPABASE_URL;
      const sbKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
      const sbRes = await fetch(`${sbUrl}/rest/v1/aeon_blocks?block_tag=eq.research_library&select=payload`, { headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` } });
      const rows = await sbRes.json();
      let items = rows?.[0]?.payload || [];
      if (librarySearch) items = items.filter(i => (i.query||'').toLowerCase().includes(librarySearch.toLowerCase()));
      if (librarySort === 'recent') items.sort((a,b) => (b.completed_at||0) - (a.completed_at||0));
      else if (librarySort === 'oldest') items.sort((a,b) => (a.completed_at||0) - (b.completed_at||0));
      setLibrary(items.slice(0, 50));
    } catch {}
  }, [librarySort, librarySearch]);

  useEffect(() => {
    loadActive();
    loadLibrary();
    fetch('/api/research/search/providers').then(r => r.json()).then(list => {
      if (Array.isArray(list)) {
        setAvailableProviders([
          { id: 'auto', label: 'Auto', available: true, note: 'Best available' },
          ...list,
        ]);
      }
    }).catch(() => {});
  }, []);
  useEffect(() => { if (showLibrary) loadLibrary(); }, [showLibrary, loadLibrary]);

  // Restore completed jobs from Supabase on mount (so they survive refresh)
  useEffect(() => {
    (async () => {
      try {
        const sbUrl = import.meta.env.VITE_SUPABASE_URL;
        const sbKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
        const r = await fetch(`${sbUrl}/rest/v1/aeon_blocks?block_tag=eq.research_library&select=payload`, { headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` } });
        const rows = await r.json();
        const saved = rows?.[0]?.payload || [];
        if (saved.length > 0) {
          setJobs(prev => {
            const existingIds = new Set(prev.map(j => j.id));
            const restored = saved.filter(s => !existingIds.has(s.id) && s.result).map(s => ({
              id: s.id, query: s.query, status: 'done', result: s.result, sources: s.sources || [],
              progress: { phase: 'done' }, startedAt: (s.completed_at || 0) * 1000, elapsed: 0,
              category: s.category || '', settings: {},
            }));
            return [...prev, ...restored];
          });
        }
      } catch {}
    })();
  }, []);

  // Poll active tasks
  useEffect(() => {
    const interval = setInterval(loadActive, 12000);
    return () => clearInterval(interval);
  }, [loadActive]);

  // SSE connection for running jobs
  useEffect(() => {
    const sources = {};
    const timers = {};

    for (const job of jobs) {
      if (job.status !== 'running' || sources[job.id]) continue;

      timers[job.id] = setInterval(() => {
        setJobs(prev => prev.map(j =>
          j.id === job.id ? { ...j, elapsed: Date.now() - j.startedAt } : j
        ));
      }, 1000);

      const es = new EventSource(`/api/research/stream/${job.id}`);
      sources[job.id] = es;

      es.onmessage = (evt) => {
        try {
          const d = JSON.parse(evt.data);
          if (d.status === 'not_found') {
            setJobs(prev => prev.map(j =>
              j.id === job.id ? { ...j, status: 'error', errorMsg: 'Not found' } : j
            ));
            es.close();
            return;
          }

          setJobs(prev => prev.map(j => {
            if (j.id !== job.id) return j;
            const updated = { ...j, progress: d };
            if (d.model && !j.modelName) updated.modelName = d.model;
            if (d.final) {
              updated.status = d.status === 'done' ? 'done' : d.error ? 'error' : 'cancelled';
              updated.elapsed = Date.now() - j.startedAt;
              if (d.error) updated.errorMsg = d.error;
              if (d.status === 'done') fetchResult(job.id);
            }
            return updated;
          }));

          if (d.final) {
            es.close();
            clearInterval(timers[job.id]);
            delete sources[job.id];
            delete timers[job.id];
          }
        } catch {}
      };

      es.onerror = () => {
        es.close();
        delete sources[job.id];
      };
    }

    return () => {
      Object.values(sources).forEach(es => es.close());
      Object.values(timers).forEach(t => clearInterval(t));
    };
  }, [jobs.map(j => j.id + j.status).join(',')]);

  // ── Actions ──

  async function fetchResult(jobId) {
    try {
      const res = await fetch(`/api/research/result-peek/${jobId}`, {
        method: 'POST',
      });
      if (!res.ok) return;
      const d = await res.json();
      setJobs(prev => prev.map(j =>
        j.id === jobId ? {
          ...j, result: d.result, sources: d.sources, rawFindings: d.raw_findings,
          charts: d.charts || [], category: d.category || j.category,
          query: d.query || j.query, originalQuery: d.original_query, queryCorrected: !!d.query_corrected,
        } : j
      ));
    } catch {}
  }

  async function startResearch() {
    if (!query.trim()) return;
    const body = {
      query: query.trim(),
      max_rounds: maxRounds,
      category: category || undefined,
      search_provider: searchProvider !== 'auto' ? searchProvider : undefined,
    };

    const jobId = `rp-${Date.now().toString(36)}`;

    // Try local API first
    try {
      const res = await fetch('/api/research/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json();
        setJobs(prev => [...prev, {
          id: data.session_id,
          query: data.query,
          status: 'running',
          progress: { phase: 'planning' },
          startedAt: Date.now(),
          elapsed: 0,
          result: null,
          sources: null,
          category: category || '',
          settings: { max_rounds: maxRounds },
        }]);
        setQuery('');
        return;
      }
    } catch {}

    // Fallback: multi-LLM browser-direct research (Groq + Gemini + DDG proxy)
    setJobs(prev => [...prev, {
      id: jobId,
      query: query.trim(),
      status: 'running',
      progress: { phase: 'searching' },
      startedAt: Date.now(),
      elapsed: 0,
      result: null,
      sources: null,
      category: category || '',
      settings: { max_rounds: 3 },
    }]);
    setQuery('');

    try {
      const catHint = category ? ` Format as a "${category}" style document.` : '';
      const q = query.trim();
      const allSources = [];
      let webContext = '';

      // Phase 1: DDG web search — Edge Function first, CORS proxies fallback
      const updateJob = (phase, extra) => setJobs(prev => prev.map(j => j.id === jobId ? { ...j, progress: { phase, ...extra } } : j));
      updateJob('searching', { round: 1, queries: 1 });
      try {
        let links = [], snips = [];

        // Try 1: Our own Vercel Edge Function (no CORS issues, no cold-start)
        try {
          const edgeRes = await fetch(`/api/search-web?q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(8000) });
          if (edgeRes.ok) {
            const edgeData = await edgeRes.json();
            if (edgeData.results?.length > 0) {
              links = edgeData.results.map(r => ({ url: r.url, title: r.title }));
              snips = edgeData.results.map(r => r.snippet || '');
            }
          }
        } catch {}

        // Try 2: Local API (works on localhost)
        if (links.length === 0) {
          try {
            // /api/orion-scrape never existed — this fallback silently 404'd
            // for its whole life. The orion_search block owns this surface and
            // already serves it as /api/orion/search, which returns the same
            // information under different field names.
            const localRes = await fetch('/api/orion/search', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ query: q, k: 8 }),
              signal: AbortSignal.timeout(8000),
            });
            if (localRes.ok) {
              const localData = await localRes.json();
              const results = localData.results || [];
              if (results.length > 0) {
                links = results.map(r => ({ url: r.url || '', title: r.title || '' }));
                snips = results.map(r => r.excerpt || '');
              }
            }
          } catch {}
        }

        if (links.length === 0) throw new Error('No search results');
        for (let i = 0; i < Math.min(6, links.length); i++) {
          let url = links[i].url;
          if (url.includes('uddg=')) { try { url = decodeURIComponent(new URLSearchParams(url.split('?')[1]).get('uddg')); } catch {} }
          allSources.push({ url, title: links[i].title });
          webContext += `[${links[i].title}]: ${snips[i] || ''}\n\n`;
        }
      } catch {}

      // Phase 2: Groq research with source extraction
      updateJob('analyzing', { round: 2, total_sources: allSources.length });
      let groqAnalysis = '';
      try {
        const hasWeb = webContext.length > 100;
        const groqPrompt = hasWeb
          ? `You are a research analyst. Analyze ONLY these search results about "${q}". Do NOT invent information beyond what these sources state.\n\n${webContext.slice(0, 4000)}\n\nProvide:\n1. Factual analysis based strictly on the search results above\n2. At the END, list ONLY the sources provided above in this format:\n[SOURCES]\n- Title | URL\n\nDo NOT fabricate or guess any URLs.`
          : `You are a research analyst. The user asked about "${q}" but no live web search results were available. Provide a general overview based on widely known facts. Be conservative — clearly state when you are uncertain. Do NOT fabricate specific statistics, quotes, or URLs. Do NOT include a [SOURCES] section since no live sources were retrieved.`;
        const groqRes = await fetch('/api/ai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: groqPrompt, role: 'chat', provider: 'groq' }),
        });
        const gd = await groqRes.json();
        groqAnalysis = gd.text || '';
        // Extract sources from Groq output
        const srcMatch = groqAnalysis.match(/\[SOURCES\]([\s\S]*?)$/);
        if (srcMatch) {
          const srcLines = srcMatch[1].split('\n').filter(l => l.includes('|') || l.includes('http'));
          for (const line of srcLines) {
            const urlMatch = line.match(/(https?:\/\/[^\s]+)/);
            const titleMatch = line.match(/^[\-\*]?\s*(.+?)\s*\|/);
            if (urlMatch) {
              allSources.push({ url: urlMatch[1], title: (titleMatch?.[1] || urlMatch[1].split('/')[2]).trim() });
            }
          }
          groqAnalysis = groqAnalysis.replace(/\[SOURCES\][\s\S]*$/, '').trim();
        }
      } catch {}

      // Phase 3: Gemini writes the final executive report
      updateJob('writing', { round: 3, total_sources: allSources.length });
      let finalReport = '';
      try {
        const geminiPrompt = `You are a senior research analyst at AEON Intelligence, a professional consultancy. Write a comprehensive executive research report.${catHint}

RESEARCH QUERY: ${q}

WEB INTELLIGENCE (from live search):
${webContext.length > 100 ? webContext.slice(0, 3000) : 'No live web data was retrieved. Base your report only on the analyst findings below and general knowledge. Clearly mark any claims that are not sourced.'}

ANALYST FINDINGS:
${groqAnalysis.slice(0, 3000) || 'No preliminary analysis available.'}

NUMBERED SOURCES (cite these inline):
${allSources.slice(0, 20).map((s, i) => `[${i + 1}] ${s.title || s.url} — ${s.url}`).join('\n') || '(none — do not use inline citations)'}

Write a polished, professional report in Markdown with:
# Executive Summary
## Detailed Findings (### themed subsections)
## Key Takeaways (bullet points)
## Recommendations

CITATIONS: when a claim comes from one of the numbered sources above, cite it inline as [N] (e.g. "revenue grew 40% [2]"). Use ONLY the numbers listed — never invent citation numbers.
IMPORTANT: Do NOT fabricate URLs, citations, or specific statistics that were not in the web intelligence above. If no live sources were found, say so explicitly. Write as if the CEO is reading this.`;
        const geminiRes = await fetch('/api/ai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: geminiPrompt, role: 'chat', provider: 'gemini' }),
        });
        const gRes = await geminiRes.json();
        finalReport = gRes?.text || '';
      } catch {}

      // Fallback chain: Gemini report → Groq analysis → Groq standalone report
      if (!finalReport && groqAnalysis) {
        finalReport = `# Research Report: ${q}\n\n${groqAnalysis}`;
      }
      if (!finalReport) {
        // Last resort: Groq standalone full report (no web data, pure knowledge)
        try {
          const standalonePrompt = `Write a research report on: ${q}\n\nStructure with: # Executive Summary, ## Detailed Findings (### subsections), ## Key Takeaways, ## Recommendations.\n\nIMPORTANT: No live web sources were available for this query. Base your report on widely known facts only. Do NOT fabricate specific statistics, quotes, or URLs. Do NOT include a [SOURCES] section. Clearly state when information may need verification. Be honest about the limitations of this report.`;
          const standaloneRes = await fetch('/api/ai', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: standalonePrompt, role: 'chat', provider: 'groq' }),
          });
          const sd = await standaloneRes.json();
          let standaloneText = sd.text || '';
          const srcM = standaloneText.match(/\[SOURCES\]([\s\S]*?)$/);
          if (srcM) {
            srcM[1].split('\n').filter(l=>l.includes('http')).forEach(line => {
              const u = line.match(/(https?:\/\/[^\s]+)/);
              const t = line.match(/^[\-\*]?\s*(.+?)\s*\|/);
              if (u) allSources.push({ url: u[1], title: (t?.[1] || u[1].split('/')[2]).trim() });
            });
            standaloneText = standaloneText.replace(/\[SOURCES\][\s\S]*$/, '').trim();
          }
          finalReport = standaloneText;
        } catch {}
      }
      if (!finalReport) {
        finalReport = 'Research generation failed — all LLM providers unreachable.';
      }

      const elapsed = Date.now() - (jobs.find(j => j.id === jobId)?.startedAt || Date.now());
      setJobs(prev => prev.map(j => j.id === jobId ? {
        ...j,
        status: 'done',
        result: finalReport,
        elapsed,
        progress: { phase: 'done', total_sources: allSources.length },
        sources: allSources,
      } : j));

      // Save to Supabase so it appears in library on all devices
      try {
        const sbUrl = import.meta.env.VITE_SUPABASE_URL;
        const sbKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
        const sbRes = await fetch(`${sbUrl}/rest/v1/aeon_blocks?block_tag=eq.research_library&select=payload`, { headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` } });
        const rows = await sbRes.json();
        const existing = rows?.[0]?.payload || [];
        existing.unshift({ id: jobId, query: q, result: finalReport, sources: allSources, status: 'done', completed_at: Math.floor(Date.now()/1000), stats: { Duration: `${Math.round(elapsed/1000)}s`, Sources: allSources.length } });
        await fetch(`${sbUrl}/rest/v1/aeon_blocks`, { method: 'POST', headers: { ...{ apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' }, Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ block_tag: 'research_library', payload: existing.slice(0, 50), updated_at: new Date().toISOString() }) });
      } catch {}
    } catch (e) {
      setJobs(prev => prev.map(j => j.id === jobId ? {
        ...j,
        status: 'error',
        result: `Research failed: ${e.message}`,
        progress: { phase: 'error' },
      } : j));
    }
  }

  async function cancelJob(jobId) {
    try { await fetch(`/api/research/cancel/${jobId}`, { method: 'POST' }); } catch {}
    setJobs(prev => prev.map(j =>
      j.id === jobId ? { ...j, status: 'cancelled' } : j
    ));
  }

  async function deleteJob(jobId) {
    if (!window.confirm('Delete this research permanently?')) return;
    try { await fetch(`/api/research/${jobId}`, { method: 'DELETE' }); } catch {}
    setJobs(prev => prev.filter(j => j.id !== jobId));
    setLibrary(prev => prev.filter(l => l.id !== jobId));
  }

  function dismissJob(jobId) {
    setJobs(prev => prev.filter(j => j.id !== jobId));
  }

  async function retryJob(job) {
    setJobs(prev => prev.filter(j => j.id !== job.id));
    setQuery(job.query);
    setCategory(job.category || '');
  }

  async function copyResult(job) {
    if (!job.result) {
      await fetchResult(job.id);
      const updated = jobsRef.current.find(j => j.id === job.id);
      if (!updated?.result) return;
      job = updated;
    }
    let text = `# ${job.query}\n\n${job.result}`;
    if (job.sources?.length) {
      text += `\n\n---\n## Sources\n${job.sources.map(s => `- [${s.title || s.url}](${s.url})`).join('\n')}`;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopied(job.id);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      setCopied(job.id);
      setTimeout(() => setCopied(null), 2000);
    }
  }

  function openReport(jobId) {
    // Try local API first
    const job = jobs.find(j => j.id === jobId);
    const libItem = library.find(l => l.id === jobId);
    const result = job?.result || libItem?.result;

    if (result) {
      // Render client-side report — aeon-213 formula: inline [N] citation
      // chips linked to a numbered source list with domains.
      const srcList = job?.sources || libItem?.sources || [];
      const chartList = job?.charts || libItem?.charts || [];
      const linkCites = (html) => html.replace(/\[(\d+)\]/g, (_, n) => {
        const s = srcList[parseInt(n, 10) - 1];
        if (!s) return `<span class="cite">${n}</span>`;
        const safeTitle = (s.title || s.url).replace(/"/g, '&quot;');
        return `<a class="cite" href="${s.url}" target="_blank" rel="noopener" title="${safeTitle}" aria-label="Citation ${n}: ${safeTitle}">${n}</a>`;
      });
      const insertCharts = (html) => html.replace(/\[CHART:(\d+)\]/g, (_, i) => {
        const c = chartList[parseInt(i, 10)];
        return c ? chartToSvgStr(c) : '';
      });
      const md = insertCharts(linkCites(result
        .replace(/^### (.+)$/gm, '<h3>$1</h3>')
        .replace(/^## (.+)$/gm, '<h2>$1</h2>')
        .replace(/^# (.+)$/gm, '<h1>$1</h1>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/^[\-\*] (.+)$/gm, '<li>$1</li>')
        .replace(/\n{2,}/g, '</p><p>')
        .replace(/\n/g, '<br>')));
      const domainOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
      const sources = srcList
        .map((s, i) => `<li class="src"><div class="src-num" aria-hidden="true">${i + 1}</div><div class="src-body">
          <div class="src-title">${s.title || 'Untitled'}</div>
          <a class="src-url" href="${s.url}" target="_blank" rel="noopener">${s.url}</a>
          <div class="src-domain">${domainOf(s.url)}</div></div></li>`)
        .join('');
      const query = job?.query || libItem?.query || '';
      const origQuery = job?.originalQuery || libItem?.original_query || '';
      const queryCorrected = !!(job?.queryCorrected || libItem?.query_corrected);
      const queryNote = queryCorrected && origQuery
        ? `<div class="query-note">Interpreted from your input: <strong>&ldquo;${origQuery.replace(/"/g, '&quot;')}&rdquo;</strong></div>` : '';
      const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AEON Research: ${query}</title>
        <style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Space Grotesk',Inter,-apple-system,sans-serif;background:#07080d;color:#dce8f5;line-height:1.8;padding:0}
        .header{background:radial-gradient(700px 300px at 15% 0%,rgba(0,242,255,.10),transparent 60%),radial-gradient(600px 300px at 85% 20%,rgba(124,58,237,.12),transparent 60%),#07080d;border-bottom:1px solid #1b2233;padding:40px 32px 32px}
        .brand{font-size:11px;font-weight:800;letter-spacing:4px;color:#00f2ff;text-transform:uppercase;margin-bottom:24px}
        .title{font-size:2em;font-weight:800;color:#fff;margin-bottom:8px}.query{color:#00f2ff;font-style:italic;margin-bottom:16px}.meta{font-size:0.8em;color:#5a6a80}
        .body{max-width:900px;margin:0 auto;padding:40px 32px}.content{background:rgba(16,20,32,.6);border:1px solid #1b2233;border-radius:12px;padding:40px;margin-bottom:32px}
        .content h1{font-size:1.4em;color:#fff;margin:32px 0 12px;padding-bottom:8px;border-bottom:1px solid #1b2233}.content h1:first-child{margin-top:0}
        .content h2{font-size:1.2em;color:#00f2ff;margin:24px 0 8px;padding-bottom:6px;border-bottom:1px solid #141b2b}.content h3{font-size:1.05em;color:#ccc;margin:20px 0 8px}
        .content p{margin-bottom:12px}.content ul{margin:8px 0 16px 20px}.content li{margin-bottom:4px}.content strong{color:#fff}
        .cite{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;border-radius:3px;background:rgba(0,242,255,.12);color:#00f2ff;font-size:10px;font-weight:700;cursor:pointer;text-decoration:none;margin:0 1px;vertical-align:super;padding:0 3px}
        .cite:hover{background:#00f2ff;color:#07080d}
        .chart-block{background:rgba(16,20,32,.6);border:1px solid #1b2233;border-radius:10px;padding:20px;margin:16px 0}
        .chart-title{font-size:0.85em;font-weight:700;color:#fff;margin-bottom:12px}
        .chart-legend{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:8px}
        .query-note{font-size:0.78em;color:#5a6a80;margin-top:6px}
        .query-note strong{color:#00f2ff;font-weight:600}
        .sources{background:rgba(16,20,32,.6);border:1px solid #1b2233;border-radius:12px;padding:32px}.sources h2{font-size:12px;letter-spacing:2px;color:#5a6a80;text-transform:uppercase;margin-bottom:14px}
        .src-list{list-style:none;margin:0;padding:0}
        .src{display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-bottom:1px solid #141b2b}.src:last-child{border-bottom:none}
        .src-num{width:22px;height:22px;border-radius:3px;background:rgba(0,242,255,.12);color:#00f2ff;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px}
        .src-body{flex:1;min-width:0}.src-title{font-size:13px;color:#dce8f5;margin-bottom:2px}
        .src-url{font-size:11px;color:#00f2ff;text-decoration:none;font-family:'JetBrains Mono',monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}.src-url:hover{text-decoration:underline}
        .src-domain{font-size:11px;color:#5a6a80;margin-top:2px}
        .footer{max-width:900px;margin:0 auto;padding:24px 32px;text-align:center;font-size:0.75em;color:#5a6a80;border-top:1px solid #1b2233}
        @media print{body{background:#fff;color:#222}.header{background:#fff;border-bottom:2px solid #000}.brand{color:#000}.title{color:#000}.content,.sources{background:#fff;border:1px solid #ddd}.cite{background:#eee;color:#000}}</style></head>
        <body><div class="header"><div class="brand">AEON Intelligence</div><div class="title">Research Report</div><div class="query">${query}</div>${queryNote}<div class="meta">${date}${srcList.length ? ` · ${srcList.length} sources` : ' · no live sources'}</div></div>
        <div class="body"><div class="content"><p>${md}</p></div>
        ${sources ? `<div class="sources"><h2 id="src-heading">Sources (${srcList.length})</h2><ol class="src-list" aria-labelledby="src-heading">${sources}</ol></div>` : ''}
        </div><div class="footer">AEON Intelligence · Broken Gear Industries · ${date} · Confidential</div></body></html>`;
      const win = window.open('', '_blank');
      if (win) { win.document.write(html); win.document.close(); }
      return;
    }

    // Fallback: try server API (works on localhost)
    window.open(`/api/research/report/${jobId}`, '_blank');
  }

  async function archiveItem(id) {
    try { await fetch(`/api/research/${id}/archive?archived=true`, { method: 'POST' }); } catch {}
    setLibrary(prev => prev.filter(l => l.id !== id));
  }

  // ── Render ──

  const activeJobs = jobs.filter(j => j.status === 'running' || j.status === 'error' || j.status === 'cancelled');
  const doneJobs = jobs.filter(j => j.status === 'done');

  return (
    <div style={{ padding: '24px', maxWidth: '900px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '6px' }}>
        <Search size={20} style={{ color: 'var(--color-primary, #00f2ff)' }} />
        <h2 style={{ margin: 0, fontSize: '1.3em', fontFamily: 'var(--font-headline, inherit)' }}>Deep Research</h2>
        {(library.length > 0 || doneJobs.length > 0) && (
          <span style={{
            fontSize: '10px', opacity: 0.5, fontFamily: 'var(--font-mono, monospace)',
            border: '1px solid rgba(255,255,255,0.1)', padding: '2px 8px', borderRadius: '4px',
          }}>
            {library.length + doneJobs.length} saved
          </span>
        )}
      </div>
      <p style={{ fontSize: '12px', color: 'var(--text-dim, #888)', margin: '0 0 20px 0' }}>
        Multi-step web research with an LLM-in-the-loop agent
      </p>

      {/* Query Input */}
      <div style={{
        background: 'var(--color-surface, #1a1a1a)',
        border: '1px solid var(--border, #2a2a2a)',
        borderRadius: 'var(--radius-lg, 12px)',
        padding: '20px',
        marginBottom: '16px',
      }}>
        <textarea
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={hint}
          aria-label="Research query"
          rows={3}
          onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); startResearch(); } }}
          onFocus={e => { e.currentTarget.style.borderColor = 'var(--color-primary, #00f2ff)'; e.currentTarget.style.boxShadow = '0 0 0 2px rgba(0,242,255,0.15)'; }}
          onBlur={e => { e.currentTarget.style.borderColor = 'var(--border, #2a2a2a)'; e.currentTarget.style.boxShadow = 'none'; }}
          style={{
            width: '100%',
            background: 'rgba(0,0,0,0.3)',
            border: '1px solid var(--border, #2a2a2a)',
            borderRadius: '8px',
            padding: '12px',
            color: 'var(--text, #e0e0e0)',
            fontSize: '13px',
            fontFamily: 'inherit',
            resize: 'vertical',
            outline: 'none',
            boxShadow: 'none',
          }}
        />

        {/* Category chips */}
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', margin: '12px 0' }}>
          {CATEGORIES.map(c => (
            <button
              key={c.value}
              onClick={() => setCategory(c.value)}
              aria-pressed={category === c.value}
              style={{
                padding: '4px 12px',
                borderRadius: '16px',
                fontSize: '11px',
                fontWeight: 600,
                cursor: 'pointer',
                border: category === c.value ? '1px solid var(--color-primary, #00f2ff)' : '1px solid var(--border, #2a2a2a)',
                background: category === c.value ? 'rgba(0,242,255,0.1)' : 'transparent',
                color: category === c.value ? 'var(--color-primary, #00f2ff)' : 'var(--text-dim, #888)',
                transition: 'all 0.15s ease',
              }}
            >
              {c.label}
            </button>
          ))}
        </div>

        {/* Settings toggle */}
        <button
          onClick={() => setShowSettings(!showSettings)}
          aria-expanded={showSettings}
          aria-controls="dr-settings-panel"
          style={{
            background: 'none', border: 'none', color: 'var(--text-dim, #888)',
            fontSize: '11px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px',
            padding: '4px 0', marginBottom: showSettings ? '8px' : '0',
          }}
        >
          <Settings size={12} aria-hidden="true" />
          Settings
          {showSettings ? <ChevronUp size={10} aria-hidden="true" /> : <ChevronDown size={10} aria-hidden="true" />}
        </button>

        {showSettings && (
          <div id="dr-settings-panel" style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px',
            padding: '12px', background: 'rgba(0,0,0,0.2)', borderRadius: '8px', marginBottom: '12px',
          }}>
            <label style={{ fontSize: '11px', color: 'var(--text-dim, #888)' }}>
              Rounds
              <select
                value={maxRounds}
                onChange={e => setMaxRounds(parseInt(e.target.value))}
                style={{
                  display: 'block', width: '100%', marginTop: '4px', padding: '6px 8px',
                  background: 'var(--color-surface, #1a1a1a)', border: '1px solid var(--border, #2a2a2a)',
                  borderRadius: '6px', color: 'var(--text, #e0e0e0)', fontSize: '12px',
                }}
              >
                <option value={0}>Auto</option>
                {Array.from({ length: 20 }, (_, i) => (
                  <option key={i + 1} value={i + 1}>{i + 1}</option>
                ))}
              </select>
            </label>
            <label style={{ fontSize: '11px', color: 'var(--text-dim, #888)' }}>
              Search engine
              <select
                value={searchProvider}
                onChange={e => setSearchProvider(e.target.value)}
                style={{
                  display: 'block', width: '100%', marginTop: '4px', padding: '6px 8px',
                  background: 'var(--color-surface, #1a1a1a)', border: '1px solid var(--border, #2a2a2a)',
                  borderRadius: '6px', color: 'var(--text, #e0e0e0)', fontSize: '12px',
                }}
              >
                {availableProviders.map(p => (
                  <option key={p.id} value={p.id} disabled={!p.available}>
                    {p.label}{p.note && p.id !== 'auto' ? ` — ${p.note}` : ''}
                  </option>
                ))}
              </select>
              {searchProvider === 'brave' && !availableProviders.find(p => p.id === 'brave')?.available && (
                <span style={{ fontSize: '10px', color: '#f97316', marginTop: 3, display: 'block' }}>Add BRAVE_API_KEY to .env</span>
              )}
            </label>
          </div>
        )}

        {/* Controls */}
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button
            onClick={startResearch}
            disabled={!query.trim()}
            style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              padding: '8px 20px', borderRadius: '8px', border: 'none',
              background: query.trim() ? 'var(--color-primary, #00f2ff)' : 'rgba(255,255,255,0.1)',
              color: query.trim() ? '#000' : 'var(--text-dim, #888)',
              fontWeight: 700, fontSize: '12px', cursor: query.trim() ? 'pointer' : 'default',
              transition: 'all 0.15s ease',
            }}
          >
            <Play size={14} aria-hidden="true" /> Start Research
          </button>
        </div>
      </div>

      {/* Active Jobs */}
      {activeJobs.map(job => (
        <JobCard key={job.id} job={job} copied={copied}
          onCancel={() => cancelJob(job.id)} onDismiss={() => dismissJob(job.id)}
          onRetry={() => retryJob(job)} onCopy={() => copyResult(job)}
          onReport={() => openReport(job.id)} onDelete={() => deleteJob(job.id)}
        />
      ))}

      {/* Done Jobs (this session) */}
      {doneJobs.length > 0 && (
        <div style={{ marginTop: '24px' }}>
          <h3 style={{ fontSize: '13px', color: 'var(--text-dim, #888)', fontWeight: 700, letterSpacing: '1px', marginBottom: '12px' }}>
            COMPLETED ({doneJobs.length})
          </h3>
          {doneJobs.map(job => (
            <JobCard key={job.id} job={job} copied={copied}
              onCancel={() => {}} onDismiss={() => dismissJob(job.id)}
              onRetry={() => retryJob(job)} onCopy={() => copyResult(job)}
              onReport={() => openReport(job.id)} onDelete={() => deleteJob(job.id)}
            />
          ))}
        </div>
      )}

      {/* Library Toggle */}
      <div style={{ marginTop: '32px' }}>
        <button
          onClick={() => setShowLibrary(!showLibrary)}
          aria-expanded={showLibrary}
          aria-controls="dr-library-panel"
          style={{
            background: 'none', border: '1px solid var(--border, #2a2a2a)',
            color: 'var(--text-dim, #888)', padding: '8px 16px', borderRadius: '8px',
            cursor: 'pointer', fontSize: '12px', fontWeight: 600,
            display: 'flex', alignItems: 'center', gap: '6px', width: '100%',
            justifyContent: 'center', transition: 'all 0.15s ease',
          }}
        >
          <Archive size={14} aria-hidden="true" />
          {showLibrary ? 'Hide Library' : 'Research Library'}
          {showLibrary ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
        </button>

        {showLibrary && (
          <div id="dr-library-panel" style={{ marginTop: '12px' }}>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
              <input
                type="text"
                placeholder="Search..."
                aria-label="Search research library"
                value={librarySearch}
                onChange={e => setLibrarySearch(e.target.value)}
                onFocus={e => { e.currentTarget.style.borderColor = 'var(--color-primary, #00f2ff)'; e.currentTarget.style.boxShadow = '0 0 0 2px rgba(0,242,255,0.15)'; }}
                onBlur={e => { e.currentTarget.style.borderColor = 'var(--border, #2a2a2a)'; e.currentTarget.style.boxShadow = 'none'; }}
                style={{
                  flex: 1, minWidth: '150px', padding: '6px 10px',
                  background: 'var(--color-surface, #1a1a1a)', border: '1px solid var(--border, #2a2a2a)',
                  borderRadius: '6px', color: 'var(--text, #e0e0e0)', fontSize: '12px', outline: 'none',
                  boxShadow: 'none',
                }}
              />
              <select
                value={librarySort}
                onChange={e => setLibrarySort(e.target.value)}
                aria-label="Sort research library"
                style={{
                  padding: '6px 10px',
                  background: 'var(--color-surface, #1a1a1a)', border: '1px solid var(--border, #2a2a2a)',
                  borderRadius: '6px', color: 'var(--text, #e0e0e0)', fontSize: '12px',
                }}
              >
                <option value="recent">Recent</option>
                <option value="oldest">Oldest</option>
                <option value="alpha">A-Z</option>
                <option value="most-messages">Most Sources</option>
              </select>
              <button onClick={loadLibrary} aria-label="Refresh library" title="Refresh library" style={{
                background: 'none', border: '1px solid var(--border, #2a2a2a)',
                borderRadius: '6px', padding: '6px 8px', cursor: 'pointer', color: 'var(--text-dim, #888)',
              }}>
                <RefreshCw size={12} aria-hidden="true" />
              </button>
            </div>

            {library.length === 0 && (
              <p style={{ textAlign: 'center', color: 'var(--text-dim, #888)', fontSize: '12px', padding: '24px 0' }}>
                No saved research yet. Start your first investigation above.
              </p>
            )}

            {library.map(item => (
              <LibraryCard key={item.id} item={item}
                onOpen={() => openReport(item.id)}
                onArchive={() => archiveItem(item.id)}
                onDelete={() => deleteJob(item.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Job Card Component ──

function JobCard({ job, copied, onCancel, onDismiss, onRetry, onCopy, onReport, onDelete }) {
  const isRunning = job.status === 'running';
  const isDone = job.status === 'done';
  const isError = job.status === 'error' || job.status === 'cancelled';
  const elapsed = formatElapsed(job.elapsed || 0);

  const barCap = job.settings?.max_rounds || 8;
  const round = job.progress?.round || 0;
  const pct = Math.min(100, Math.round((round / barCap) * 100));

  return (
    <div style={{
      background: 'var(--color-surface, #1a1a1a)',
      border: `1px solid ${isError ? 'rgba(244,67,54,0.3)' : isDone ? 'rgba(0,242,255,0.15)' : 'var(--border, #2a2a2a)'}`,
      borderRadius: 'var(--radius-lg, 12px)',
      padding: '16px',
      marginBottom: '10px',
      transition: 'all 0.2s ease',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', marginBottom: '8px' }}>
        <span style={{ flex: 1, fontSize: '13px', fontWeight: 600, color: '#fff', lineHeight: 1.4 }}>
          {job.query}
        </span>
        {job.category && (
          <span style={{
            fontSize: '10px', padding: '2px 8px', borderRadius: '10px',
            background: 'rgba(0,242,255,0.1)', color: 'var(--color-primary, #00f2ff)',
            fontWeight: 600, whiteSpace: 'nowrap',
          }}>
            {job.category}
          </span>
        )}
        <span style={{ fontSize: '11px', color: 'var(--text-dim, #888)', fontFamily: 'var(--font-mono, monospace)', whiteSpace: 'nowrap' }}>
          {elapsed}
        </span>
      </div>

      {/* Running state */}
      {isRunning && (
        <>
          <div style={{ fontSize: '11px', color: 'var(--color-primary, #00f2ff)', marginBottom: '8px' }}>
            {formatPhase(job.progress, job.settings?.max_rounds)}
          </div>
          <div
            role="progressbar"
            aria-label="Research progress"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            style={{
            height: '3px', background: 'rgba(255,255,255,0.05)', borderRadius: '2px',
            overflow: 'hidden', marginBottom: '10px',
          }}>
            <div style={{
              height: '100%', width: `${pct}%`,
              background: 'var(--color-primary, #00f2ff)',
              borderRadius: '2px',
              transition: 'width 0.5s ease',
            }} />
          </div>
          <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
            <ActionBtn icon={<X size={12} />} label="Cancel" onClick={onCancel} danger />
          </div>
        </>
      )}

      {/* Done state */}
      {isDone && (
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          <ActionBtn icon={copied === job.id ? <Check size={12} /> : <Copy size={12} />}
            label={copied === job.id ? 'Copied' : 'Copy'} onClick={onCopy}
            highlight={copied === job.id} />
          <ActionBtn icon={<ExternalLink size={12} />} label="Visual Report" onClick={onReport} />
          <ActionBtn icon={<X size={12} />} label="Clear" onClick={onDismiss} dim />
          <ActionBtn icon={<Trash2 size={12} />} label="Delete" onClick={onDelete} dim danger />
        </div>
      )}

      {/* Error state */}
      {isError && (
        <>
          {job.errorMsg && (
            <div style={{
              fontSize: '11px', color: '#f44336', marginBottom: '8px',
              padding: '6px 10px', background: 'rgba(244,67,54,0.08)',
              borderRadius: '6px', fontFamily: 'var(--font-mono, monospace)',
            }}>
              {job.errorMsg.slice(0, 300)}
            </div>
          )}
          <div style={{ display: 'flex', gap: '6px' }}>
            <ActionBtn icon={<RefreshCw size={12} />} label="Retry" onClick={onRetry} />
            <ActionBtn icon={<X size={12} />} label="Dismiss" onClick={onDismiss} dim />
          </div>
        </>
      )}
    </div>
  );
}

// ── Library Card ──

function LibraryCard({ item, onOpen, onArchive, onDelete }) {
  const date = item.completed_at
    ? new Date(item.completed_at * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : '';

  return (
    <div
      onClick={onOpen}
      role="button"
      tabIndex={0}
      aria-label={`Open research report: ${item.query}`}
      onKeyDown={e => {
        if (e.target !== e.currentTarget) return; // don't hijack Enter/Space on the nested Archive/Delete buttons
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); }
      }}
      style={{
        background: 'var(--color-surface, #1a1a1a)',
        border: '1px solid var(--border, #2a2a2a)',
        borderRadius: '10px',
        padding: '12px 16px',
        marginBottom: '8px',
        cursor: 'pointer',
        transition: 'border-color 0.15s ease',
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
      }}
      onMouseEnter={e => e.currentTarget.style.borderColor = 'rgba(0,242,255,0.3)'}
      onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border, #2a2a2a)'}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: '12px', fontWeight: 600, color: '#fff',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {item.query}
        </div>
        <div style={{ fontSize: '10px', color: 'var(--text-dim, #888)', marginTop: '2px', display: 'flex', gap: '8px' }}>
          {date && <span>{date}</span>}
          <span>{item.source_count} sources</span>
          {item.duration && <span>{item.duration}</span>}
          {item.category && <span style={{ color: 'var(--color-primary, #00f2ff)' }}>{item.category}</span>}
        </div>
      </div>
      <div style={{ display: 'flex', gap: '4px' }} onClick={e => e.stopPropagation()}>
        <button onClick={onArchive} title="Archive" aria-label={`Archive research: ${item.query}`} style={miniBtn}>
          <Archive size={12} aria-hidden="true" />
        </button>
        <button onClick={onDelete} title="Delete" aria-label={`Delete research: ${item.query}`} style={{ ...miniBtn, color: '#f44336' }}>
          <Trash2 size={12} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

const miniBtn = {
  background: 'none', border: 'none', color: 'var(--text-dim, #888)',
  cursor: 'pointer', padding: '4px', borderRadius: '4px',
};

// ── Reusable action button ──

function ActionBtn({ icon, label, onClick, dim, danger, highlight }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: '4px',
        padding: '5px 10px', borderRadius: '6px', fontSize: '11px',
        fontWeight: 600, cursor: 'pointer',
        border: '1px solid ' + (danger ? 'rgba(244,67,54,0.3)' : highlight ? 'rgba(0,242,255,0.4)' : 'var(--border, #2a2a2a)'),
        background: highlight ? 'rgba(0,242,255,0.1)' : 'transparent',
        color: danger ? '#f44336' : highlight ? 'var(--color-primary, #00f2ff)' : dim ? 'var(--text-dim, #888)' : 'var(--text, #e0e0e0)',
        transition: 'all 0.15s ease',
        opacity: dim ? 0.7 : 1,
      }}
    >
      <span aria-hidden="true" style={{ display: 'inline-flex' }}>{icon}</span>{label}
    </button>
  );
}
