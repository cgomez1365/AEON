import React, { useState, useEffect, useRef } from 'react';

const isVercel = window.location.hostname.includes('vercel.app');
import { Send, Loader, Filter, ThumbsUp, ThumbsDown, Cpu, Clock, Zap, Mic, Paperclip, X as XIcon, Eye } from 'lucide-react';
import { useAeonContext } from '../kernel/contexts/AeonContext';
import { useAudioRecorder } from '../kernel/hooks/useAudioRecorder';
import ReactMarkdown from 'react-markdown';
import { useNavigate } from 'react-router-dom';
import remarkGfm from 'remark-gfm';
import { getCommands } from '../kernel/blockRegistry';

// Kernel built-in slash commands — always available, regardless of which blocks
// are installed. Everything else is declared by blocks in their manifests
// (contract.commands) and discovered via getCommands().
const KERNEL_COMMANDS = [
  { cmd: '/clear', desc: 'Clear the terminal history' },
  { cmd: '/go', desc: 'Navigate to a view (e.g. /go settings)' },
  { cmd: '/set', desc: 'Set a model from here — /set grading to local qwen3.5:4b (same store as Settings)' },
  { cmd: '/agent', desc: 'Toggle agent mode (multi-step tool use)' },
  { cmd: '/vp', desc: 'VP mission agent — /vp <goal> launches, /vp status, /vp stop, /vp answer <text>, /vp daemon (is laptop bridge alive?), /vp feed (progress from anywhere)' },
  { cmd: '/vault-push', desc: 'Mirror Second Brain docs to Supabase so the Vercel Command Center sees them on the go' },
  { cmd: '/scan', desc: 'Scan matrix & sync to Supabase' },
  { cmd: '/index-brain', desc: 'Rebuild the Second Brain Table of Contents (new/changed/deleted files)' },
  { cmd: '/matrix', desc: 'Force a Second Brain / AEON Matrix search, e.g. /matrix "build me a guide from my HR notes"' },
  { cmd: '/push', desc: 'Push all blocks to Supabase cloud' },
  { cmd: '/pull', desc: 'Pull all blocks from Supabase cloud' },
  { cmd: '/web', desc: 'Force a live internet search' },
  { cmd: '/treasury', desc: 'Show live deficit & bleed rate' },
  { cmd: '/allow-local', desc: 'Allow AI to fall back to your local runtime model for 15 min when cloud providers are rate-limited' },
  { cmd: '>', desc: 'Execute a raw OS command' },
];

