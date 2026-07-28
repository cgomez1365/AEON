/**
 * AEON Terminal 2.0 — the window, not the switchboard.
 *
 * The terminal knows exactly three verbs (sigil router):
 *   bare text → POST /api/chat/stream   (LLM, role from settings)
 *   /command  → POST /api/commands/dispatch (manifest-discovered registry)
 *   > shell   → POST /api/os/shell      (raw OS, allowlist-gated server-side)
 *
 * Everything else lives in block manifests and the kernel:
 *   - command palette populated from GET /api/commands + client UI commands
 *   - confirmation gates arrive as 428 responses; rendered as inline
 *     firewall-intercept cards ([Y] execute / [N] deny)
 *   - every execution is an event chip: [0042] CMD /gpu … RUNNING → EXIT 0
 *   - failures stay in the transcript (failure-as-narrative, no toasts);
 *     provider fallbacks arrive as SSE `warning` events
 *
 * No hardcoded block logic, no provider keys, no environment checks.
 */
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Send, Loader, Cpu, Clock, Zap, ChevronRight, ChevronDown, ShieldAlert, Paperclip, X as XIcon } from 'lucide-react';

// UI-only commands — act on the terminal or app itself, never the server.
// Block commands come from GET /api/commands (manifest-discovered); add nothing here.
const UI_COMMANDS = [
  { cmd: '/clear', desc: 'Clear the terminal history' },
  { cmd: '/help',  desc: 'List every available command' },
  { cmd: '/open',  desc: 'Open any block by name — /open matrix' },
  { cmd: '/model', desc: 'Open the model hotswap picker' },
];

let PID = 0;
const nextPid = () => String(++PID).padStart(4, '0');

