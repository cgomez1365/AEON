/**
 * Memory Core — the operator's agents and what each one remembers.
 *
 * Tabs: "All agents" is the SHARED memory (Vault/Agents/Aeon/memory) every
 * agent reads; each agent has a tab for its OWN memory
 * (Vault/Agents/<Folder>/memory). List / filter / pin / edit / delete /
 * distill, as before — plus a manual switch on every memory: off keeps it
 * saved and searchable but never sends it to a model, which is how a store
 * that outgrows the context window stays fast. Every memory is also a vault
 * file, visible in Aeon Matrix.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { Brain, Pin, Trash2, Plus, Sparkles, RefreshCw, Pencil, Check, X, Bot, Users, Settings2, Terminal, Lock } from 'lucide-react';
import { AGENT_SELECT_EVENT } from '../../utils/terminalAgent.js';

// Two independent dimensions, not one list split in half — the API stores
// both on every record (see api/memory.cjs): CATS says what a memory is
// ABOUT, TYPES says what SHAPE it has, and a memory can carry one, both, or
// only a category.
//
// The filter bar has always offered all ten, while the add form offered only
// TYPES — so six of the ten filters could never match anything the operator
// created by hand. Every manual memory silently took the API's `category`
// default of "fact", which is why filtering by "identity" or "contact"
// returned nothing on a store the operator had filled themselves.
const TYPES = ['outline', 'algorithm', 'decision', 'milestone'];
const CATS = ['fact', 'identity', 'preference', 'contact', 'project', 'goal'];
const PROVIDERS = ['local', 'openrouter', 'groq', 'gemini', 'openai', 'claude', 'grok', 'lmstudio', 'custom'];
// Above this many tokens of switched-on memory, every turn carries a lot of
// reading before it can answer — said, not enforced.
const HEAVY_TOKENS = 3000;

// Visually hidden but screen-reader-visible label — used where the compact
// layout has no room for a rendered <label> next to an input/textarea.
const srOnly = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1,
  overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0,
};

const chip = (active) => ({
  padding: '3px 10px', borderRadius: 12, fontSize: 11, cursor: 'pointer',
  border: '1px solid ' + (active ? 'var(--accent, #00ff40)' : 'var(--border, #223)'),
  color: active ? 'var(--accent, #00ff40)' : 'var(--text-dim, #8aa)',
  background: 'transparent', userSelect: 'none', font: 'inherit', margin: 0,
});
const field = {
  background: 'transparent', border: '1px solid var(--border, #223)', borderRadius: 4,
  color: 'inherit', padding: '5px 8px', fontSize: 12, font: 'inherit', minWidth: 0,
};
const iconBtn = (color = 'var(--text-dim, #8aa)') => ({ background: 'none', border: 'none', cursor: 'pointer', color });

// The on/off switch on a memory. A real switch for assistive tech, small
// enough for a dense list.
function Switch({ on, onChange, label, disabled }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} title={label} disabled={disabled}
      onClick={onChange}
      style={{ width: 30, height: 16, borderRadius: 8, border: '1px solid ' + (on ? 'var(--accent, #00ff40)' : 'var(--border, #334)'),
        background: on ? 'rgba(0,255,64,0.18)' : 'transparent', position: 'relative', cursor: disabled ? 'default' : 'pointer', flexShrink: 0, padding: 0 }}>
      <span aria-hidden="true" style={{ position: 'absolute', top: 2, left: on ? 15 : 2, width: 10, height: 10, borderRadius: 5,
        background: on ? 'var(--accent, #00ff40)' : 'var(--text-dim, #667)', transition: 'left 0.12s' }} />
    </button>
  );
}

const talkTo = (a) => {
  try { window.dispatchEvent(new CustomEvent(AGENT_SELECT_EVENT, { detail: { id: a.id, name: a.name, self: !!a.self } })); } catch { /* no window */ }
};

// The server's cap (agentWorkspace.cjs SCRATCHPAD_MAX); the GET answers its
// own `max`, which wins. A save over it is refused, never cut.
const SCRATCHPAD_MAX = 2000;
const fmt = (n) => Number(n || 0).toLocaleString('en-US');