const NeuralTerminal = ({ brainData, allData, onQuerySent, onTypingChange, onHistoryUpdate, onFeedback, selectedModel, onUsageUpdate, liveDeficit, dailyBleed }) => {
  const [input, setInput]           = useState('');
  const [pendingImage, setPendingImage] = useState(null); // { dataUri, name }
  const fileInputRef = useRef(null);
  const [history, setHistory]       = useState([{ role: 'system', content: 'AEON CORTEX Link established. All neural synapses synchronized.' }]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [isLoading, setIsLoading]   = useState(false);
  const [selectedCluster, setSelectedCluster] = useState('All Synapses');
  const [ratings, setRatings]       = useState({});
  const [linkStatus, setLinkStatus] = useState('Checking...');
  const [lastMeta, setLastMeta]     = useState(null);
  const [liveMetrics, setLiveMetrics] = useState(null);
  const scrollRef = useRef();
  
  // COMMAND PALETTE STATE
  const [showCommands, setShowCommands] = useState(false);
  const [commandFilter, setCommandFilter] = useState('');
  
  // agentMode removed: the toggle promised tools with no HTTP surface behind them.

  // Menu = kernel built-ins + commands declared by installed blocks (manifests).
  // Block commands appear/disappear as blocks are added/removed. Built-ins win
  // on a name clash. blockCmdMap lets the dispatcher route a typed command to
  // its owning block's endpoint.
  const blockCommands = React.useMemo(() => getCommands(), []);
  const blockCmdMap = React.useMemo(() => {
    const m = {};
    for (const c of blockCommands) if (!m[c.cmd]) m[c.cmd] = c;
    return m;
  }, [blockCommands]);
  const COMMANDS = React.useMemo(() => {
    const builtinNames = new Set(KERNEL_COMMANDS.map(c => c.cmd));
    const merged = [...KERNEL_COMMANDS, ...blockCommands.filter(c => !builtinNames.has(c.cmd))];
    return merged.sort((a, b) => (a.cmd === '>' ? 1 : b.cmd === '>' ? -1 : a.cmd.localeCompare(b.cmd)));
  }, [blockCommands]);

  useEffect(() => {
    if (input.startsWith('/') || input.startsWith('>')) {
      setShowCommands(true);
      setCommandFilter(input.toLowerCase());
    } else {
      setShowCommands(false);
    }
  }, [input]);
  
  const selectCommand = (cmd) => {
    setInput(cmd + ' ');
    setShowCommands(false);
    const tx = document.querySelector('.terminal-input');
    if (tx) tx.focus();
  };


  const { isRecording, startRecording, stopRecording, audioBlob, resetAudio } = useAudioRecorder();
  const aeon = useAeonContext();
  const navigate = useNavigate();

  const handleImageSelect = (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setHistory(prev => [...prev, { role: 'error', content: '[VISION] Please select an image file.' }]);
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setHistory(prev => [...prev, { role: 'error', content: '[VISION] Image too large (max 8MB).' }]);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setPendingImage({ dataUri: reader.result, name: file.name });
    reader.readAsDataURL(file);
  };

  const clusters = ['All Synapses', ...new Set((allData?.nodes || []).map(n => n.cluster).filter(Boolean))];

  // Fetch history on mount — try API, fall back to Supabase
  useEffect(() => {
    const fetchHistory = async () => {
      try {
        const res = await fetch('/api/terminal-history');
        if (res.ok) {
          const data = await res.json();
          setHistory(data);
          setHistoryLoaded(true);
          return;
        }
      } catch {}
      // Supabase fallback for Vercel
      try {
        const sbUrl = (import.meta.env.VITE_SUPABASE_URL || '');
        const sbKey = (import.meta.env.VITE_SUPABASE_ANON_KEY || '');
        const sbRes = await fetch(`${sbUrl}/rest/v1/aeon_terminal_history?session_id=eq.default&select=messages`, { headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` } });
        const rows = await sbRes.json();
        if (rows?.[0]?.messages) {
          setHistory(rows[0].messages);
        }
      } catch (e) {
        console.error('Failed to load terminal history:', e);
      } finally {
        setHistoryLoaded(true);
      }
    };
    fetchHistory();
  }, []);

  // SSE Bridge for Real-Time Kernel Logs (Zero-Trust Compliant)
  useEffect(() => {
    if (!historyLoaded) return;
    let sse;
    let pendingLogs = [];
    let flushTimeout;

    const connectSSE = () => {
      sse = new EventSource('/api/terminal-stream');
      
      sse.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          const isCrit = data.type === 'CRIT';
          const isWarn = data.type === 'WARN';
          const isSystem = data.type === 'SYSTEM_METRIC';
          
          let role = 'assistant';
          if (isCrit) role = 'error';
          else if (isWarn) role = 'warn';
          else if (isSystem) role = 'system';

          let prefix = data.type === 'SYSTEM/CORE' ? '' : `[${data.type}] `;
          if (isCrit) prefix = `⚠️ [CRITICAL ALERT] `;
          if (isWarn) prefix = `⚠️ [RAM WARNING] `;
          
          if (isSystem || (isWarn && data.message.includes('VRAM/RAM'))) {
            setLiveMetrics({
              ...data.meta,
              isWarn
            });
            return; // Prevent spamming the chat log
          }
          
          pendingLogs.push({
            role,
            content: `${prefix}${data.message}`,
            meta: data.meta || { model: 'AEON KERNEL', provider: 'host-pc', latencyMs: 0 },
            isCrit,
            isWarn,
            isSystem
          });

          // Debounce updates by 300ms to prevent React render lag
          clearTimeout(flushTimeout);
          flushTimeout = setTimeout(() => {
            setHistory(prev => [...prev, ...pendingLogs]);
            pendingLogs = [];
          }, 300);

        } catch(e) {}
      };

      sse.onerror = () => {
        console.warn('[AEON] SSE Bridge dropped. Reconnecting...');
        sse.close();
        setTimeout(connectSSE, 3000); // Auto-reconnect fallback
      };
    };

    connectSSE();

    return () => {
      if (sse) sse.close();
      clearTimeout(flushTimeout);
    };
  }, [historyLoaded]);

  // Persist history automatically to backend + Supabase
  useEffect(() => {
    if (!historyLoaded) return;
    const saveHistory = async () => {
      try {
        await fetch('/api/terminal-history', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ history })
        });
      } catch {}
      // Also save to Supabase so Vercel/mobile can read it
      try {
        const sbUrl = (import.meta.env.VITE_SUPABASE_URL || '');
        const sbKey = (import.meta.env.VITE_SUPABASE_ANON_KEY || '');
        await fetch(`${sbUrl}/rest/v1/aeon_terminal_history?session_id=eq.default`, {
          method: 'PATCH',
          headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ messages: history.slice(-50), updated_at: new Date().toISOString() }),
        });
      } catch (e) {
        console.error('Failed to save terminal history:', e);
      }
    };
    // Fire-and-forget ingest of user turns into Second Brain (local only)
    const ingestTurns = () => {
      fetch('/api/crn/second-brain/ingest/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'default', messages: history }),
      }).catch(() => {}); // never blocks
    };

    const t = setTimeout(() => { saveHistory(); ingestTurns(); }, 1500);
    return () => clearTimeout(t);
  }, [history, historyLoaded]);

  // Auto-transcribe audio when recording stops
  useEffect(() => {
    if (audioBlob) {
      handleTranscribe(audioBlob);
    }
  }, [audioBlob]);

  const handleTranscribe = async (blob) => {
    setIsLoading(true);
    setInput('Transcribing audio...');
    try {
      const base64data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("File reading failed"));
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });

      const res = await fetch('/api/transcribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioBase64: base64data })
      });
      
      if (!res.ok) {
        let errMsg = 'Transcription failed';
        try {
          const errData = await res.json();
          errMsg = errData.error || errMsg;
        } catch(e) {}
        throw new Error(errMsg);
      }
      
      const data = await res.json();
      setInput(data.text);
      resetAudio();
      setIsLoading(false);
    } catch (e) {
      console.error(e);
      setInput('');
      setHistory(prev => [...prev, { role: 'error', content: `Audio Error: ${e.message}` }]);
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    onHistoryUpdate?.(history);
  }, [history]);

  useEffect(() => {
    const checkLink = async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        console.warn('Link check timed out after 10s');
        controller.abort();
      }, 10000);

      try {
        console.log('--- LINK CHECK START ---');
        const res = await fetch('/api/health', {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        console.log('Link check status:', res.status);
        if (res.ok) setLinkStatus('Stable');
        else throw new Error('not ok');
      } catch (e) {
        clearTimeout(timeoutId);
        // On Vercel/cloud: check Supabase connectivity instead
        try {
          const _sbUrl = import.meta.env.VITE_SUPABASE_URL || '';
          const _sbKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
          const sbRes = await fetch(`${_sbUrl}/rest/v1/aeon_blocks?block_tag=eq.brain_graph&select=block_tag`, {
            headers: { apikey: _sbKey, Authorization: `Bearer ${_sbKey}` }
          });
          if (sbRes.ok) { setLinkStatus('Cloud'); return; }
        } catch {}
        setLinkStatus('Offline');
      }
    };
    checkLink();
    const interval = setInterval(checkLink, 60000);
    return () => clearInterval(interval);
  }, []);

  const handleInputChange = (e) => {
    const val = e.target.value;
    setInput(val);
    
    // Auto-expand textarea height
    e.target.style.height = '36px'; // Reset first
    const newHeight = Math.min(e.target.scrollHeight, 120);
    e.target.style.height = `${newHeight}px`;

    onTypingChange?.(val.length > 0);
  };

  const rateMessage = (index, type) => {
    setRatings(prev => ({ ...prev, [index]: type }));
    const msg = history[index];
    onFeedback?.({ ...msg, rating: type, timestamp: new Date().toISOString() });
  };

  const handleSend = async () => {
    if ((!input.trim() && !pendingImage) || isLoading) return;

    const rawQuery = input.trim() || (pendingImage ? `What's in this image (${pendingImage.name})?` : '');
    const query = rawQuery.startsWith('/') || rawQuery.startsWith('>') ? rawQuery.toLowerCase() : rawQuery;

    // Reset textarea height after sending
    const tx = document.querySelector('.terminal-input');
    if (tx) tx.style.height = '36px';

    onTypingChange?.(false);
    setIsLoading(true);
    setLastMeta(null);


    // ── CLEAR COMMAND INTERCEPTOR ─────────────────────────────────
    if (query === '/clear') {
      try {
        await fetch('/api/chat', { method: 'DELETE' });
        setHistory([{ role: 'system', content: 'SYSTEM RESET. WAITING FOR CEO COMMAND.' }]);
      } catch (e) {}
      setIsLoading(false);
      setInput('');
      return;
    }

    // Use rawQuery for display in history (preserves user's casing)
    const displayQuery = rawQuery;

    // ── ALLOW-LOCAL: operator's "yes" to run cloud-exhausted AI calls on ──
    // the local runtime model for the next 15 minutes.
    if (query === '/allow-local') {
      try {
        const r = await (await fetch('/api/system/allow-local', { method: 'POST' })).json();
        setHistory(prev => [...prev, { role: 'system', content: `✅ Local model fallback allowed until ${new Date(r.until).toLocaleTimeString()}.` }]);
      } catch (e) {
        setHistory(prev => [...prev, { role: 'error', content: `Failed to enable local fallback: ${e.message}` }]);
      }
      setIsLoading(false); setInput(''); return;
    }

    // ── AGENT MODE ───────────────────────────────────────────────
    // The multi-step agent loop is real and works — but it lives in
    // tools/terminal/agent.cjs and is reachable only from the `aeon agent`
    // CLI. There is no HTTP surface for it: /api/agent/run, /api/agent/mission
    // and /api/agent/missions have never been mounted by anything.
    //
    // Turning this mode "ON" therefore promised tools it could not use and
    // 404'd on the next message. A control that announces a capability and
    // then silently does nothing is the worst failure mode we can ship — it is
    // exactly what a non-technical operator cannot diagnose. Until an
    // agent_core BLOCK owns this surface, say so plainly.
    if (query === '/agent') {
      setHistory(prev => [...prev, { role: 'system', content:
        '[AGENT] Agent mode is not available in this window yet.\n\n'
        + 'The multi-step agent works today from the command line:\n'
        + '    aeon agent "your goal here"\n\n'
        + 'It runs through the same command registry this terminal uses, so it\n'
        + 'can only invoke commands your blocks already declare.' }]);
      setIsLoading(false); setInput(''); return;
    }

    // AGENT EXECUTION -- removed with the agent-mode toggle above.
    // This posted to /api/agent/run, which nothing mounts, and read the
    // response as an SSE stream -- so a 404 surfaced as an opaque parse
    // error rather than "that feature isn't here yet". Restore when an
    // agent_core block owns /api/agent/*.

    // ── SCAN INTERCEPTOR ──────────────────────────────────────────
    // ── WEB SEARCH ────────────────────────────────────────────────
    if (query === '/web' || query.startsWith('/web ')) {
      const q = query.slice(4).trim();
      if (!q) {
        setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'error', content: '[WEB] Usage: /web <what to search for>' }]);
        setInput(''); setIsLoading(false); return;
      }
      setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'system', content: `[WEB] Searching the internet for "${q}"…` }]);
      setInput('');
      try {
        const res = await fetch(`/api/search-web?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        if (data.ok) {
          setHistory(prev => [...prev, { role: 'assistant', content: data.answer, meta: { model: 'Web Search', provider: 'DuckDuckGo + LLM', latencyMs: 0 } }]);
        } else {
          setHistory(prev => [...prev, { role: 'error', content: `[WEB] ${data.answer || data.error || 'No results found.'}` }]);
        }
      } catch (e) {
        setHistory(prev => [...prev, { role: 'error', content: `[WEB] Search error: ${e.message}` }]);
      }
      setIsLoading(false);
      return;
    }

    // /set — natural-language settings from the terminal. Writes the SAME
    // store the Settings panel writes (settings.models + endpoint registry),
    // so there is one source of truth, not a second entry point.
    if (query === '/set' || query.startsWith('/set ')) {
      const phrase = query.slice(4).trim();
      if (!phrase) {
        setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'error', content: '[SET] Usage: /set <role> to <provider> <model>  ·  e.g. /set grading to local qwen3.5:4b' }]);
        setInput(''); setIsLoading(false); return;
      }
      setHistory(prev => [...prev, { role: 'user', content: query }]);
      setInput('');
      try {
        const r = await fetch('/api/settings/nl', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phrase: query.slice(1) }) });
        const d = await r.json();
        if (d.ok) {
          setHistory(prev => [...prev, { role: 'assistant', content: `[SET] ✓ ${d.message}  (registry: ${d.registry})`, meta: { model: 'Settings', provider: 'localhost', latencyMs: 0 } }]);
        } else {
          setHistory(prev => [...prev, { role: 'error', content: `[SET] ${d.error}${d.roles ? '  · roles: ' + d.roles.join(', ') : ''}` }]);
        }
      } catch (e) {
        setHistory(prev => [...prev, { role: 'error', content: `[SET] ${e.message}` }]);
      }
      setIsLoading(false);
      return;
    }

    if (query === '/scan') {
      setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'system', content: '[SYSTEM] Initiating full matrix scan and Supabase 2-way sync...' }]);
      setInput('');
      try {
        const res = await fetch('/api/system/scan', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          setHistory(prev => [...prev, { role: 'system', content: `[SYSTEM] Scan Complete:\n${data.logs.join('\n')}` }]);
        } else {
          setHistory(prev => [...prev, { role: 'error', content: `[SYSTEM] Scan Failed: ${data.error}` }]);
        }
      } catch (e) {
        setHistory(prev => [...prev, { role: 'error', content: `[SYSTEM] Scan Error: ${e.message}` }]);
      }
      setIsLoading(false);
      return;
    }

    // ── INDEX SECOND BRAIN DOCS ──────────────────────────────────
    if (query === '/index-brain') {
      setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'system', content: '[SECOND BRAIN] Scanning & indexing docs... (streaming)' }]);
      setInput('');
      try {
        const res = await fetch('/api/crn/second-brain/ingest/scan-docs', { method: 'POST' });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let summary = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const lines = decoder.decode(value).split('\n').filter(l => l.startsWith('data:'));
          for (const line of lines) {
            try {
              const ev = JSON.parse(line.slice(5));
              if (ev.done) summary = `[SECOND BRAIN] Index complete. ${ev.ingested} chunks ingested, ${ev.skipped} skipped.${ev.errors?.length ? ` ${ev.errors.length} errors.` : ''}`;
              else setHistory(prev => [...prev, { role: 'system', content: `[INDEX] ${ev.file}: ${ev.error || `${ev.chunks} chunks`}` }]);
            } catch {}
          }
        }
        if (summary) setHistory(prev => [...prev, { role: 'system', content: summary }]);
      } catch (e) {
        setHistory(prev => [...prev, { role: 'error', content: `[SECOND BRAIN] Index error: ${e.message}` }]);
      }
      setIsLoading(false);
      return;
    }

    // ── NAVIGATION INTERCEPTOR ────────────────────────────────────
    if (query.startsWith('/go ') || query.startsWith('/nav ')) {
      const target = query.split(' ').slice(1).join(' ').toLowerCase().trim();
      // Dynamic: read from the block registry (loaded via import.meta.glob manifests)
      let resolvedPath = null;
      let resolvedLabel = target;
      try {
        const manifests = import.meta.glob('../blocks/*/block.manifest.json', { eager: true });
        for (const [p, mod] of Object.entries(manifests)) {
          const m = mod.default || mod;
          const id = (m.id || '').toLowerCase();
          const label = (m.label || '').toLowerCase();
          const route = m.route;
          const navLabel = (m.nav?.label || '').toLowerCase();
          // Match by id, label, nav label, route (without slash), or common aliases
          if (id === target || label === target || navLabel === target ||
              route?.slice(1) === target || id.replace(/_/g, ' ') === target ||
              label.replace(/ /g, '') === target) {
            resolvedPath = route;
            resolvedLabel = m.nav?.label || m.label || id;
            break;
          }
        }
      } catch {}
      // Hardcoded fallbacks for non-block routes
      if (!resolvedPath) {
        const extras = { 'brain': '/second_brain', 'second-brain': '/second_brain', 'second brain': '/second_brain' };
        resolvedPath = extras[target] || null;
        if (resolvedPath) resolvedLabel = target;
      }

      if (resolvedPath) {
        setHistory(prev => [...prev, { role: 'user', content: query }]);
        setHistory(prev => [...prev, { role: 'system', content: `[SYSTEM] Navigating to ${resolvedLabel} (${resolvedPath})` }]);
        navigate(resolvedPath);
      } else {
        // List all available blocks so the user knows what's installed
        let available = [];
        try {
          const manifests = import.meta.glob('../blocks/*/block.manifest.json', { eager: true });
          available = Object.values(manifests).map(mod => {
            const m = mod.default || mod;
            return `${m.id} → ${m.route}`;
          });
        } catch {}
        setHistory(prev => [...prev, { role: 'user', content: query }]);
        setHistory(prev => [...prev, { role: 'error', content: `[SYSTEM] Unknown block: "${target}"\n\nInstalled blocks:\n${available.join('\n')}` }]);
      }
      setInput('');
      setIsLoading(false);
      return;
    }

    // ── QUICK NOTES INTERCEPTOR ───────────────────────────────────
    if (query.startsWith('/note ')) {
      const noteText = rawQuery.substring(6).trim();
      setHistory(prev => [...prev, { role: 'user', content: query }]);
      setInput('');
      try {
        const res = await fetch('/api/notes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note: noteText })
        });
        if (res.ok) {
          setHistory(prev => [...prev, {
            role: 'assistant',
            content: `✓ Note synchronized to aeon_notes.json:\n"${noteText}"`,
            meta: { model: 'Local Notes Engine', provider: 'host-pc', latencyMs: 0 }
          }]);
        } else {
          throw new Error('Server rejected note');
        }
      } catch (err) {
        setHistory(prev => [...prev, { role: 'error', content: `Notes Sync Error: ${err.message}` }]);
      } finally {
        setIsLoading(false);
      }
      return;
    }

    // ── AUTOPILOT COMMANDS (/autopilot, /upload) ───────────────────
    if (query === '/autopilot' || query.startsWith('/autopilot ') || query === '/upload') {
      setHistory(prev => [...prev, { role: 'user', content: query }]);
      setInput('');
      try {
        let res;
        if (query === '/upload') {
          res = await fetch('/api/autopilot/upload-now', { method: 'POST' });
        } else if (query === '/autopilot stop') {
          res = await fetch('/api/autopilot/stop', { method: 'POST' });
        } else if (query.startsWith('/autopilot start')) {
          const parts = query.split(' ');
          const batch = parseInt(parts[2]) || 5;
          res = await fetch('/api/autopilot/start', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ batchSize: batch, cooldownMinutes: 2 }),
          });
        } else {
          res = await fetch('/api/autopilot/status');
        }
        const data = await res.json();
        setHistory(prev => [...prev, {
          role: 'assistant',
          content: `[AUTOPILOT]\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``,
          meta: { model: 'Autopilot Daemon', provider: 'localhost', latencyMs: 0 }
        }]);
      } catch (err) {
        setHistory(prev => [...prev, { role: 'error', content: `Autopilot Error: ${err.message}` }]);
      } finally { setIsLoading(false); }
      return;
    }

    // ── MEMORY COMMANDS (/memory, /tidy) ─────────────────────────
    if (query.startsWith('/memory ') || query.startsWith('/tidy')) {
      setHistory(prev => [...prev, { role: 'user', content: query }]);
      setInput('');
      try {
        let res;
        if (query === '/tidy') {
          setHistory(prev => [...prev, { role: 'system', content: '[MEMORY] Running LLM dedup & consolidation...' }]);
          // memory_core exposes /memory/distill — there has never been a /tidy
          // route, so this command 404'd silently for its whole life.
          res = await fetch('/api/memory/distill', { method: 'POST' });
        } else {
          const memText = query.substring(8).trim();
          res = await fetch('/api/memory/add', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: memText, category: 'fact', source: 'terminal' }),
          });
        }
        const data = await res.json();
        const msg = query === '/tidy'
          ? `[MEMORY] Tidy complete: ${data.before} → ${data.after} (${data.removed} removed)`
          : `[MEMORY] Stored: "${query.substring(8).trim()}" (${data.count} total)`;
        setHistory(prev => [...prev, { role: 'assistant', content: msg, meta: { model: 'Memory Engine', provider: 'localhost', latencyMs: 0 } }]);
      } catch (err) {
        setHistory(prev => [...prev, { role: 'error', content: `Memory Error: ${err.message}` }]);
      } finally { setIsLoading(false); }
      return;
    }

    // ── TREASURY & SYNC-PNL ──────────────────────────────────────
    if (query === '/treasury' || query === '/sync-pnl') {
      setHistory(prev => [...prev, { role: 'user', content: query }]);
      setInput('');
      try {
        if (query === '/sync-pnl') {
          // Trading engine block was removed — no /api/trading/* routes exist.
          setHistory(prev => [...prev, {
            role: 'assistant',
            content: '[TREASURY] /sync-pnl unavailable: the trading block was removed from this build.',
            meta: { model: 'Treasury', provider: 'localhost', latencyMs: 0 }
          }]);
        } else {
          const deficit = liveDeficit != null ? Math.abs(liveDeficit).toFixed(2) : '??';
          // No numeric default: 9.41 was one operator's actual daily interest,
          // shown to every user as if it were their own.
          const bleedVal = dailyBleed ?? parseFloat(localStorage.getItem('aeon_snap_bleed'));
          const bleed = Number.isFinite(bleedVal) ? bleedVal.toFixed(2) : '??';
          const principal = parseFloat(localStorage.getItem('aeon_snap_principal')) || null;
          const accrued = liveDeficit != null && principal != null ? (Math.abs(liveDeficit) - Math.abs(principal)).toFixed(2) : '??';
          setHistory(prev => [...prev, {
            role: 'assistant',
            content: `[TREASURY]\n- Deficit: -$${deficit}\n- Daily Bleed: $${bleed}/day${principal != null ? `\n- Principal: -$${Math.abs(principal).toFixed(2)}` : ''}\n- Accrued: $${accrued}`,
            meta: { model: 'Treasury', provider: 'localhost', latencyMs: 0 }
          }]);
        }
      } catch (err) {
        setHistory(prev => [...prev, { role: 'error', content: `Treasury Error: ${err.message}` }]);
      } finally { setIsLoading(false); }
      return;
    }

    // ── GPU & MODEL COMMANDS ─────────────────────────────────────
    if (query === '/gpu' || query === '/models') {
      setHistory(prev => [...prev, { role: 'user', content: query }]);
      setInput('');
      try {
        const endpoint = query === '/gpu' ? '/api/cookbook/gpus' : '/api/model/cached';
        const res = await fetch(endpoint);
        const data = await res.json();
        let content;
        if (query === '/gpu') {
          const gpus = data.gpus || [];
          content = gpus.length > 0
            ? `[GPU PROBE]\n${gpus.map(g => `GPU ${g.index}: ${g.name} | ${(g.free_mb/1024).toFixed(1)}/${(g.total_mb/1024).toFixed(1)} GB | ${g.util_pct}% util`).join('\n')}`
            : `[GPU] ${data.note || data.error || 'No NVIDIA GPU detected'}`;
        } else {
          const models = data.models || [];
          content = models.length > 0
            ? `[CACHED MODELS] ${models.length} found:\n${models.map(m => `• ${m.repo_id} (${m.size})`).join('\n')}`
            : '[MODELS] No cached models found.';
        }
        setHistory(prev => [...prev, { role: 'assistant', content, meta: { model: 'Cookbook', provider: 'localhost', latencyMs: 0 } }]);
      } catch (err) {
        setHistory(prev => [...prev, { role: 'error', content: `Probe Error: ${err.message}` }]);
      } finally { setIsLoading(false); }
      return;
    }

    // ── SCRAPE COMMAND (/scrape <query>) — works on localhost AND Vercel ──
    if (query.startsWith('/scrape ')) {
      const scrapeQuery = rawQuery.substring(8).trim();
      if (!scrapeQuery) { setIsLoading(false); return; }
      setHistory(prev => [...prev, { role: 'user', content: query }]);
      setInput('');
      setHistory(prev => [...prev, { role: 'system', content: `[ORION] Scraping: "${scrapeQuery}"...` }]);

      const _formatLeads = (leads, citations) => {
        let content = '';
        if (leads?.length > 0) {
          content = `**${leads.length} leads found:**\n\n` + leads.map((l, i) =>
            `${i+1}. **${l.name}**${l.industry ? ` (${l.industry})` : ''}${l.location ? ` — ${l.location}` : ''}\n   ${l.url || ''}${l.email ? ` | ${l.email}` : ''}${l.phone ? ` | ${l.phone}` : ''}\n   ${l.description || ''}`
          ).join('\n\n');
        }
        if (citations?.length) content += '\n\n**Sources:**\n' + citations.map(c => `[${c.id}] ${c.url}`).join('\n');
        return content || 'No results found.';
      };

      try {
        // Try local API first
        const res = await fetch('/api/orion-scrape', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: scrapeQuery, limit: 10 }),
        });
        if (res.ok) {
          const data = await res.json();
          const content = data.leads?.length ? _formatLeads(data.leads, data.citations) : (data.answer || 'No results.');
          setHistory(prev => [...prev, { role: 'assistant', content, meta: { model: 'Orion Scraper', provider: 'localhost', latencyMs: 0 } }]);
          setIsLoading(false);
          return;
        }
      } catch {}

      // Fallback: route through server-side kernelLLM proxy
      try {
        setHistory(prev => [...prev, { role: 'system', content: '[ORION] API unavailable — running kernelLLM research...' }]);
        const aiRes = await fetch('/api/ai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: `You are a business research assistant. Research the following topic and return structured findings with specific names, companies, contacts, URLs where possible. Be detailed and factual.\n\nQuery: ${scrapeQuery}\n\nReturn your findings as a detailed markdown report with sections. Include any real businesses, organizations, or contacts you know about.`,
            role: 'research',
          }),
        });
        const aiData = await aiRes.json();
        const content = aiData.text || 'No results.';
        setHistory(prev => [...prev, { role: 'assistant', content, meta: { model: 'kernelLLM', provider: 'server-proxy', latencyMs: 0 } }]);
      } catch (err) {
        setHistory(prev => [...prev, { role: 'error', content: `Scrape failed: ${err.message}` }]);
      } finally { setIsLoading(false); }
      return;
    }

    // ── REPORT BUILDER (/report <client name>) ─────────────────
    if (query.startsWith('/report ')) {
      const clientName = rawQuery.substring(8).trim();
      if (!clientName) { setIsLoading(false); return; }
      setHistory(prev => [...prev, { role: 'user', content: query }]);
      setInput('');

      const groqCall = async (prompt) => {
        const r = await fetch('/api/ai', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, role: 'chat' }),
        });
        const d = await r.json();
        return d.text || '';
      };

      const sections = {};
      const log = (msg) => setHistory(prev => [...prev, { role: 'system', content: `[REPORT] ${msg}` }]);

      try {
        // Phase 1: Market Research
        log(`🔍 Agent: Orion Scraper — researching ${clientName}...`);
        let webContext = '';
        try {
          const searchRes = await fetch(`/api/search-web?q=${encodeURIComponent(clientName + ' business market analysis')}`);
          if (searchRes.ok) {
            const sd = await searchRes.json();
            webContext = (sd.results || []).map(r => `[${r.title}] ${r.snippet}`).join('\n');
          }
        } catch {}
        sections.research = await groqCall(`You are a market research analyst for AEON Intelligence. Write a detailed market analysis for "${clientName}". ${webContext ? 'Web context:\n' + webContext.slice(0, 2000) : 'Use your knowledge.'}\n\nInclude: Industry overview, competitive landscape, market size, growth trends, key challenges. Be specific with data points.`);
        log('✅ Market research complete');

        // Phase 2: Lead Intelligence
        log('🌐 Agent: Orion Scraper — gathering business intel...');
        let scrapedLeads = '';
        try {
          const scrapeRes = await fetch('/api/orion-scrape', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: `${clientName} competitors similar businesses`, limit: 5 }),
          });
          if (scrapeRes.ok) { const sd = await scrapeRes.json(); scrapedLeads = sd.answer || ''; }
        } catch {}
        if (!scrapedLeads) {
          scrapedLeads = await groqCall(`List 5-8 competitors or similar businesses to "${clientName}". For each: name, what they do, estimated size, key differentiator. Be specific.`, 1000);
        }
        sections.competitive = scrapedLeads;
        log('✅ Competitive intel gathered');

        // Phase 3: Operational Audit
        log('⚙️ Agent: Sandbox — operational efficiency analysis...');
        sections.audit = await groqCall(`You are an operational efficiency consultant. Analyze "${clientName}" operations and identify:\n1. Top 5 operational inefficiencies (estimate dollar impact each)\n2. Current estimated efficiency percentage\n3. Target efficiency with improvements\n4. Wasted hours per week estimate\n5. Total annual savings potential\n\nBe specific with numbers. Format as a structured audit.`);
        log('✅ Operational audit complete');

        // Phase 4: HR & Talent Strategy
        log('⚔️ Agent: HR Arsenal — talent acquisition strategy...');
        sections.hr = await groqCall(`You are a Fractional HR consultant. For "${clientName}", generate:\n1. Key roles they likely need to hire\n2. Recommended job posting strategy\n3. Interview framework (5 questions)\n4. Compensation benchmarks for their market\n5. Retention strategy recommendations\n\nBe actionable and specific to their industry.`);
        log('✅ HR strategy complete');

        // Phase 5: Revenue Recommendations
        log('📈 Agent: Groq Strategy — revenue growth plan...');
        sections.revenue = await groqCall(`You are a business growth strategist. For "${clientName}", provide:\n1. 3 quick-win revenue opportunities (implementable in 30 days)\n2. 3 medium-term growth strategies (3-6 months)\n3. Customer acquisition cost reduction tactics\n4. Pricing optimization recommendations\n5. Digital presence action plan\n\nBe specific. Include estimated revenue impact for each.`);
        log('✅ Revenue strategy complete');

        // Phase 6: Compile Executive Report
        log('📋 Compiling executive report...');
        const fullReport = await groqCall(`You are a senior consultant at AEON Intelligence compiling an executive report for "${clientName}".

Using these research sections, write a polished, comprehensive consulting report in Markdown:

## MARKET RESEARCH
${sections.research?.slice(0, 2000)}

## COMPETITIVE INTELLIGENCE
${sections.competitive?.slice(0, 1500)}

## OPERATIONAL AUDIT
${sections.audit?.slice(0, 2000)}

## HR & TALENT STRATEGY
${sections.hr?.slice(0, 1500)}

## REVENUE GROWTH PLAN
${sections.revenue?.slice(0, 1500)}

Format the final report with:
# AEON Intelligence — Executive Consulting Report: ${clientName}
## Executive Summary (3-4 sentences)
## Market Analysis
## Competitive Landscape
## Operational Efficiency Audit (include dollar figures)
## Talent & HR Strategy
## Revenue Growth Recommendations
## Implementation Roadmap (prioritized action items with timelines)
## Projected ROI

Make it CEO-ready. Professional tone. Minimum 1500 words.`, 4000);

        // Open report in new tab
        const reportHtml = buildClientReport(clientName, fullReport, sections);
        const win = window.open('', '_blank');
        if (win) { win.document.write(reportHtml); win.document.close(); }

        // Save to Supabase research library
        try {
          const sbUrl = (import.meta.env.VITE_SUPABASE_URL || '');
          const sbKey = (import.meta.env.VITE_SUPABASE_ANON_KEY || '');
          const sbRes = await fetch(`${sbUrl}/rest/v1/aeon_blocks?block_tag=eq.research_library&select=payload`, { headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` } });
          const rows = await sbRes.json();
          const existing = rows?.[0]?.payload || [];
          existing.unshift({ id: `report-${Date.now()}`, query: `Client Report: ${clientName}`, result: fullReport, sources: [], status: 'done', completed_at: Math.floor(Date.now()/1000), stats: { type: 'Client Report' } });
          await fetch(`${sbUrl}/rest/v1/aeon_blocks`, { method: 'POST', headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' }, body: JSON.stringify({ block_tag: 'research_library', payload: existing.slice(0, 50), updated_at: new Date().toISOString() }) });
        } catch {}

        log(`✅ Report for ${clientName} generated and opened in new tab`);
        setHistory(prev => [...prev, { role: 'assistant', content: `**Client Report: ${clientName}** — 6 agents deployed, 5 sections compiled.\n\nReport opened in a new tab. Also saved to Research Library.\n\nSections: Market Research, Competitive Intel, Operational Audit, HR Strategy, Revenue Growth Plan.`, meta: { model: 'Report Builder (6 agents)', provider: 'Groq + Orion + Bing', latencyMs: 0 } }]);
      } catch (err) {
        setHistory(prev => [...prev, { role: 'error', content: `Report failed: ${err.message}` }]);
      } finally { setIsLoading(false); }
      return;
    }

    // ── SYNC COMMANDS (/push, /pull) ────────────────────────────
    if (query === '/push' || query === '/pull') {
      setHistory(prev => [...prev, { role: 'user', content: query }]);
      setInput('');
      const endpoint = query === '/push' ? '/api/sync/bulk-push' : '/api/sync/bulk-pull';
      setHistory(prev => [...prev, { role: 'system', content: `[SYNC] ${query === '/push' ? 'Pushing to' : 'Pulling from'} Supabase...` }]);
      try {
        const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const data = await res.json();
        if (data.success) {
          const summary = Object.entries(data.results || {}).map(([k, v]) => `  ${k}: ${v.pushed || v.pulled ? '✔' : '—'} ${v.records || 0} records`).join('\n');
          setHistory(prev => [...prev, { role: 'assistant', content: `[SYNC] ${query === '/push' ? 'Push' : 'Pull'} complete:\n${summary}`, meta: { model: 'Sync Engine', provider: 'Supabase', latencyMs: 0 } }]);
        } else {
          setHistory(prev => [...prev, { role: 'error', content: `[SYNC] Failed: ${data.reason || 'Unknown error'}` }]);
        }
      } catch (err) {
        setHistory(prev => [...prev, { role: 'error', content: `[SYNC] Error: ${err.message}` }]);
      } finally { setIsLoading(false); }
      return;
    }

    // ── VP MISSION AGENT (/vp <goal> | status | stop | answer | daemon | feed) ──
    // daemon + feed read Supabase directly so they work from ANYWHERE (Vercel
    // or localhost). Everything else runs locally here, or relays via the
    // desktop bridge when on Vercel (see cloud relay block below).
    if (query === '/vp' || query.startsWith('/vp ')) {
      const vpArg = query.slice(3).trim();
      if (vpArg === 'daemon' || vpArg === 'feed') {
        setHistory(prev => [...prev, { role: 'user', content: query }]);
        setInput('');
        try {
          const sbUrl = import.meta.env.VITE_SUPABASE_URL;
          const sbKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
          const sbH = { apikey: sbKey, Authorization: `Bearer ${sbKey}` };
          if (vpArg === 'daemon') {
            const r = await fetch(`${sbUrl}/rest/v1/bot_status?id=eq.1&select=updated_at,is_running`, { headers: sbH });
            const [row] = await r.json();
            const age = row?.updated_at ? Math.round((Date.now() - new Date(row.updated_at).getTime()) / 1000) : null;
            const alive = age != null && age < 30;
            setHistory(prev => [...prev, { role: 'assistant', content: alive
              ? `[VP] 🟢 Laptop daemon ALIVE — last heartbeat ${age}s ago. VP is reachable; /vp <goal> will execute.`
              : `[VP] 🔴 Laptop daemon ${age == null ? 'has never reported' : `silent for ${age}s`}. Start it on the laptop: python scripts/desktop_bridge.py`,
              meta: { model: 'VP', provider: 'supabase' } }]);
          } else {
            const r = await fetch(`${sbUrl}/rest/v1/vp_feed?select=message,status,created_at&order=created_at.desc&limit=12`, { headers: sbH });
            const rows = await r.json();
            const lines = (rows || []).map(x => `${new Date(x.created_at).toLocaleTimeString()} ${x.message}`).join('\n') || 'Feed empty — VP has not reported yet.';
            setHistory(prev => [...prev, { role: 'assistant', content: `[VP] Mission feed (latest first):\n\n${lines}`, meta: { model: 'VP', provider: 'supabase' } }]);
          }
        } catch (err) {
          setHistory(prev => [...prev, { role: 'error', content: `[VP] Supabase read failed: ${err.message}` }]);
        } finally { setIsLoading(false); }
        return;
      }
    }
    if (!isVercel && query === '/vault-push') {
      setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'system', content: '[VAULT] Pushing Second Brain docs to Supabase…' }]);
      setInput('');
      try {
        const r = await fetch('/api/crn/second-brain/vault-push', { method: 'POST' });
        const d = await r.json();
        setHistory(prev => [...prev, { role: d.ok ? 'assistant' : 'error', content: `[VAULT PUSH] ${d.ok ? '✅' : '⚠'} ${d.pushed ?? 0} pushed / ${d.changed ?? 0} changed / ${d.total ?? 0} total${d.hint ? `\n${d.hint}` : ''}`, meta: { model: 'Cloud Vault', provider: 'supabase' } }]);
      } catch (err) {
        setHistory(prev => [...prev, { role: 'error', content: `[VAULT PUSH] ${err.message}` }]);
      } finally { setIsLoading(false); }
      return;
    }
    // /vp -- the mission runner. Its whole API surface (/api/agent/missions,
    // /api/agent/mission, .../stop, .../answer) has never been mounted, so
    // every branch of this command 404'd and reported a JSON parse failure.
    // The agent loop itself is real and lives in tools/terminal/agent.cjs;
    // it just has no HTTP front door yet. Point the operator at what works
    // instead of failing in a way only a developer could interpret.
    if (query === '/vp' || query.startsWith('/vp ')) {
      const arg = query.slice(3).trim();
      setHistory(prev => [...prev, { role: 'user', content: query }]);
      setInput('');
      setHistory(prev => [...prev, { role: 'assistant', content:
        '[VP] Missions are not available in this window yet.

'
        + 'The agent runs from the command line today:
'
        + `    aeon agent "${arg || 'your goal here'}"

`
        + 'It uses the same command registry as this terminal, so it can only
'
        + 'invoke commands your blocks already declare.',
        meta: { model: 'VP', provider: 'agent_core' } }]);
      setIsLoading(false);
      return;
    }

    // ── TRADING BOT COMMANDS (/start, /stop, /status) ────────────
    const isTradingCmd = query === '/start' || query.startsWith('/start ') || query === '/stop' || query === '/status';

    // ── DIRECT OS COMMAND INTERCEPTOR ─────────────────────────────
    const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    const isPrefixCommand = query.startsWith('>') || query.startsWith('$');
    const commandRegex = /^(git|npm|node|python|pip|dir|ls|mkdir|type|cat|start|powershell|where)\s+/i;
    const isCliCommand = isPrefixCommand || commandRegex.test(query);

    if (isLocal && isTradingCmd) {
      // Trading engine block was removed — no /api/trading/* routes exist.
      setHistory(prev => [...prev, { role: 'user', content: query },
        { role: 'assistant', content: '[TRADING ENGINE] Not installed. The trading block was removed from this build.', meta: { model: 'Kernel', provider: 'localhost', latencyMs: 0 } }]);
      setInput('');
      setIsLoading(false);
      return;
    }

    // OS command execution was removed. /api/exec ran a caller-supplied string
    // through a shell behind a prefix allowlist — a filter, not a boundary.
    // Named OS operations live at /api/os/action with typed arguments.
    if (isLocal && isCliCommand) {
      setHistory(prev => [...prev,
        { role: 'user', content: query },
        {
          role: 'assistant',
          content:
            'OS command execution was removed from AEON.\n\n' +
            'Use /commands for AEON operations, or your own terminal for OS commands.',
          meta: { model: 'Kernel', provider: 'localhost', latencyMs: 0 },
        }]);
      setInput('');
      setIsLoading(false);
      return;
    }

    // ── CLOUD RELAY (Vercel → Supabase → Desktop Bridge) ─────────
    const isVpRelayCmd = query === '/vp' || query.startsWith('/vp ') || query === '/vault-push';
    if (isVercel && (isCliCommand || isTradingCmd || isVpRelayCmd)) {
      const relayCmd = (isTradingCmd || isVpRelayCmd) ? query : (isPrefixCommand ? query : `> ${query}`);
      setHistory(prev => [...prev, { role: 'user', content: query }]);
      setInput('');
      setHistory(prev => [...prev, { role: 'system', content: `[RELAY] Dispatching to desktop bridge: ${relayCmd}` }]);
      try {
        const sbUrl = import.meta.env.VITE_SUPABASE_URL;
        const sbKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
        const sbH = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
        const ins = await fetch(`${sbUrl}/rest/v1/desktop_commands`, {
          method: 'POST', headers: sbH,
          body: JSON.stringify({ command: relayCmd }),
        });
        const rows = await ins.json();
        if (!ins.ok || !Array.isArray(rows) || !rows[0]?.id) {
          const msg = rows?.message || JSON.stringify(rows).slice(0, 200);
          throw new Error(`Supabase rejected the command (HTTP ${ins.status}): ${msg}${ins.status === 401 ? '\n→ Run db/fix_relay_rls.sql in the Supabase SQL editor.' : ''}`);
        }
        const cmdId = rows[0].id;
        // /vp goals can take a while to acknowledge — poll longer for them
        const maxPolls = relayCmd.startsWith('/vp') ? 30 : 15;
        let result = null;
        for (let i = 0; i < maxPolls; i++) {
          await new Promise(r => setTimeout(r, 1000));
          const poll = await fetch(
            `${sbUrl}/rest/v1/desktop_commands?id=eq.${cmdId}&select=status,output`,
            { headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` } }
          );
          const arr = await poll.json();
          const r = Array.isArray(arr) ? arr[0] : null;
          if (r && (r.status === 'completed' || r.status === 'failed')) { result = r; break; }
        }
        setHistory(prev => [...prev, {
          role: result?.status === 'completed' ? 'assistant' : 'error',
          content: result
            ? `[RELAY ${result.status.toUpperCase()}]\n\n${result.output || '(No output)'}`
            : `[RELAY TIMEOUT] Desktop bridge did not respond within ${maxPolls}s.\nIs desktop_bridge.py running on your PC? Check with /vp daemon.`,
          meta: { model: 'Desktop Bridge', provider: 'Supabase Cloud Relay' }
        }]);
      } catch (err) {
        setHistory(prev => [...prev, { role: 'error', content: `[RELAY ERROR] ${err.message}` }]);
      } finally { setIsLoading(false); }
      return;
    }

    // ── BLOCK-DECLARED COMMANDS (manifest-driven generic dispatch) ──
    // Any /command a block declared in its manifest (contract.commands) routes
    // to that block's endpoint. Built-in handlers above win; this catches the
    // rest before falling through to chat. Remove the block → command is gone.
    {
      const cmdToken = query.split(/\s+/)[0];
      const bc = blockCmdMap[cmdToken];
      if (bc && bc.route) {
        const arg = query.slice(cmdToken.length).trim();
        setHistory(prev => [...prev, { role: 'user', content: query }, { role: 'system', content: `[${bc.blockLabel}] ${bc.desc || cmdToken}…` }]);
        setInput('');
        try {
          let res;
          if (bc.method === 'GET') {
            const url = bc.param ? `${bc.route}?${bc.param}=${encodeURIComponent(arg)}` : bc.route;
            res = await fetch(url);
          } else {
            const body = bc.param ? { [bc.param]: arg } : {};
            res = await fetch(bc.route, { method: bc.method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          }
          const data = await res.json().catch(() => ({}));
          const text = bc.display ? data[bc.display]
            : (data.answer || data.text || data.content || data.message || `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``);
          setHistory(prev => [...prev, {
            role: res.ok ? 'assistant' : 'error',
            content: res.ok ? text : `[${bc.blockLabel}] ${data.error || 'Command failed.'}`,
            meta: { model: bc.blockLabel, provider: 'Block Command', latencyMs: 0 },
          }]);
        } catch (e) {
          setHistory(prev => [...prev, { role: 'error', content: `[${bc.blockLabel}] ${e.message}` }]);
        }
        setIsLoading(false);
        return;
      }
    }

    setHistory(prev => [...prev, { role: 'user', content: query }]);
    setInput('');

    // ── VISION TWO-HOP ─────────────────────────────────────────────
    // The chat model (Groq/Gemini text tier) can't see images. If one's
    // attached, a vision-capable model (Settings → "vision" role) reads it
    // first, task-conditioned on what the user actually asked — that
    // description is folded into the prompt below, not sent as a separate
    // turn, so the normal chat pipeline is untouched downstream.
    let imageContext = '';
    const attachedImage = pendingImage;
    setPendingImage(null);
    if (attachedImage) {
      setHistory(prev => [...prev, { role: 'system', content: `👁 Reading ${attachedImage.name}…` }]);
      try {
        const visionRes = await fetch('/api/ai/vision', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            image: attachedImage.dataUri,
            prompt: query
              ? `The user is asking: "${query}". Describe this image with that question in mind — focus on whatever is relevant to it (error messages, UI elements, text, layout, colors, whatever applies).`
              : 'Describe this image in detail — any text, UI elements, error messages, layout, and colors.',
          }),
        });
        let visionData = null;
        try { visionData = await visionRes.json(); } catch { /* empty/non-JSON body — e.g. backend unreachable */ }
        if (visionRes.ok && visionData?.text) {
          imageContext = `\n\n[Attached image "${attachedImage.name}" — vision analysis]: ${visionData.text}`;
        } else if (!visionRes.ok) {
          setHistory(prev => [...prev, { role: 'error', content: `[VISION] Server unreachable or errored (${visionRes.status || 'no response'}). Is the AEON backend running?` }]);
        } else {
          setHistory(prev => [...prev, { role: 'error', content: `[VISION] ${visionData?.error || 'Could not read the image.'}` }]);
        }
      } catch (e) {
        setHistory(prev => [...prev, { role: 'error', content: `[VISION] ${e.message}` }]);
      }
    }

    try {
      // 1. SEMANTIC SEARCH — kernel scoped retrieval (R1-R3), personal_notes =
      // the live vault index. Operator traffic passes the R3 gate by default.
      let relevantDocs = [];
      try {
        const searchRes = await fetch('/api/retrieval/personal_notes/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, k: 5 })
        });
        const contentType = searchRes.headers.get("content-type");
        if (contentType && contentType.includes("application/json")) {
          const searchData = await searchRes.json();
          const passages = searchData.passages || [];
          const top = passages[0]?.score || 0;
          relevantDocs = passages.map(p => ({
            id: p.ref, // docId#chunkN — the citation unit
            content: p.text,
            similarity: top ? p.score / top : 0,
            metadata: { source: p.title || p.docId, path: p.docId },
          }));
        }
      } catch (e) {
        console.warn('Scoped retrieval unavailable:', e);
      }

      // Fire topology nodes
      if (relevantDocs.length > 0) {
        onQuerySent?.(relevantDocs.map(n => n.metadata?.path || String(n.id)));
      } else {
        // Fall back to local keyword match for topology visualization
        const sourceNodes = allData?.nodes || brainData?.nodes || [];
        const queryLower = query.toLowerCase();
        const words = queryLower.split(/\s+/).filter(w => w.length > 2);
        const matched = sourceNodes
          .filter(n => words.some(w => n.title?.toLowerCase().includes(w) || n.content?.toLowerCase().includes(w)))
          .slice(0, 8);
        if (matched.length) onQuerySent?.(matched.map(n => n.id));
      }

      // 1.5. SYSTEM CONTEXT — load full environment so AI sees everything
      let systemContext = '';
      try {
        const ctxRes = await fetch('/api/system/context');
        if (ctxRes.ok) {
          const ctx = await ctxRes.json();
          if (ctx.dailyBleed != null) localStorage.setItem('aeon_snap_bleed', ctx.dailyBleed.toString());
          if (ctx.principal != null) localStorage.setItem('aeon_snap_principal', ctx.principal.toString());
          const blockList = ctx.blocks.list.map(b => `${b.id}(${b.route}${b.ready ? '' : ',MISSING:' + b.missing.join('+')})`).join(', ');
          const providerList = Object.entries(ctx.providers).filter(([, v]) => v).map(([k]) => k).join(', ');
          const modelList = Object.entries(ctx.models).map(([role, m]) => `${role}→${m.provider}/${m.model}`).join(', ');
          systemContext = `
### AEON ENVIRONMENT (live system state):
- Runtime: ${ctx.runtime} | Uptime: ${Math.floor(ctx.telemetry.uptime / 60)}min | LLM calls: ${ctx.telemetry.calls} (${ctx.telemetry.tokens} tokens)
- Deficit: $${ctx.deficit?.toFixed(2) || 'unknown'}
- Blocks: ${ctx.blocks.ready}/${ctx.blocks.total} ready [${blockList}]
- Connected providers: ${providerList}
- Models: ${modelList} | Roulette: ${ctx.roulette ? 'ON' : 'OFF'}
- Vault: ${ctx.vault.unlocked ? 'UNLOCKED' : 'LOCKED'} | Memories: ${ctx.memory.count}
- Tasks: ${ctx.tasks.active}/${ctx.tasks.total} active
- Use /go <block_id> to navigate. You can modify any block via the agent tools.`;
        }
      } catch {}

      // 1.6. MEMORY INJECTION — load pinned memories + brain settings
      let memoryBlock = '';
      try {
        const brainRes = await fetch('/api/prefs/brain_settings');
        const brainData = await brainRes.json();
        const brainPrefs = brainData.value || {};
        if (brainPrefs.memory_in_context !== false) {
          const memRes = await fetch('/api/memory');
          const memData = await memRes.json();
          const allMems = memData.memory || [];
          const pinned = allMems.filter(m => m.pinned);
          const maxCtx = brainPrefs.memory_max_context || 10;
          const inject = (pinned.length ? pinned : allMems).slice(0, maxCtx);
          if (inject.length) {
            memoryBlock = '\n### PERSISTENT MEMORY (' + inject.length + ' facts):\n' +
              inject.map(m => `- [${m.category || 'fact'}] ${m.text}`).join('\n') + '\n';
          }
        }
      } catch {}

      // 2. CONTEXT PREPARATION
      const context = relevantDocs
        .map(n => `[SOURCE: ${n.metadata?.source || 'Unknown'}] (${(n.similarity * 100).toFixed(0)}% match)\n${n.content}`)
        .join('\n\n---\n\n');

      const sourceList = [...new Set(relevantDocs.map(n => n.metadata?.source).filter(Boolean))];
      const sourceTag = sourceList.length > 0 ? `\nSources found: ${sourceList.join(', ')}` : '';

      const recentHistory = history
        .slice(-6)
        .filter(m => m.role !== 'system' && m.role !== 'error')
        .map(m => `${m.role === 'user' ? 'USER' : 'CORE'}: ${m.content}`)
        .join('\n');

      // This prompt shipped with one operator's personal loan balance, daily
      // interest and accrued interest hardcoded into every request — so every
      // user's assistant was primed with somebody else's financial situation.
      // The prompt describes AEON's role; the user's own data reaches the model
      // through NEURAL CONTEXT and memory, which is where user data belongs.
      const prompt = `### SYSTEM PROTOCOL: AEON_CORTEX_V4 (HYBRID_INTELLIGENCE)
Identity: AEON — your Second Brain AI
Current Date & Time: ${new Date().toLocaleString('en-US', { timeZoneName: 'short' })}
Active Model: ${selectedModel || 'gemini'}

### DIRECTIVES:
1. Ground your answer in the NEURAL CONTEXT below. Cite which source document when possible.
2. If the context is insufficient, say so honestly and offer general knowledge as a supplement.
3. Be technical, concise, and professional. Use bullet points for lists.
4. Never fabricate information that isn't in the context.

### NEURAL CONTEXT (${relevantDocs.length} documents retrieved):
${context || 'NO MATCHING DOCUMENTS FOUND. Answer using general knowledge.'}
${sourceTag}
${memoryBlock}
${systemContext}

### RECENT CONVERSATION LOG:
${recentHistory}

### CURRENT USER QUERY:
${query}

If the user wants to add/edit/delete data (workout, client, inventory, deadline, quicklink, dictionary), output a JSON code block in this exact format, and nothing else:
\`\`\`json
{
  "type": "tool_call",
  "tool": "add_workout",
  "args": { "type": "Pull", "exercises": [] }
}
\`\`\`
Tools available: 
- manage_crm: args: { "action": "add/update/delete", "clientName": "", "scale": "", "solution": "", "emrr": 0, "stage": "Lead Identified/Pitch Drafted/Outbox Ready/Mockup Deployed/Contract Sent/Active Client", "contact": { "name": "", "email": "", "phone": "" }, "projectScope": "", "timeline": "", "intakeNotes": "" }
- manage_invoice: args: { "action": "add/update/delete/pay", "clientName": "", "invoiceId": "", "description": "[Invoice Type] - [Brief Description]", "amount": 0, "date": "YYYY-MM-DD", "dueDate": "YYYY-MM-DD", "notes": "", "invoiceNumber": "" }
  * REQUIRED: If action is add, ask validation points if not provided (Status, Invoice Type, description).
- manage_schedule: args: { "action": "add/update/delete/complete", "type": "event/workout/deadline", "title": "", "targetTitle": "Title to find if updating/deleting/completing", "date": "YYYY-MM-DD", "dueDate": "YYYY-MM-DD", "time": "HH:MM", "notes": "", "category": "", "priority": "", "exercises": [], "updates": {} }
- manage_links: args: { "action": "add/update/delete", "name": "", "url": "https://...", "category": "General", "description": "" }
- manage_dictionary: args: { "action": "add/update/delete", "keyword": "", "name": "", "role": "", "category": "USER-DEFINED" }
- manage_inventory: args: { "action": "add/update/delete/decrement", "name": "", "quantity": 0, "category": "General", "notes": "" }
- restore_item: args: { "itemName": "Name or ID of item to recover from trash" }
- send_email: args: { "to": "email@address.com", "subject": "Subject", "body": "Body content" }
- manage_notes: args: { "action": "add/update/delete", "id": "noteId (if updating/deleting)", "title": "Note title", "body": "Note content", "tags": ["tag1"] }
- trigger_scraper: args: { "query": "search query for duckduckgo to find leads" }
- dispatch_document: args: { "documentName": "Name of document", "recipientEmail": "email@address.com" }
- manage_memory: args: { "action": "add/tidy", "text": "fact to remember", "category": "fact/identity/preference/contact/project/goal/task" }
- control_autopilot: args: { "action": "start/stop/status", "batchSize": 5 }
- control_trading: args: { "action": "start/stop/status", "mode": "aggressive/moderate/passive" }
If you need more info to complete an action, output regular text to ask the user instead of formatting as JSON.

### RESPONSE:`;

      // 3. GENERATION — SSE streaming (tokens render as they arrive)
      const streamRes = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: prompt + imageContext, role: 'chat', history: history.slice(-10) }),
      });

      let data = { response: '' };
      let usedStream = false;

      if (streamRes.ok && streamRes.headers.get('content-type')?.includes('text/event-stream')) {
        usedStream = true;
        // SSE streaming path — render tokens incrementally
        const reader = streamRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let streamedText = '';
        let streamMeta = {};

        // Insert a placeholder assistant message that we'll update in-place
        const streamId = Date.now();
        setHistory(prev => [...prev, { role: 'assistant', content: '', _streamId: streamId }]);

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
              if (line.startsWith('event: ')) {
                const eventType = line.slice(7).trim();
                const nextLine = lines[lines.indexOf(line) + 1];
                if (!nextLine || !nextLine.startsWith('data: ')) continue;
                try {
                  const payload = JSON.parse(nextLine.slice(6));
                  if (eventType === 'token') {
                    streamedText += payload.t;
                    setHistory(prev => prev.map(m => m._streamId === streamId ? { ...m, content: streamedText } : m));
                  } else if (eventType === 'meta') {
                    streamMeta = payload;
                  } else if (eventType === 'warning') {
                    setHistory(prev => [...prev, { role: 'system', content: payload.message }]);
                  } else if (eventType === 'done') {
                    streamedText = payload.text || streamedText;
                    streamMeta = { ...streamMeta, ...payload };
                  } else if (eventType === 'error') {
                    throw new Error(payload.error);
                  }
                } catch (parseErr) {
                  if (parseErr.message && !parseErr.message.includes('JSON')) throw parseErr;
                }
              }
            }
          }
        } catch (streamErr) {
          if (!streamedText) throw streamErr;
        }

        // Finalize the streamed message
        setHistory(prev => prev.map(m => m._streamId === streamId
          ? { role: 'assistant', content: streamedText, meta: { model: streamMeta.model, provider: streamMeta.provider, latencyMs: streamMeta.latencyMs, tokens: streamMeta.tokens } }
          : m));
        data.response = streamedText;
        if (streamMeta) setLastMeta(streamMeta);
        setLiveMetrics({ tokens: streamMeta.tokens, latency: streamMeta.latencyMs, model: streamMeta.model });
        onUsageUpdate?.({ tokens: streamMeta.tokens || 0, latencyMs: streamMeta.latencyMs || 0 });
      } else {
        // Fallback: non-streaming POST /api/chat (Vercel or stream unavailable)
        const chatRes = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: prompt + imageContext, model: selectedModel || 'gemini', sender: 'ceo', name: 'CEO', content: query })
        });
        if (!chatRes.ok) {
          let errMessage = chatRes.statusText;
          try { const errData = await chatRes.json(); if (errData.error) errMessage = errData.error; } catch {}
          throw new Error(`Cortex generation failed: ${errMessage}`);
        }
        const chatContentType = chatRes.headers.get("content-type");
        if (chatContentType && chatContentType.includes("application/json")) {
          data = await chatRes.json();
          if (!data.response) data.response = "Acknowledged. " + query;
        }
      }

      if (data.toolCall) {
        const tc = data.toolCall;
        try {
          // Destructive Action Safety Interceptor
          if (['delete', 'void', 'cancel'].includes(tc.args?.action)) {
             const target = tc.args.clientName || tc.args.description || tc.args.targetTitle || tc.args.name || tc.args.keyword || tc.tool;
             if (!window.confirm(`WARNING: The AI is attempting to delete [${target}].\n\nAre you sure you want to proceed? (This can be recovered from the Trash Bin)`)) {
                setHistory(prev => [...prev, { role: 'assistant', content: `Deletion of ${target} aborted by user.`, meta: data.meta }]);
                setIsLoading(false);
                return;
             }
          }

          if (tc.tool === 'manage_schedule') aeon.manageSchedule(tc.args);
          else if (tc.tool === 'manage_crm') {
             const args = tc.args;
             if (args.email || args.phone || args.number) {
               args.contact = { 
                 ...args.contact, 
                 email: args.email || args.contact?.email || '', 
                 phone: args.phone || args.number || args.contact?.phone || '' 
               };
             }
             aeon.manageCrm(args);
          }
          else if (tc.tool === 'manage_invoice') aeon.manageInvoice(tc.args);
          else if (tc.tool === 'manage_inventory') aeon.manageInventoryObj(tc.args);
          else if (tc.tool === 'manage_links') aeon.manageLinks(tc.args);
          else if (tc.tool === 'manage_dictionary') aeon.manageDict(tc.args);
          else if (tc.tool === 'restore_item') {
             const res = aeon.restoreFromTrash(tc.args.itemName);
             if (!res.success) throw new Error(res.error);
          }
          else if (tc.tool === 'send_email') {
             const gasUrl = import.meta.env.VITE_GAS_URL || 'https://script.google.com/macros/s/AKfycbxgWaHq0gdT7O-9Ff0NiWen60AOG3b6lHw3ey33UBf_e4iJHmavwT3i0thuuWTkAeKINQ/exec';
             const emailRes = await fetch(gasUrl, {
                method: 'POST',
                body: JSON.stringify({ action: 'send_outreach', payload: tc.args }),
                headers: { 'Content-Type': 'text/plain;charset=utf-8' }
             });
             const result = await emailRes.json();
             if (!result.success) throw new Error(result.error || 'Failed to send email via GAS.');
          }
          else if (tc.tool === 'manage_notes') {
             const method = tc.args.action === 'add' ? 'POST' : tc.args.action === 'delete' ? 'DELETE' : 'PUT';
             const noteRes = await fetch('/api/notes', {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(tc.args)
             });
             if (!noteRes.ok) throw new Error('Failed to synchronize note to cloud storage.');
          }
          else if (tc.tool === 'trigger_scraper') {
             const scrapeRes = await fetch('/api/orion-scrape', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: tc.args.query, limit: 10 })
             });
             const scrapeData = await scrapeRes.json();
             
             let researchText = scrapeData.answer ? `\n\n[ORION INTELLIGENCE REPORT]\n${scrapeData.answer}` : '';
             if (scrapeData.citations && scrapeData.citations.length > 0) {
                researchText += `\n\n[SOURCES]\n` + scrapeData.citations.map(c => `[${c.id}] ${c.url}`).join('\n');
             }
             data.customResponse = `ORION WEB SCRAPER EXECUTED.\n${researchText}`;

             const leadsArr = scrapeData.leads || scrapeData.data;
             if (leadsArr && leadsArr.length > 0) {
                const newLeads = leadsArr.map((l, i) => ({
                   id: Date.now().toString() + i, name: l.name, scale: 'SMB', solution: 'Terminal Scrape', emrr: 0, stage: 'Lead Identified', contact: { name: '', email: '', phone: l.phone }, details: `Source: DDG Search. \n\nRaw Data:\n${l.raw_data}`, projectScope: '', timeline: '', intakeNotes: '', invoices: [], url: l.url
                }));
                for (const lead of newLeads) { await aeon.addClient(lead); }
             }
          }
          else if (tc.tool === 'dispatch_document') {
             const gasUrl = import.meta.env.VITE_GAS_URL || 'https://script.google.com/macros/s/AKfycbxgWaHq0gdT7O-9Ff0NiWen60AOG3b6lHw3ey33UBf_e4iJHmavwT3i0thuuWTkAeKINQ/exec';
             const docRes = await fetch(gasUrl, {
                method: 'POST',
                body: JSON.stringify({ action: 'send', payload: { ...tc.args, name: "System", email: tc.args.recipientEmail, phone: "N/A", message: `Dispatching document: ${tc.args.documentName}` } }),
                headers: { 'Content-Type': 'text/plain;charset=utf-8' }
             });
             const result = await docRes.json();
             if (!result.success) throw new Error(result.error || 'Failed to dispatch document.');
          }
          else if (tc.tool === 'manage_memory') {
             if (tc.args.action === 'tidy') {
               const tidyRes = await fetch('/api/memory/tidy', { method: 'POST' });
               const tidyData = await tidyRes.json();
               data.customResponse = `MEMORY TIDY: ${tidyData.before} → ${tidyData.after} (${tidyData.removed} removed)`;
             } else {
               const memRes = await fetch('/api/memory/add', {
                 method: 'POST', headers: { 'Content-Type': 'application/json' },
                 body: JSON.stringify({ text: tc.args.text, category: tc.args.category || 'fact', source: 'ai' }),
               });
               const memData = await memRes.json();
               data.customResponse = memData.message || `Memory stored. ${memData.count} total memories.`;
             }
          }
          else if (tc.tool === 'control_autopilot') {
             let apRes;
             if (tc.args.action === 'start') {
               apRes = await fetch('/api/autopilot/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batchSize: tc.args.batchSize || 5, cooldownMinutes: 2 }) });
             } else if (tc.args.action === 'stop') {
               apRes = await fetch('/api/autopilot/stop', { method: 'POST' });
             } else {
               apRes = await fetch('/api/autopilot/status');
             }
             const apData = await apRes.json();
             data.customResponse = `AUTOPILOT ${(tc.args.action || 'status').toUpperCase()}:\n\`\`\`json\n${JSON.stringify(apData, null, 2)}\n\`\`\``;
          }
          else if (tc.tool === 'control_trading') {
             // Trading engine block was removed — no /api/trading/* routes exist.
             data.customResponse = 'TRADING ENGINE: Not installed. The trading block was removed from this build.';
          }
          
          data.response = data.customResponse || `CORE SYSTEM UPDATE: Successfully executed \`${tc.tool}\`. The portal UI has been synchronized.`;
        } catch(e) {
          data.response = `CORE SYSTEM ERROR: Failed to execute \`${tc.tool}\`. Details: ${e.message}`;
        }
      }

      // Track usage & citations
      if (data.meta) {
        setLastMeta(data.meta);
        onUsageUpdate?.({
          model: data.meta.model,
          provider: data.meta.provider,
          latencyMs: data.meta.latencyMs,
          tokens: data.meta.tokens,
          timestamp: new Date().toISOString(),
          citations: relevantDocs, // Pass citations up
          thoughtLog: [
            `Initializing semantic probe for: "${query}"`,
            `Searching vector database (match_threshold: 0.3)...`,
            `Retrieved ${relevantDocs.length} relevant neural fragments.`,
            `Contextualizing data...`,
            `Generation complete via ${data.meta.model}.`
          ]
        });
      }

      if (!usedStream) {
        setHistory(prev => [...prev, {
          role: 'assistant',
          content: data.response,
          meta: data.meta,
          citations: relevantDocs
        }]);
      }
    } catch (err) {
      setHistory(prev => [...prev, { role: 'error', content: `Neural Link Error: ${err.message}` }]);
    } finally {
      setIsLoading(false);
    }
  };


  return (
    <div className="terminal-shell">
      <div className="cluster-selector">
        <div className={`link-indicator ${linkStatus.toLowerCase()}`}>
          <div className="indicator-dot" />
          LINK: {linkStatus.toUpperCase()}
        </div>
        <Filter size={12} className="cluster-icon" style={{ marginLeft: '10px' }} />
        <select value={selectedCluster} onChange={(e) => setSelectedCluster(e.target.value)} className="cluster-dropdown">
          {clusters.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {liveMetrics && liveMetrics.ram !== undefined && liveMetrics.cpu !== undefined && (
        <div style={{ padding: '12px 20px', background: 'rgba(0,0,0,0.4)', borderBottom: '1px solid rgba(0, 242, 255, 0.1)', display: 'flex', gap: '24px', alignItems: 'center' }}>
          {liveMetrics.isWarn && <span style={{ color: '#ff5500', fontSize: '12px', fontWeight: 'bold' }}>⚠️</span>}
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '10px', color: liveMetrics.isWarn ? '#ff5500' : '#888', marginBottom: '4px', display: 'flex', justifyContent: 'space-between', fontFamily: 'monospace' }}>
              <span>VRAM/RAM LOAD</span>
              <span>{liveMetrics.ram}%</span>
            </div>
            <div style={{ width: '100%', height: '6px', background: 'rgba(26,26,26,0.7)', borderRadius: '3px', overflow: 'hidden', border: '1px solid #333' }}>
              <div style={{ width: `${liveMetrics.ram}%`, height: '100%', background: liveMetrics.isWarn ? '#ff5500' : '#00f2ff', transition: 'width 0.5s ease, background 0.3s ease' }} />
            </div>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '10px', color: '#888', marginBottom: '4px', display: 'flex', justifyContent: 'space-between', fontFamily: 'monospace' }}>
              <span>CPU LOAD</span>
              <span>{liveMetrics.cpu}%</span>
            </div>
            <div style={{ width: '100%', height: '6px', background: 'rgba(26,26,26,0.7)', borderRadius: '3px', overflow: 'hidden', border: '1px solid #333' }}>
              <div style={{ width: `${liveMetrics.cpu}%`, height: '100%', background: '#00f2ff', transition: 'width 0.5s ease' }} />
            </div>
          </div>
        </div>
      )}

      <div ref={scrollRef} className="terminal-messages">
        {history.map((msg, i) => (
          <div key={i} className={`terminal-msg terminal-msg--${msg.role}`}>
            <div className="terminal-msg-label">{msg.role === 'assistant' ? 'CORE' : msg.role.toUpperCase()}</div>
            <div className="terminal-msg-body">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" style={{ color: '#00ff40', textDecoration: 'underline' }} />
                }}
              >
                {msg.content}
              </ReactMarkdown>
              
              {msg.meta && msg.meta.progress !== undefined && (
                <div style={{ marginTop: '8px', width: '100%', height: '4px', background: 'rgba(0,242,255,0.1)', borderRadius: '2px', overflow: 'hidden' }}>
                  <div style={{ width: `${msg.meta.progress}%`, height: '100%', background: msg.meta.progress === 100 ? '#00ff40' : '#00f2ff', transition: 'width 0.3s ease' }} />
                </div>
              )}

              {msg.role === 'assistant' && (
                <>
                  {msg.meta && (
                    <div className="msg-meta-bar">
                      <span className="meta-chip"><Cpu size={10} /> {msg.meta.model}</span>
                      <span className="meta-chip"><Clock size={10} /> {msg.meta.latencyMs}ms</span>
                      {msg.meta.tokens && <span className="meta-chip"><Zap size={10} /> {msg.meta.tokens} tokens</span>}
                    </div>
                  )}
                  <div className="msg-feedback">
                    <button className={`feedback-btn ${ratings[i] === 'up' ? 'active' : ''}`} onClick={() => rateMessage(i, 'up')}>
                      <ThumbsUp size={11} />
                    </button>
                    <button className={`feedback-btn ${ratings[i] === 'down' ? 'active' : ''}`} onClick={() => rateMessage(i, 'down')}>
                      <ThumbsDown size={11} />
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="terminal-msg terminal-msg--loading">
            <div className="terminal-msg-label">CORE</div>
            <div className="terminal-thinking"><span className="think-dot" /><span className="think-dot" /><span className="think-dot" /></div>
          </div>
        )}
      </div>


      {showCommands && (
        <div style={{
          position: 'absolute',
          bottom: '80px',
          left: '20px',
          right: '20px',
          maxHeight: '240px',
          overflowY: 'auto',
          background: 'rgba(10, 15, 25, 0.97)',
          border: '1px solid rgba(0, 242, 255, 0.3)',
          borderRadius: '8px',
          padding: '8px',
          zIndex: 100,
          boxShadow: '0 4px 20px rgba(0,0,0,0.6)',
          backdropFilter: 'blur(12px)',
        }}>
          <div style={{ fontSize: '9px', color: '#888', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '1px', position: 'sticky', top: 0, background: 'rgba(10,15,25,0.97)', padding: '2px 0' }}>Commands ({COMMANDS.filter(c => c.cmd.startsWith(commandFilter) || commandFilter === '/' || commandFilter === '>').length})</div>
          {COMMANDS.filter(c => c.cmd.startsWith(commandFilter) || commandFilter === '/' || commandFilter === '>').map(c => (
            <div 
              key={c.cmd}
              onClick={() => selectCommand(c.cmd)}
              style={{
                padding: '5px 8px',
                cursor: 'pointer',
                borderRadius: '4px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '8px',
                color: '#fff',
                fontSize: '12px',
                transition: 'background 0.15s',
              }}
              onMouseOver={e => e.currentTarget.style.background = 'rgba(0, 242, 255, 0.1)'}
              onMouseOut={e => e.currentTarget.style.background = 'transparent'}
            >
              <span style={{ color: '#00f2ff', fontWeight: 'bold' }}>{c.cmd}</span>
              <span style={{ color: '#aaa', fontSize: '12px' }}>{c.desc}</span>
            </div>
          ))}
        </div>
      )}
      {pendingImage && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px', margin: '0 0 6px', background: 'rgba(0,242,255,0.08)', border: '1px solid rgba(0,242,255,0.25)', borderRadius: '8px', fontSize: '12px', color: '#00f2ff' }}>
          <Eye size={13} />
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pendingImage.name} — will be read before sending</span>
          <button onClick={() => setPendingImage(null)} aria-label="Remove attached image" style={{ background: 'none', border: 'none', color: '#00f2ff', cursor: 'pointer', display: 'flex', padding: 0 }}>
            <XIcon size={14} />
          </button>
        </div>
      )}
      <div className="terminal-input-row">
        <span className="terminal-prompt">›</span>
        <input ref={fileInputRef} type="file" accept="image/*" onChange={handleImageSelect} style={{ display: 'none' }} aria-hidden="true" />
        <button className="terminal-mic" onClick={() => fileInputRef.current?.click()} disabled={isLoading} aria-label="Attach an image" title="Attach an image (screenshot, diagram, etc.)" style={{ background: pendingImage ? 'rgba(0,242,255,0.15)' : 'transparent', border: 'none', color: pendingImage ? '#00f2ff' : '#64748b', cursor: 'pointer', padding: '8px', borderRadius: '8px', display: 'flex', alignItems: 'center', transition: 'all 0.2s' }}>
          <Paperclip size={16} />
        </button>
        <textarea
          className="terminal-input scrollable"
          placeholder="Ask your Second Brain..."
          value={input}
          onChange={handleInputChange}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          onBlur={() => onTypingChange?.(false)}
          disabled={isLoading}
          style={{ resize: 'none', minHeight: '36px', height: '36px', maxHeight: '120px', padding: '10px 0', overflowY: 'auto' }}
        />
        <button className={`terminal-mic ${isRecording ? 'recording' : ''}`} onClick={isRecording ? stopRecording : startRecording} disabled={isLoading} style={{ background: isRecording ? '#ff4466' : 'transparent', border: 'none', color: isRecording ? '#fff' : '#64748b', cursor: 'pointer', padding: '8px', borderRadius: '8px', display: 'flex', alignItems: 'center', transition: 'all 0.2s' }}>
          <Mic size={16} />
        </button>
        <button className="terminal-send" onClick={handleSend} disabled={isLoading || (!input.trim() && !pendingImage)}>
          <Send size={16} />
        </button>
      </div>
    </div>
  );
};