// ── Event chip: one execution rendered as a process line ──────────────
function EventChip({ ev, onToggle }) {
  const color = ev.status === 'running' ? '#00f2ff' : ev.status === 'ok' ? '#39ff14' : '#ff4455';
  const statusText = ev.status === 'running' ? 'RUNNING' : ev.status === 'ok' ? `EXIT 0${ev.latencyMs ? ` · ${ev.latencyMs}ms` : ''}` : 'EXIT 1';
  return (
    <div style={{ borderTop: `1px solid ${color}33`, borderRight: `1px solid ${color}33`, borderBottom: `1px solid ${color}33`, borderLeft: `3px solid ${color}`, borderRadius: 3, margin: '4px 0', background: 'rgba(10,16,26,0.6)' }}>
      <div onClick={onToggle} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px', cursor: 'pointer', fontSize: 11 }}>
        {ev.expanded ? <ChevronDown size={11} color={color} /> : <ChevronRight size={11} color={color} />}
        <span style={{ color: '#4a5568' }}>[{ev.pid}]</span>
        <span style={{ color, letterSpacing: '0.08em' }}>{ev.kind}</span>
        <span style={{ color: '#c8d6e8', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.label}</span>
        {ev.status === 'running' && <Loader size={11} color={color} className="spin" />}
        <span style={{ color, fontSize: 10 }}>{statusText}</span>
      </div>
      {ev.expanded && (
        <div style={{ padding: '6px 12px 8px 30px', fontSize: 11, color: '#8aa0b8', borderTop: `1px solid ${color}22`, whiteSpace: 'pre-wrap', maxHeight: 260, overflowY: 'auto' }}>
          {ev.output || '(no output)'}
        </div>
      )}
    </div>
  );
}

// ── Firewall intercept: inline confirmation for dangerous commands ────
function InterceptCard({ prompt, onAllow, onDeny }) {
  return (
    <div style={{ border: '1px solid #f59e0b', borderRadius: 3, margin: '6px 0', padding: '10px 14px', background: 'rgba(245,158,11,0.07)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#f59e0b', fontSize: 11, letterSpacing: '0.1em', marginBottom: 6 }}>
        <ShieldAlert size={13} /> FIREWALL INTERCEPT
      </div>
      <div style={{ fontSize: 12, color: '#c8d6e8', marginBottom: 10, fontFamily: 'monospace' }}>{prompt}</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={onAllow} style={{ background: 'rgba(57,255,20,0.12)', border: '1px solid #39ff14', color: '#39ff14', padding: '3px 14px', borderRadius: 2, cursor: 'pointer', fontSize: 11, fontFamily: 'inherit' }}>[Y] EXECUTE</button>
        <button onClick={onDeny} style={{ background: 'rgba(255,68,85,0.1)', border: '1px solid #ff4455', color: '#ff4455', padding: '3px 14px', borderRadius: 2, cursor: 'pointer', fontSize: 11, fontFamily: 'inherit' }}>[N] DENY</button>
      </div>
    </div>
  );
}

const Terminal2 = ({ onUsageUpdate }) => {
  const [input, setInput] = useState('');
  const [pendingImage, setPendingImage] = useState(null); // { dataUri, name }
  const fileInputRef = useRef(null);
  const [feed, setFeed] = useState([{ id: 0, type: 'msg', role: 'system', content: 'AEON TERMINAL 2.0 — link established. Type / for commands, > for shell.' }]);
  const [isLoading, setIsLoading] = useState(false);
  const [commands, setCommands] = useState([]);
  const [showPalette, setShowPalette] = useState(false);
  const [paletteFilter, setPaletteFilter] = useState('');
  const scrollRef = useRef();
  const feedId = useRef(1);

  const push = useCallback((entry) => {
    const id = feedId.current++;
    setFeed(prev => [...prev, { id, ...entry }]);
    return id;
  }, []);
  const patch = useCallback((id, updates) => {
    setFeed(prev => prev.map(e => e.id === id ? { ...e, ...(typeof updates === 'function' ? updates(e) : updates) } : e));
  }, []);

  // ── Boot: pull the command registry from the kernel ──
  useEffect(() => {
    fetch('/api/commands').then(r => r.json())
      .then(d => setCommands([...UI_COMMANDS, ...(d.commands || []).filter(c => c.available !== false)]))
      .catch(() => setCommands([...UI_COMMANDS]));
  }, []);

  // ── Model hotswap: providers grouped by key availability ──
  const [modelGroups, setModelGroups] = useState([]);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const refreshModelGroups = () => fetch('/api/god/models').then(r => r.json()).then(d => setModelGroups(d.groups || [])).catch(() => {});
  // Lazy-load: fetch fresh data each time the picker opens so /addkey changes appear immediately.
  useEffect(() => { if (showModelPicker) refreshModelGroups(); }, [showModelPicker]);

  const hotswapModel = async (provider, model) => {
    setShowModelPicker(false);
    if (!model) return;
    try {
      const res = await fetch('/api/god/model-swap', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'chat', provider, model }),
      });
      const d = await res.json();
      push({ type: 'msg', role: d.ok ? 'system' : 'error', content: d.message || d.error || `chat → ${provider}/${model}` });
    } catch (e) { push({ type: 'msg', role: 'error', content: `[HOTSWAP] ${e.message}` }); }
  };

  // ── Drag & drop → vault placement recommendation ──
  const [dragOver, setDragOver] = useState(false);
  const onDrop = async (e) => {
    e.preventDefault(); setDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) { push({ type: 'msg', role: 'error', content: `[DROP] ${file.name} is over 25MB — use the Files block for large files.` }); return; }
    push({ type: 'msg', role: 'system', content: `📥 Reading ${file.name}… asking where it belongs in your Vault.` });
    const buf = await file.arrayBuffer();
    let binary = ''; const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    const b64 = btoa(binary);
    try {
      const res = await fetch('/api/god/file-drop', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, content: b64, encoding: 'base64' }),
      });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error || 'drop failed');
      push({ type: 'filedrop', name: file.name, content: b64, recommendation: d.recommendation, folders: d.folders || [] });
    } catch (err) { push({ type: 'msg', role: 'error', content: `[DROP] ${err.message}` }); }
  };

  const saveDrop = async (entry, folder) => {
    setFeed(prev => prev.filter(e => e.id !== entry.id));
    try {
      const res = await fetch('/api/god/file-save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: entry.name, content: entry.content, folder, encoding: 'base64' }),
      });
      const d = await res.json();
      push({ type: 'msg', role: d.ok ? 'system' : 'error', content: d.text || d.error });
    } catch (e) { push({ type: 'msg', role: 'error', content: `[VAULT] ${e.message}` }); }
  };

  useEffect(() => { scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight); }, [feed]);

  // ── Sigil detection (live intent indicator) ──
  const sigil = input.startsWith('>') ? 'shell' : input.startsWith('/') ? 'cmd' : 'chat';
  const sigilGlyph = { chat: '◇', cmd: '/', shell: '>' }[sigil];
  const sigilColor = { chat: '#00f2ff', cmd: '#39ff14', shell: '#f59e0b' }[sigil];

  useEffect(() => {
    if (input.startsWith('/')) { setShowPalette(true); setPaletteFilter(input.toLowerCase()); }
    else setShowPalette(false);
  }, [input]);

  const filteredCommands = useMemo(() =>
    commands.filter(c => c.cmd.startsWith(paletteFilter) || paletteFilter === '/'),
    [commands, paletteFilter]);

  // ── Image attach → vision two-hop ──
  // The chat model can't see images; the Settings "vision" role reads the
  // attachment first (kernel route, provider-agnostic) and its description
  // is folded into the prompt — the chat pipeline stays untouched.
  const onFileSelected = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setPendingImage({ dataUri: reader.result, name: file.name });
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const resolveImageContext = async (query) => {
    if (!pendingImage) return '';
    const img = pendingImage;
    setPendingImage(null);
    push({ type: 'msg', role: 'system', content: `👁 Reading ${img.name}…` });
    try {
      const res = await fetch('/api/ai/vision', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: img.dataUri,
          prompt: query
            ? `The user is asking: "${query}". Describe this image with that question in mind — focus on whatever is relevant (error messages, UI elements, text, layout).`
            : 'Describe this image in detail — any text, UI elements, error messages, layout, and colors.',
        }),
      });
      let data = null;
      try { data = await res.json(); } catch { /* empty/non-JSON body — e.g. backend unreachable */ }
      if (res.ok && data?.text) return `\n\n[Attached image "${img.name}" — vision analysis]: ${data.text}`;
      if (!res.ok) {
        push({ type: 'msg', role: 'error', content: `[VISION] Server unreachable or errored (${res.status || 'no response'}). Is the AEON backend running?` });
      } else {
        push({ type: 'msg', role: 'error', content: `[VISION] ${data?.error || 'Could not read the image.'}` });
      }
    } catch (e) {
      push({ type: 'msg', role: 'error', content: `[VISION] ${e.message}` });
    }
    return '';
  };

  // ── Verb 1: chat (SSE stream) ──
  const runChat = async (text) => {
    const msgId = push({ type: 'msg', role: 'assistant', content: '', streaming: true });
    let streamed = '';
    let meta = {};
    try {
      const res = await fetch('/api/chat/stream', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, role: 'chat', history: feed.filter(e => e.type === 'msg' && (e.role === 'user' || e.role === 'assistant')).slice(-20).map(e => ({ role: e.role, content: e.content })) }),
      });
      if (!res.ok || !res.body) throw new Error(`chat/stream ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].startsWith('event: ')) continue;
          const eventType = lines[i].slice(7).trim();
          const dataLine = lines[i + 1];
          if (!dataLine?.startsWith('data: ')) continue;
          try {
            const payload = JSON.parse(dataLine.slice(6));
            if (eventType === 'token') { streamed += payload.t; patch(msgId, { content: streamed }); }
            else if (eventType === 'meta') {
              // Fallback narrative: show degradation inline, strikethrough style
              if (payload.fallbackFrom && meta.provider) {
                push({ type: 'msg', role: 'system', content: `~~${meta.provider}~~ → ${payload.provider} (${payload.fallbackFrom})` });
              }
              meta = { ...meta, ...payload };
            }
            else if (eventType === 'warning') push({ type: 'msg', role: 'warning', content: payload.message });
            else if (eventType === 'done') { streamed = payload.text || streamed; meta = { ...meta, ...payload }; }
            else if (eventType === 'error') throw new Error(payload.error);
          } catch (pe) { if (pe.message && !pe.message.includes('JSON')) throw pe; }
        }
      }
      patch(msgId, { content: streamed, streaming: false, meta });
      onUsageUpdate?.({ tokens: meta.tokens || 0, latencyMs: meta.latencyMs || 0 });
    } catch (e) {
      patch(msgId, { role: 'error', content: `[NEURAL LINK] ${e.message}`, streaming: false });
    }
  };

  // ── Verb 2: registry command ──
  const runCommand = async (text, confirmed = false) => {
    const [cmdToken, ...rest] = text.split(/\s+/);
    const arg = rest.join(' ');

    // UI-only commands short-circuit
    if (cmdToken === '/clear') { setFeed([]); return; }
    if (cmdToken === '/help') {
      push({ type: 'msg', role: 'system', content: commands.map(c => `${c.cmd} — ${c.desc || c.title || ''}`).join('\n') });
      return;
    }

    // UI-only commands — handled client-side, no server round-trip.
    if (cmdToken === '/model') { setShowModelPicker(v => !v); return; }
    if (cmdToken === '/open') {
      try {
        const d = await fetch('/api/god/blocks').then(r => r.json());
        const q = arg.toLowerCase().trim();
        if (!q) {
          push({ type: 'msg', role: 'system', content: (d.blocks || []).filter(b => !b.hidden).map(b => `${b.icon} ${b.label} — /open ${b.id}`).join('\n') });
          return;
        }
        const hit = (d.blocks || []).find(b => b.id.toLowerCase() === q)
          || (d.blocks || []).find(b => b.label.toLowerCase().includes(q) || b.id.toLowerCase().includes(q));
        if (!hit) { push({ type: 'msg', role: 'error', content: `No block matches "${arg}". Type /open to list all blocks.` }); return; }
        push({ type: 'msg', role: 'system', content: `Opening ${hit.icon} ${hit.label}…` });
        window.location.assign(hit.route);
      } catch (e) { push({ type: 'msg', role: 'error', content: `[OPEN] ${e.message}` }); }
      return;
    }

    // Everything else → command bus (manifest-discovered, block-owned).
    const pid = nextPid();
    const t0 = Date.now();
    const chipId = push({ type: 'chip', pid, kind: 'CMD', label: text, status: 'running', expanded: false });
    try {
      const res = await fetch('/api/commands/dispatch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: cmdToken, arg, confirmed }),
      });
      const data = await res.json().catch(() => ({}));

      // Central confirmation gate → firewall intercept card
      if (res.status === 428 && data.requiresConfirmation) {
        patch(chipId, { status: 'ok', label: `${text} (awaiting approval)` });
        push({ type: 'intercept', prompt: data.prompt, command: text });
        return;
      }

      const output = data.text || (data.data ? '```json\n' + JSON.stringify(data.data, null, 2) + '\n```' : data.error || '(empty)');
      patch(chipId, { status: data.ok ? 'ok' : 'fail', output, latencyMs: Date.now() - t0, expanded: !data.ok });
      if (data.ok && data.text) push({ type: 'msg', role: 'assistant', content: data.text, meta: { model: data.meta?.block, provider: 'Block Command', latencyMs: Date.now() - t0 } });
    } catch (e) {
      patch(chipId, { status: 'fail', output: e.message, expanded: true });
    }
  };

  // ── Verb 3: shell ──
  const runShell = async (text) => {
    const cmd = text.slice(1).trim();
    const pid = nextPid();
    const t0 = Date.now();
    const chipId = push({ type: 'chip', pid, kind: 'SHELL', label: cmd, status: 'running', expanded: true });
    try {
      const res = await fetch('/api/os/shell', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd }),
      });
      const data = await res.json().catch(() => ({}));
      const out = data.stdout || data.output || data.error || data.stderr || '(no output)';
      patch(chipId, { status: res.ok && !data.error ? 'ok' : 'fail', output: out, latencyMs: Date.now() - t0 });
    } catch (e) {
      patch(chipId, { status: 'fail', output: e.message });
    }
  };

  // ── The router — the terminal's entire brain ──
  const dispatch = async (raw) => {
    const text = raw.trim();
    if (!text) return;
    // Never echo raw API keys into the transcript
    const echo = text.startsWith('/addkey')
      ? text.replace(/(\/addkey\s+\S+\s+)(\S{4})\S+/, '$1$2••••••••')
      : text;
    push({ type: 'msg', role: 'user', content: echo });
    setInput('');
    setShowPalette(false);
    setIsLoading(true);
    try {
      if (text.startsWith('>')) await runShell(text);
      else if (text.startsWith('/')) await runCommand(text);
      else {
        const imageContext = await resolveImageContext(text);
        await runChat(text + imageContext);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const approveIntercept = (entry) => {
    setFeed(prev => prev.filter(e => e.id !== entry.id));
    setIsLoading(true);
    runCommand(entry.command, true).finally(() => setIsLoading(false));
  };
  const denyIntercept = (entry) => {
    patch(entry.id, { type: 'msg', role: 'system', content: `Denied: ${entry.command}` });
  };

  // ── Render ──
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: "'JetBrains Mono', monospace", background: '#080b10', color: '#c8d6e8', outline: dragOver ? '2px dashed #00f2ff' : 'none', outlineOffset: -4 }}>
      <style>{`.spin { animation: t2spin 1s linear infinite; } @keyframes t2spin { to { transform: rotate(360deg); } }`}</style>
      {dragOver && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,242,255,0.06)', color: '#00f2ff', fontSize: 13, zIndex: 5, pointerEvents: 'none', letterSpacing: '0.1em' }}>
          DROP FILE — AEON WILL RECOMMEND A VAULT LOCATION
        </div>
      )}

      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '12px 14px' }}>
        {feed.map(entry => {
          if (entry.type === 'chip') return <EventChip key={entry.id} ev={entry} onToggle={() => patch(entry.id, e => ({ expanded: !e.expanded }))} />;
          if (entry.type === 'intercept') return <InterceptCard key={entry.id} prompt={entry.prompt} onAllow={() => approveIntercept(entry)} onDeny={() => denyIntercept(entry)} />;
          if (entry.type === 'filedrop') return (
            <div key={entry.id} style={{ border: '1px solid #00f2ff', borderRadius: 3, margin: '6px 0', padding: '10px 14px', background: 'rgba(0,242,255,0.05)' }}>
              <div style={{ fontSize: 11, color: '#00f2ff', letterSpacing: '0.1em', marginBottom: 6 }}>📥 VAULT PLACEMENT — {entry.name}</div>
              <div style={{ fontSize: 12, color: '#c8d6e8', marginBottom: 8 }}>
                Recommended: <b style={{ color: '#39ff14' }}>{entry.recommendation?.folder}</b>
                {entry.recommendation?.reason ? ` — ${entry.recommendation.reason}` : ''}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <button onClick={() => saveDrop(entry, entry.recommendation?.folder)}
                  style={{ background: 'rgba(57,255,20,0.12)', border: '1px solid #39ff14', color: '#39ff14', padding: '3px 14px', borderRadius: 2, cursor: 'pointer', fontSize: 11, fontFamily: 'inherit' }}>
                  [Y] SAVE THERE
                </button>
                <select aria-label="Choose a different vault folder" defaultValue=""
                  onChange={(e) => e.target.value && saveDrop(entry, e.target.value)}
                  style={{ background: '#0b0f19', color: '#c8d6e8', border: '1px solid #1e2d45', borderRadius: 2, fontSize: 11, padding: '3px 6px', fontFamily: 'inherit' }}>
                  <option value="" disabled>…or pick a folder</option>
                  {entry.folders.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
                <button onClick={() => setFeed(prev => prev.filter(e2 => e2.id !== entry.id))}
                  style={{ background: 'rgba(255,68,85,0.1)', border: '1px solid #ff4455', color: '#ff4455', padding: '3px 14px', borderRadius: 2, cursor: 'pointer', fontSize: 11, fontFamily: 'inherit' }}>
                  [N] CANCEL
                </button>
              </div>
            </div>
          );
          const roleColor = { user: '#e8f0fa', assistant: '#c8d6e8', system: '#5a6a80', warning: '#f59e0b', error: '#ff4455' }[entry.role] || '#c8d6e8';
          const roleTag = { user: 'USER', assistant: 'CORE', system: 'SYS', warning: 'WARN', error: 'ERROR' }[entry.role];
          return (
            <div key={entry.id} style={{ margin: '8px 0', fontSize: 12.5 }}>
              <span style={{ fontSize: 9, letterSpacing: '0.12em', color: roleColor, border: `1px solid ${roleColor}44`, borderRadius: 2, padding: '1px 6px', marginRight: 8 }}>{roleTag}</span>
              <div style={{ display: 'inline-block', verticalAlign: 'top', maxWidth: 'calc(100% - 60px)', color: roleColor }}>
                {entry.role === 'assistant'
                  ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.content || (entry.streaming ? '▮' : '')}</ReactMarkdown>
                  : <span style={{ whiteSpace: 'pre-wrap' }}>{entry.content}</span>}
                {entry.meta?.model && (
                  <div style={{ display: 'flex', gap: 10, marginTop: 3, fontSize: 9.5, color: '#4a5568' }}>
                    <span><Cpu size={9} style={{ verticalAlign: -1 }} /> {entry.meta.model}</span>
                    {entry.meta.latencyMs != null && <span><Clock size={9} style={{ verticalAlign: -1 }} /> {entry.meta.latencyMs}ms</span>}
                    {entry.meta.tokens != null && <span><Zap size={9} style={{ verticalAlign: -1 }} /> {entry.meta.tokens} tok</span>}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {showPalette && filteredCommands.length > 0 && (
        <div style={{ maxHeight: 180, overflowY: 'auto', borderTop: '1px solid #1e2d45', background: 'rgba(10,15,25,0.97)', padding: '6px 0' }}>
          {filteredCommands.map(c => (
            <div key={c.id || c.cmd} onClick={() => setInput(c.cmd + ' ')}
              style={{ padding: '3px 16px', fontSize: 11.5, cursor: 'pointer', display: 'flex', gap: 10 }}
              onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,242,255,0.07)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
              <span style={{ color: '#39ff14', minWidth: 90 }}>{c.cmd}</span>
              <span style={{ color: '#5a6a80', flex: 1 }}>{c.desc || c.title}</span>
              {c.dangerous && <ShieldAlert size={11} color="#f59e0b" />}
              {c.blockLabel && <span style={{ color: '#4a5568', fontSize: 9.5 }}>{c.blockLabel}</span>}
            </div>
          ))}
        </div>
      )}

      {pendingImage && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 14px', borderTop: '1px solid #1e2d45', fontSize: 11, color: '#00f2ff' }}>
          <Paperclip size={11} /> {pendingImage.name}
          <XIcon size={12} style={{ cursor: 'pointer', color: '#ff4455' }} onClick={() => setPendingImage(null)} />
        </div>
      )}
      {showModelPicker && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px', borderTop: '1px solid #1e2d45', fontSize: 11 }}>
          <Cpu size={12} color="#00f2ff" />
          <span style={{ color: '#5a6a80' }}>HOTSWAP CHAT MODEL</span>
          <select aria-label="Hotswap chat model" defaultValue=""
            onChange={(e) => {
              const [provider, ...m] = e.target.value.split('::');
              hotswapModel(provider, m.join('::'));
            }}
            style={{ flex: 1, maxWidth: 420, background: '#0b0f19', color: '#c8d6e8', border: '1px solid #1e2d45', borderRadius: 2, fontSize: 11, padding: '4px 6px', fontFamily: 'inherit' }}>
            <option value="" disabled>Pick a model (grouped by key availability)…</option>
            {modelGroups.map(g => (
              <optgroup key={g.provider} label={`${g.label || g.provider} ${g.hasKey ? '· ✓ key ready' : '· ✗ no key — /addkey ' + g.provider}`}>
                {(g.models.length ? g.models : ['(no models listed)']).map(m => (
                  <option key={g.provider + m} value={`${g.provider}::${m}`} disabled={!g.hasKey || m === '(no models listed)'}>{m}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <XIcon size={12} style={{ cursor: 'pointer', color: '#ff4455' }} onClick={() => setShowModelPicker(false)} aria-label="Close model picker" />
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderTop: '1px solid #1e2d45' }}>
        <span style={{ color: sigilColor, fontSize: 14, width: 14, textAlign: 'center', textShadow: `0 0 8px ${sigilColor}` }}>{sigilGlyph}</span>
        <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onFileSelected} />
        <Paperclip size={14} style={{ cursor: 'pointer', color: pendingImage ? '#00f2ff' : '#4a5568', flexShrink: 0 }} onClick={() => fileInputRef.current?.click()} />
        <Cpu size={14} aria-label="Hotswap model" style={{ cursor: 'pointer', color: showModelPicker ? '#00f2ff' : '#4a5568', flexShrink: 0 }} onClick={() => setShowModelPicker(v => !v)} />
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !isLoading) dispatch(input); }}
          placeholder="Ask, /command, or > shell…"
          style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: '#e8f0fa', fontFamily: 'inherit', fontSize: 13 }}
        />
        <button onClick={() => !isLoading && dispatch(input)} disabled={isLoading}
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: sigilColor }}>
          {isLoading ? <Loader size={15} className="spin" /> : <Send size={15} />}
        </button>
      </div>
    </div>
  );
};

export default Terminal2;