/**
 * An agent's scratchpad and handoffs (Vault/Agents/<Folder>/scratchpad.md and
 * handoffs/), in its settings panel. The scratchpad is editable here and by the
 * agent's own scratchpad tool; handoffs are read-only — the agent writes them
 * with /handoff, and nothing here deletes one.
 */
function AgentWorkspace({ agentId, name }) {
  const [pad, setPad] = useState(null);         // GET /scratchpad answer
  const [text, setText] = useState('');
  const [padError, setPadError] = useState('');
  const [padNote, setPadNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [handoffs, setHandoffs] = useState(null);  // GET /handoffs answer
  const [handoffError, setHandoffError] = useState('');
  const [openLatest, setOpenLatest] = useState(false);

  const base = `/api/agents/${encodeURIComponent(agentId)}`;
  const loadPad = useCallback(async () => {
    try {
      const r = await fetch(`${base}/scratchpad`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.ok === false) throw new Error(d.error || `the scratchpad did not load (server answered ${r.status})`);
      setPad(d); setText(d.content || ''); setPadError('');
    } catch (e) { setPad(null); setPadError(e.message); }
  }, [base]);
  const loadHandoffs = useCallback(async () => {
    try {
      const r = await fetch(`${base}/handoffs?limit=20`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.ok === false) throw new Error(d.error || `the handoffs did not load (server answered ${r.status})`);
      setHandoffs(d); setHandoffError('');
    } catch (e) { setHandoffs(null); setHandoffError(e.message); }
  }, [base]);
  useEffect(() => { loadPad(); loadHandoffs(); }, [loadPad, loadHandoffs]);

  const max = pad?.max || SCRATCHPAD_MAX;
  const over = text.length > max;
  const changed = pad != null && text !== (pad.content || '');
  const savePad = async () => {
    setSaving(true); setPadNote('');
    try {
      const r = await fetch(`${base}/scratchpad`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text }),
      });
      const d = await r.json().catch(() => ({}));
      // A 413 says the size in the server's own words; shown as written.
      if (!r.ok || d.ok === false) throw new Error(d.error || `not saved (server answered ${r.status})`);
      setPadError('');
      setPadNote(d.text || `scratchpad saved (${fmt(d.chars ?? text.length)} / ${fmt(d.max || max)} characters)`);
      await loadPad();
    } catch (e) { setPadError(e.message); }
    setSaving(false);
  };

  // Agents/<Folder>/ — read off the path the server answers, never guessed.
  const folder = pad?.path ? pad.path.replace(/\/scratchpad\.md$/, '') : null;
  const list = handoffs?.handoffs || [];
  const latest = handoffs?.latest || null;

  return (
    <div style={{ display: 'grid', gap: 10, borderTop: '1px solid var(--border, #223)', paddingTop: 10 }}>
      <label style={{ display: 'grid', gap: 3, fontSize: 11 }}>
        <span style={{ display: 'flex', gap: 8 }}>
          <span style={{ fontWeight: 600 }}>Scratchpad</span>
          <span style={{ marginLeft: 'auto', color: over ? 'var(--danger, #ff4466)' : 'var(--text-dim, #8aa)' }}>
            {fmt(text.length)} / {fmt(max)}
          </span>
        </span>
        <span style={{ color: 'var(--text-dim, #8aa)' }}>
          {name ? `${name}'s` : 'Your agent\'s'} own notes. It sees them every turn and can change them with its scratchpad tool.
          {' '}At most {fmt(max)} characters{folder ? ` — ${folder}/scratchpad.md` : ''}.
        </span>
        <textarea value={text} onChange={e => setText(e.target.value)} rows={5} disabled={pad == null}
          aria-label={`Scratchpad, at most ${fmt(max)} characters`}
          placeholder={pad == null ? '' : 'Empty. Notes written here are shown to the agent on every turn.'}
          style={{ ...field, fontFamily: 'inherit', resize: 'vertical' }} />
      </label>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 11 }}>
        <button type="button" onClick={savePad} disabled={saving || pad == null || over || !changed}
          title={over ? `Over the ${fmt(max)}-character limit — shorten it to save` : undefined}
          style={{ ...chip(changed && !over), display: 'flex', alignItems: 'center', gap: 4 }}>
          <Check size={12} /> save scratchpad
        </button>
        {over && <span style={{ color: 'var(--danger, #ff4466)' }}>{fmt(text.length - max)} characters over the limit — shorten it to save.</span>}
        {padNote && !over && <span role="status" style={{ color: 'var(--accent, #00ff40)' }}>{padNote}</span>}
      </div>
      {padError && <div role="alert" style={{ fontSize: 11, color: 'var(--danger, #ff4466)' }}>{padError}</div>}

      <div style={{ display: 'grid', gap: 4, fontSize: 11 }}>
        <span style={{ fontWeight: 600 }}>Handoffs</span>
        <span style={{ color: 'var(--text-dim, #8aa)' }}>
          Written by the agent with /handoff, or when you save a chat if that setting is on. The newest one is shown to it on every turn until it writes a newer one. Nothing is deleted;
          {' '}they live in {folder ? `${folder}/handoffs/` : 'the handoffs folder inside its folder under Agents'}.
        </span>
        {handoffError && <div role="alert" style={{ color: 'var(--danger, #ff4466)' }}>{handoffError}</div>}
        {handoffs && !list.length && (
          <span style={{ color: 'var(--text-dim, #8aa)' }}>None yet. In the terminal, talking to {name || 'this agent'}, type /handoff.</span>
        )}
        {list.map((h, i) => (
          <div key={h.path || h.at} style={{ border: '1px solid var(--border, #223)', borderRadius: 4, padding: '6px 8px' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span>{h.at ? new Date(h.at).toLocaleString() : h.path}</span>
              {i === 0 && <span style={{ color: 'var(--accent, #00ff40)' }}>newest — shown to the agent</span>}
              {i === 0 && latest?.text && (
                <button type="button" onClick={() => setOpenLatest(!openLatest)} aria-expanded={openLatest}
                  style={{ ...chip(false), marginLeft: 'auto' }}>{openLatest ? 'hide' : 'read in full'}</button>
              )}
            </div>
            <div style={{ color: 'var(--text-dim, #8aa)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', marginTop: 3 }}>
              {i === 0 && openLatest && latest?.text ? latest.text : h.preview}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function MemoryCore() {
  const [agents, setAgents] = useState([]);
  const [scope, setScope] = useState(null);           // null = shared; else an agent id
  const [memories, setMemories] = useState([]);
  const [summary, setSummary] = useState(null);
  const [filter, setFilter] = useState(null);
  const [q, setQ] = useState('');
  const [newText, setNewText] = useState('');
  const [newType, setNewType] = useState('');
  const [newCat, setNewCat] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState('');
  const [loadError, setLoadError] = useState('');
  const [agentForm, setAgentForm] = useState(null);   // { mode: 'new'|'edit', ...fields }

  const self = agents.find(a => a.self) || null;
  const current = scope ? agents.find(a => a.id === scope) || null : null;
  // Every memory route takes ?agent=; none is the shared store.
  const scoped = useCallback((url) => (scope ? `${url}${url.includes('?') ? '&' : '?'}agent=${encodeURIComponent(scope)}` : url), [scope]);

  const loadAgents = useCallback(async () => {
    try {
      const r = await fetch('/api/agents');
      const d = await r.json().catch(() => ({}));
      if (r.ok) setAgents(d.agents || []);
    } catch { /* the memory list says what failed */ }
  }, []);

  // A store the server cannot read answers 503 with the reason. Read as
  // `d.memories || []`, that rendered "0 MEMORIES · No memories match." —
  // the very lie the server now refuses to tell. A failed reload also drops
  // the list an earlier load showed: left up, it offered edit, pin and delete
  // on memories the server can no longer read, under the "not loaded" alert.
  const load = useCallback(async () => {
    const failed = (why) => { setMemories([]); setSummary(null); setLoadError(why); };
    try {
      const r = await fetch(scoped('/api/memory'));
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { failed(d.error || `the memory store did not load (server answered ${r.status})`); return; }
      setLoadError('');
      setMemories(d.memories || []);
      setSummary(d.summary || null);
    } catch (e) { failed(`the memory store did not load: ${e.message}`); }
  }, [scoped]);
  useEffect(() => { loadAgents(); }, [loadAgents]);
  useEffect(() => { load(); }, [load]);

  // `fn` may return the note to show — the server's own account of what
  // happened beats a fixed string.
  const act = async (fn, msg) => {
    setBusy(true);
    try {
      const said = await fn();
      const m = typeof said === 'string' ? said : msg;
      if (m) { setNote(m); setTimeout(() => setNote(''), 4000); }
      await load();
    }
    catch (e) { setNote('failed: ' + e.message); }
    setBusy(false);
  };

  // fetch() does not throw on a 4xx/5xx. Every action below used to report
  // "memory saved" / "deleted" / "memory updated" whatever the server said.
  const must = async (req) => {
    const r = await req;
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.ok === false) throw new Error(d.error || `server answered ${r.status}`);
    return d;
  };
  const post = (url, body) => fetch(scoped(url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

  const add = () => act(async () => {
    if (newText.trim().length < 6) throw new Error('too short');
    const d = await must(post('/api/memory/add', {
      text: newText.trim(),
      type: newType || null,
      // Omitted rather than sent empty, so the API's own "fact" default
      // applies when the operator did not choose.
      ...(newCat ? { category: newCat } : {}),
      source: 'operator',
    }));
    setNewText(''); setNewType(''); setNewCat('');
    // A repeat is not a save, and a reworded fact should say what was stored.
    if (d.deduped) return 'already in memory — nothing new saved';
    if (d.normalized) return `saved as: ${d.memory?.text}`;
    if (d.memory && d.memory.active === false) return 'memory saved, switched off (Settings: new memories start off)';
    return d.warning ? `memory saved — ${d.warning}` : 'memory saved';
  }, 'memory saved');

  const pin = (id) => act(() => must(post(`/api/memory/${id}/pin`)));
  const del = (id) => act(() => must(fetch(scoped(`/api/memory/${id}`), { method: 'DELETE' })), 'deleted');
  const toggle = (m) => act(() => must(post(`/api/memory/${m.id}/active`, { active: !m.active })),
    m.active ? 'switched off — kept, not sent to a model or recalled' : 'switched on');
  // On or off for everything the filter shows (or the whole store).
  const bulk = (active) => act(async () => {
    const ids = shown.map(m => m.id);
    const d = await must(post('/api/memory/active', filter || q ? { ids, active } : { all: true, active }));
    return `${d.changed} ${d.changed === 1 ? 'memory' : 'memories'} switched ${active ? 'on' : 'off'}`;
  });

  const startEdit = (m) => { setEditingId(m.id); setEditText(m.text); };
  const cancelEdit = () => { setEditingId(null); setEditText(''); };
  const saveEdit = (id) => act(async () => {
    if (editText.trim().length < 6) throw new Error('too short');
    await must(fetch(scoped(`/api/memory/${id}`), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: editText.trim() }),
    }));
    setEditingId(null); setEditText('');
  }, 'memory updated');
  const distill = () => act(async () => {
    const r = await post('/api/memory/distill');
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    // A repeat is refused, not searched: "nothing durable found" here was
    // also what a chat that had already yielded five memories showed.
    if (d.alreadyDistilled) { setNote(d.message || 'already distilled — nothing new since'); return; }
    // Set directly (not returned to act) so it stays until the next action,
    // and so an empty run can never read as a success.
    const n = d.added?.length || 0;
    const from = d.session ? ` from "${d.session}"` : '';
    setNote(n
      ? `distilled ${n} new ${n === 1 ? 'memory' : 'memories'}${from}`
      : `nothing durable found${from} — ${d.candidates || 0} candidates, none new`);
  });

  // ── Agents ──────────────────────────────────────────────────────────
  const openNew = () => setAgentForm({ mode: 'new', name: '', persona: '', provider: '', model: '', privacy: 'roulette', sharedMemory: true, capture: false });
  const openEdit = (a) => setAgentForm({
    mode: 'edit', id: a.id, self: a.self, name: a.name, persona: a.persona || '',
    provider: a.model?.provider || '', model: a.model?.model || '', privacy: a.privacy || 'roulette',
    sharedMemory: a.sharedMemory !== false, capture: !!a.capture,
  });
  const saveAgent = () => act(async () => {
    const f = agentForm;
    const body = {
      name: f.name, persona: f.persona, privacy: f.privacy,
      model: f.provider ? { provider: f.provider, model: f.model || null } : null,
      ...(f.self ? {} : { sharedMemory: f.sharedMemory, capture: f.capture }),
    };
    const d = await must(fetch(f.mode === 'new' ? '/api/agents' : `/api/agents/${encodeURIComponent(f.id)}`, {
      method: f.mode === 'new' ? 'POST' : 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }));
    await loadAgents();
    setAgentForm(null);
    if (f.mode === 'new' && d.agent) setScope(d.agent.id);
    return d.text || `${d.agent?.name || 'agent'} saved`;
  });
  const removeAgent = (a) => {
    if (!window.confirm(`Remove ${a.name}? Its memory and chats move to Vault/Agents/.removed — nothing is deleted.`)) return;
    act(async () => {
      const d = await must(fetch(`/api/agents/${encodeURIComponent(a.id)}`, { method: 'DELETE' }));
      setScope(null); setAgentForm(null);
      await loadAgents();
      return d.text;
    });
  };

  const shown = memories.filter(m => {
    if (filter && m.type !== filter && m.category !== filter) return false;
    // Every word, in any order — the same rule as /memory in the terminal.
    if (q) {
      const hay = (m.text + ' ' + (m.title || '')).toLowerCase();
      if (!q.toLowerCase().split(/\s+/).filter(Boolean).every(w => hay.includes(w))) return false;
    }
    return true;
  });
  const others = agents.filter(a => !a.self);
  const who = current ? current.name : (self?.name || 'AEON');

  return (
    <div style={{ padding: 24, maxWidth: 980 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
        <Brain size={20} style={{ color: 'var(--accent, #00ff40)' }} />
        <h2 style={{ margin: 0, fontSize: 18 }}>Memory Core</h2>
        <span style={{ fontSize: 11, color: 'var(--text-dim, #8aa)', border: '1px solid var(--border, #223)', padding: '2px 8px', borderRadius: 4 }}>
          {loadError ? 'NOT LOADED' : `${memories.length} MEMORIES · ${summary ? summary.active : memories.length} ON · ${memories.filter(m => m.pinned).length} PINNED`}
        </span>
        <button type="button" onClick={() => { loadAgents(); load(); }} title="refresh" aria-label="Refresh memories"
          style={{ ...chip(false), marginLeft: 'auto' }}><RefreshCw size={11} /></button>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-dim, #8aa)', marginBottom: 14 }}>
        <b>All agents</b> is the shared memory every agent reads. Each agent also has its own. Switch a memory off to keep it
        without sending it to a model or recalling it — the fewer switched on, the faster every chat. Each memory is a vault file.
      </div>

      {/* Agent tabs */}
      <div role="tablist" aria-label="Whose memory" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
        <button type="button" role="tab" aria-selected={!scope} onClick={() => { setScope(null); setAgentForm(null); }}
          style={{ ...chip(!scope), display: 'flex', alignItems: 'center', gap: 4 }}>
          <Users size={11} /> All agents
        </button>
        {others.map(a => (
          <button type="button" role="tab" key={a.id} aria-selected={scope === a.id} onClick={() => { setScope(a.id); setAgentForm(null); }}
            style={{ ...chip(scope === a.id), display: 'flex', alignItems: 'center', gap: 4 }}>
            <Bot size={11} /> {a.name}{a.privacy === 'local-only' && <Lock size={9} aria-label="local only" />}
          </button>
        ))}
        <button type="button" onClick={openNew} style={{ ...chip(false), display: 'flex', alignItems: 'center', gap: 4 }}>
          <Plus size={11} /> New agent
        </button>
      </div>

      {/* The selected agent (or your own AEON on the shared tab) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12, marginBottom: 12, padding: '8px 10px', border: '1px solid var(--border, #223)', borderRadius: 6 }}>
        <span style={{ fontWeight: 600 }}>{current ? current.name : `${who} — your AEON (shared memory)`}</span>
        {(current || self) && (
          <span style={{ color: 'var(--text-dim, #8aa)', fontSize: 11 }}>
            {(current || self).model?.provider ? `${(current || self).model.provider}${(current || self).model.model ? ` · ${(current || self).model.model}` : ''}` : 'model: Settings decides'}
            {(current || self).privacy === 'local-only' ? ' · local only' : ' · roulette'}
            {current && current.sharedMemory === false ? ' · own memory only' : ''}
            {current?.capture ? ' · captures memories' : ''}
          </span>
        )}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {(current || self) && (
            <button type="button" onClick={() => talkTo(current || self)} style={{ ...chip(false), display: 'flex', alignItems: 'center', gap: 4 }}
              title="Load this agent into the Neural Terminal">
              <Terminal size={11} /> talk in terminal
            </button>
          )}
          {(current || self) && (
            <button type="button" onClick={() => openEdit(current || self)} style={{ ...chip(false), display: 'flex', alignItems: 'center', gap: 4 }}>
              <Settings2 size={11} /> {current ? 'agent settings' : 'name your AEON'}
            </button>
          )}
        </span>
      </div>

      {agentForm && (
        <div style={{ border: '1px solid var(--accent, #00ff40)', borderRadius: 6, padding: 12, marginBottom: 14, display: 'grid', gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>
            {agentForm.mode === 'new' ? 'New agent' : agentForm.self ? 'Your AEON' : `${agentForm.name} — settings`}
          </div>
          <label style={{ display: 'grid', gap: 3, fontSize: 11 }}>Name — what you say to call it ("{(agentForm.name || 'name').toLowerCase()} come online")
            <input value={agentForm.name} onChange={e => setAgentForm({ ...agentForm, name: e.target.value })} maxLength={32} style={field} />
          </label>
          <label style={{ display: 'grid', gap: 3, fontSize: 11 }}>Persona — who it is and what it does (sent with every message to it)
            <textarea value={agentForm.persona} onChange={e => setAgentForm({ ...agentForm, persona: e.target.value })} rows={3}
              placeholder="e.g. Answers bookkeeping questions from my Vault and drafts a short month-end summary."
              style={{ ...field, fontFamily: 'inherit', resize: 'vertical' }} />
          </label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <label style={{ display: 'grid', gap: 3, fontSize: 11, flex: '1 1 160px' }}>Model provider
              <select value={agentForm.provider} onChange={e => setAgentForm({ ...agentForm, provider: e.target.value })} style={field}>
                <option value="">Settings decides (roulette applies)</option>
                {PROVIDERS.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <label style={{ display: 'grid', gap: 3, fontSize: 11, flex: '2 1 220px' }}>Model (blank: the provider's default)
              <input value={agentForm.model} onChange={e => setAgentForm({ ...agentForm, model: e.target.value })} disabled={!agentForm.provider}
                placeholder={agentForm.provider === 'local' ? 'e.g. phi4-mini-q4' : 'e.g. openai/gpt-oss-120b'} style={field} />
            </label>
            <label style={{ display: 'grid', gap: 3, fontSize: 11, flex: '1 1 200px' }}>Privacy
              <select value={agentForm.privacy} onChange={e => setAgentForm({ ...agentForm, privacy: e.target.value })} style={field}>
                <option value="roulette">Roulette — any configured provider, failover on</option>
                <option value="local-only">{agentForm.self
                  ? 'Local only — its chats never go to a cloud model'
                  : 'Local only — its chats and its own memory never go to a cloud model'}</option>
              </select>
            </label>
          </div>
          {agentForm.self && agentForm.privacy === 'local-only' && (
            <div style={{ fontSize: 11, color: 'var(--text-dim, #8aa)' }}>
              Your AEON's memory is the shared memory: it stays out of the Second Brain index and recall, and
              an agent set to Roulette does not get the shared memory in its prompt (an agent set to Local only still does).
            </div>
          )}
          {!agentForm.self && (
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 11 }}>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={agentForm.sharedMemory} onChange={e => setAgentForm({ ...agentForm, sharedMemory: e.target.checked })} />
                Reads the shared memory too
              </label>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={agentForm.capture} onChange={e => setAgentForm({ ...agentForm, capture: e.target.checked })} />
                Captures memories from its chats automatically
              </label>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" onClick={saveAgent} disabled={busy || !agentForm.name.trim()} style={{ ...chip(true), display: 'flex', alignItems: 'center', gap: 4 }}>
              <Check size={12} /> {agentForm.mode === 'new' ? 'create agent' : 'save'}
            </button>
            <button type="button" onClick={() => setAgentForm(null)} style={chip(false)}>cancel</button>
            {agentForm.mode === 'edit' && !agentForm.self && (
              <button type="button" onClick={() => removeAgent(current)} style={{ ...chip(false), marginLeft: 'auto', color: 'var(--danger, #ff4466)' }}>
                remove agent
              </button>
            )}
          </div>
          {agentForm.mode === 'edit' && agentForm.id && (
            <AgentWorkspace key={agentForm.id} agentId={agentForm.id} name={agentForm.name} />
          )}
        </div>
      )}

      {loadError && <div role="alert" style={{ fontSize: 12, color: 'var(--danger, #ff4466)', marginBottom: 8 }}>{loadError}</div>}
      {note && <div role="status" style={{ fontSize: 12, color: 'var(--accent, #00ff40)', marginBottom: 8 }}>{note}</div>}

      {/* What the switches add up to */}
      {summary && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 11, color: 'var(--text-dim, #8aa)', marginBottom: 10 }}>
          <span>
            ~{summary.activeTokens.toLocaleString()} tokens of memory read on every turn{current && current.sharedMemory !== false ? ' (plus the shared memory)' : ''}
            {' '}· {summary.active} on · {summary.inactive} off
          </span>
          {summary.activeTokens > HEAVY_TOKENS && (
            <span style={{ color: '#ffaa00' }}>— heavy: switch off what {who} does not need; small local models slow down and lose the thread</span>
          )}
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button type="button" onClick={() => bulk(true)} disabled={busy || !shown.length} style={chip(false)}>{filter || q ? 'shown on' : 'all on'}</button>
            <button type="button" onClick={() => bulk(false)} disabled={busy || !shown.length} style={chip(false)}>{filter || q ? 'shown off' : 'all off'}</button>
          </span>
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }} role="group" aria-label="Filter memories by type or category">
        <button type="button" style={chip(!filter)} aria-pressed={!filter} onClick={() => setFilter(null)}>all</button>
        {CATS.map(c => <button type="button" key={c} title={`About: ${c}`} style={chip(filter === c)} aria-pressed={filter === c} onClick={() => setFilter(filter === c ? null : c)}>{c}</button>)}
        <span aria-hidden="true" style={{ width: 1, alignSelf: 'stretch', background: 'var(--border, #223)', margin: '0 2px' }} />
        {TYPES.map(t => <button type="button" key={t} title={`Shape: ${t}`} style={chip(filter === t)} aria-pressed={filter === t} onClick={() => setFilter(filter === t ? null : t)}>{t}</button>)}
        <label htmlFor="mc-search" style={srOnly}>Search memories</label>
        <input id="mc-search" value={q} onChange={e => setQ(e.target.value)} placeholder="search…" aria-label="Search memories"
          style={{ marginLeft: 'auto', background: 'transparent', border: '1px solid var(--border, #223)', borderRadius: 4, color: 'inherit', padding: '3px 8px', fontSize: 12 }} />
      </div>

      {/* Wraps. This row is a text input plus two selects plus two buttons,
          and at a phone width it ran past the viewport — with overflow-x
          hidden on both the row's ancestors and #root, so `save` and
          `distill session` were not merely tight but unreachable. You could
          compose a memory on a phone and had no way to store it, which is the
          whole point of the block. */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <label htmlFor="mc-new-text" style={srOnly}>New memory text</label>
        <input id="mc-new-text" value={newText} onChange={e => setNewText(e.target.value)} placeholder={`teach ${who} something durable…`}
          onKeyDown={e => e.key === 'Enter' && add()} aria-label="New memory text"
          style={{ flex: '1 1 220px', minWidth: 0, background: 'transparent', border: '1px solid var(--border, #223)', borderRadius: 4, color: 'inherit', padding: '6px 10px', fontSize: 13 }} />
        <label htmlFor="mc-new-cat" style={srOnly}>What this memory is about</label>
        <select id="mc-new-cat" value={newCat} onChange={e => setNewCat(e.target.value)} aria-label="What this memory is about"
          title="What the memory is about — this is what the filter chips match"
          style={{ background: 'transparent', border: '1px solid var(--border, #223)', borderRadius: 4, color: 'inherit', fontSize: 12 }}>
          <option value="">about…</option>
          {CATS.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <label htmlFor="mc-new-type" style={srOnly}>Memory shape (optional)</label>
        <select id="mc-new-type" value={newType} onChange={e => setNewType(e.target.value)} aria-label="Memory shape (optional)"
          title="Optional — the shape of the memory, for continuity ranking"
          style={{ background: 'transparent', border: '1px solid var(--border, #223)', borderRadius: 4, color: 'inherit', fontSize: 12 }}>
          <option value="">shape…</option>
          {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <button type="button" onClick={add} disabled={busy} style={{ ...chip(true), display: 'flex', alignItems: 'center', gap: 4 }}><Plus size={12} /> save</button>
        <button type="button" onClick={distill} disabled={busy} title={`Distill ${who}'s most recent saved chat into memories`}
          aria-label="Distill recent terminal session into memories"
          style={{ ...chip(false), display: 'flex', alignItems: 'center', gap: 4 }}><Sparkles size={12} /> distill session</button>
      </div>

      {shown.length === 0 && !loadError && (
        <div style={{ color: 'var(--text-dim, #8aa)', fontSize: 13, padding: 20 }}>
          {memories.length ? 'No memories match.' : current ? `${current.name} has no memories of its own yet.` : 'No memories yet.'}
        </div>
      )}
      {shown.map(m => (
        <div key={m.id} style={{ border: '1px solid var(--border, #223)', borderLeft: m.pinned ? '3px solid var(--accent, #00ff40)' : '1px solid var(--border, #223)', borderRadius: 6, padding: '10px 12px', marginBottom: 8, display: 'flex', gap: 10, alignItems: 'flex-start', opacity: m.active === false ? 0.55 : 1 }}>
          <div style={{ paddingTop: 2 }}>
            <Switch on={m.active !== false} disabled={busy} onChange={() => toggle(m)}
              label={m.active !== false ? 'On — sent to the model and recalled. Switch off.' : 'Off — kept, not sent to a model or recalled. Switch on.'} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            {editingId === m.id ? (
              <div>
                <label htmlFor={`mc-edit-${m.id}`} style={srOnly}>Edit memory text</label>
                <textarea id={`mc-edit-${m.id}`} value={editText} onChange={e => setEditText(e.target.value)}
                  autoFocus rows={3} aria-label="Edit memory text"
                  style={{ width: '100%', background: 'transparent', border: '1px solid var(--border, #223)', borderRadius: 4, color: 'inherit', padding: '6px 8px', fontSize: 13, fontFamily: 'inherit', resize: 'vertical' }} />
              </div>
            ) : (
              <div style={{ fontSize: 13, lineHeight: 1.5, overflowWrap: 'anywhere' }}>{m.text}</div>
            )}
            <div style={{ fontSize: 10, color: 'var(--text-dim, #8aa)', marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <span>[{m.type || m.category || 'fact'}]</span>
              {m.title && <span>{m.title}</span>}
              <span>{new Date(m.timestamp).toLocaleDateString()}</span>
              <span>{m.source}</span>
              {typeof m.tokens === 'number' && <span title="what this memory costs every turn it is sent">~{m.tokens} tok</span>}
              {m.active === false && <span>off</span>}
            </div>
          </div>
          {editingId === m.id ? (
            <>
              <button type="button" onClick={() => saveEdit(m.id)} disabled={busy} title="save edit" aria-label="Save memory edit" style={iconBtn('var(--accent, #00ff40)')}>
                <Check size={14} />
              </button>
              <button type="button" onClick={cancelEdit} title="cancel edit" aria-label="Cancel memory edit" style={iconBtn()}>
                <X size={14} />
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => startEdit(m)} title="edit" aria-label={`Edit memory: ${m.text.slice(0, 40)}`} style={iconBtn()}>
                <Pencil size={14} />
              </button>
              <button type="button" onClick={() => pin(m.id)} title={m.pinned ? 'unpin' : 'pin — first in line when it is on'}
                aria-label={m.pinned ? 'Unpin memory' : 'Pin memory — first in line when it is on'} aria-pressed={m.pinned}
                style={iconBtn(m.pinned ? 'var(--accent, #00ff40)' : undefined)}>
                <Pin size={14} />
              </button>
              <button type="button" onClick={() => del(m.id)} title="delete" aria-label={`Delete memory: ${m.text.slice(0, 40)}`} style={iconBtn()}>
                <Trash2 size={14} />
              </button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