function buildClientReport(clientName, report, sections) {
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const md = (report || '')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^[\-\*] (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`)
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br>');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AEON Intelligence — ${clientName}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap');
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Inter',sans-serif;background:#0a0a0a;color:#e0e0e0;line-height:1.8}
  .cover{min-height:100vh;display:flex;flex-direction:column;justify-content:center;padding:80px;background:linear-gradient(135deg,#0a0a0a 0%,#0d1117 50%,#1a0a2e 100%);border-bottom:1px solid #222}
  .cover .brand{font-size:11px;font-weight:800;letter-spacing:6px;color:#00f2ff;text-transform:uppercase;margin-bottom:40px}
  .cover .client{font-size:3.5em;font-weight:800;color:#fff;line-height:1.1;margin-bottom:16px}
  .cover .sub{font-size:1.2em;color:#888;margin-bottom:40px}
  .cover .meta{font-size:0.85em;color:#555;display:flex;gap:24px}
  .cover .meta span{display:flex;align-items:center;gap:6px}
  .cover .line{width:80px;height:3px;background:linear-gradient(90deg,#00f2ff,#8b5cf6);border-radius:2px;margin-bottom:30px}
  .body{max-width:900px;margin:0 auto;padding:60px 40px}
  .body h1{font-size:1.6em;color:#fff;margin:48px 0 16px;padding-bottom:8px;border-bottom:1px solid #222}
  .body h1:first-child{margin-top:0}
  .body h2{font-size:1.3em;color:#00f2ff;margin:32px 0 12px}
  .body h3{font-size:1.1em;color:#ccc;margin:24px 0 8px}
  .body p{margin-bottom:14px;color:#ccc}
  .body ul{margin:8px 0 16px 24px}
  .body li{margin-bottom:6px;color:#ccc}
  .body strong{color:#fff}
  .footer{max-width:900px;margin:0 auto;padding:40px;text-align:center;border-top:1px solid #222;font-size:0.75em;color:#555}
  .agents{display:flex;gap:12px;margin-top:16px;flex-wrap:wrap}
  .agent-chip{font-size:10px;padding:4px 10px;border-radius:20px;border:1px solid #333;color:#888;font-weight:600}
  @media print{
    body{background:#fff;color:#222}
    .cover{background:#fff;border-bottom:3px solid #000}
    .cover .brand{color:#000}.cover .client{color:#000}.cover .sub{color:#555}
    .body h1{color:#000;border-color:#ddd}.body h2{color:#333}.body p,.body li{color:#444}
  }
</style></head>
<body>
  <div class="cover">
    <div class="brand">AEON Intelligence — Executive Consulting</div>
    <div class="line"></div>
    <div class="client">${clientName}</div>
    <div class="sub">Comprehensive Business Analysis & Strategic Recommendations</div>
    <div class="meta">
      <span>📅 ${date}</span>
      <span>📊 5 Research Sections</span>
      <span>🤖 6 AI Agents Deployed</span>
      <span>🏢 Broken Gear Industries</span>
    </div>
    <div class="agents">
      <span class="agent-chip">🔍 Orion Scraper</span>
      <span class="agent-chip">🧠 Groq Llama 3.3</span>
      <span class="agent-chip">🌐 Bing Search</span>
      <span class="agent-chip">⚙️ Sandbox Auditor</span>
      <span class="agent-chip">⚔️ HR Arsenal</span>
      <span class="agent-chip">📈 Strategy Engine</span>
    </div>
  </div>
  <div class="body"><p>${md}</p></div>
  <div class="footer">
    AEON Intelligence · Broken Gear Industries<br>
    ${date} · Confidential — Prepared exclusively for ${clientName}
  </div>
</body></html>`;
}

export default NeuralTerminal;
