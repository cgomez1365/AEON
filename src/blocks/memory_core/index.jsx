/**
 * Memory Core — VP's persistent memory, operator view.
 * List / filter / pin / edit / delete / distill. Every memory is also a
 * vault file (Vault/Agents/vp/memory) visible in Aeon Matrix.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { Brain, Pin, Trash2, Plus, Sparkles, RefreshCw, Pencil, Check, X } from 'lucide-react';

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

export default function MemoryCore() {
  const [memories, setMemories] = useState([]);
  const [filter, setFilter] = useState(null);
  const [q, setQ] = useState('');
  const [newText, setNewText] = useState('');
  const [newType, setNewType] = useState('');
  const [newCat, setNewCat] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/memory');
      const d = await r.json();
      setMemories(d.memories || []);
    } catch {}
  }, []);
  useEffect(() => { load(); }, [load]);

  const act = async (fn, msg) => {
    setBusy(true);
    try { await fn(); if (msg) { setNote(msg); setTimeout(() => setNote(''), 2500); } await load(); }
    catch (e) { setNote('failed: ' + e.message); }
    setBusy(false);
  };

  const add = () => act(async () => {
    if (newText.trim().length < 6) throw new Error('too short');
    await fetch('/api/memory/add', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: newText.trim(),
        type: newType || null,
        // Omitted rather than sent empty, so the API's own "fact" default
        // applies when the operator did not choose.
        ...(newCat ? { category: newCat } : {}),
        source: 'operator',
      }),
    });
    setNewText(''); setNewType(''); setNewCat('');
  }, 'memory saved');

  const pin = (id) => act(() => fetch(`/api/memory/${id}/pin`, { method: 'POST' }));
  const del = (id) => act(() => fetch(`/api/memory/${id}`, { method: 'DELETE' }), 'deleted');

  const startEdit = (m) => { setEditingId(m.id); setEditText(m.text); };
  const cancelEdit = () => { setEditingId(null); setEditText(''); };
  const saveEdit = (id) => act(async () => {
    if (editText.trim().length < 6) throw new Error('too short');
    await fetch(`/api/memory/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: editText.trim() }),
    });
    setEditingId(null); setEditText('');
  }, 'memory updated');
  const distill = () => act(async () => {
    const r = await fetch('/api/memory/distill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    setNote(`distilled ${d.added?.length || 0} new memories`);
  });

  const shown = memories.filter(m => {
    if (filter && m.type !== filter && m.category !== filter) return false;
    if (q && !(m.text + ' ' + (m.title || '')).toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  return (
    <div style={{ padding: 24, maxWidth: 980 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <Brain size={20} style={{ color: 'var(--accent, #00ff40)' }} />
        <h2 style={{ margin: 0, fontSize: 18 }}>Memory Core</h2>
        <span style={{ fontSize: 11, color: 'var(--text-dim, #8aa)', border: '1px solid var(--border, #223)', padding: '2px 8px', borderRadius: 4 }}>
          {memories.length} MEMORIES · {memories.filter(m => m.pinned).length} PINNED
        </span>
        <button type="button" onClick={() => load()} title="refresh" aria-label="Refresh memories"
          style={{ ...chip(false), marginLeft: 'auto' }}><RefreshCw size={11} /></button>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-dim, #8aa)', marginBottom: 16 }}>
        What VP knows across sessions — pinned memories ride on every terminal chat, the rest by relevance. Each one is a vault file.
      </div>

      {note && <div role="status" style={{ fontSize: 12, color: 'var(--accent, #00ff40)', marginBottom: 8 }}>{note}</div>}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }} role="group" aria-label="Filter memories by type or category">
        <button type="button" style={chip(!filter)} aria-pressed={!filter} onClick={() => setFilter(null)}>all</button>
        {CATS.map(c => <button type="button" key={c} title={`About: ${c}`} style={chip(filter === c)} aria-pressed={filter === c} onClick={() => setFilter(filter === c ? null : c)}>{c}</button>)}
        <span aria-hidden="true" style={{ width: 1, alignSelf: 'stretch', background: 'var(--border, #223)', margin: '0 2px' }} />
        {TYPES.map(t => <button type="button" key={t} title={`Shape: ${t}`} style={chip(filter === t)} aria-pressed={filter === t} onClick={() => setFilter(filter === t ? null : t)}>{t}</button>)}
        <label htmlFor="mc-search" style={srOnly}>Search memories</label>
        <input id="mc-search" value={q} onChange={e => setQ(e.target.value)} placeholder="search…" aria-label="Search memories"
          style={{ marginLeft: 'auto', background: 'transparent', border: '1px solid var(--border, #223)', borderRadius: 4, color: 'inherit', padding: '3px 8px', fontSize: 12 }} />
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <label htmlFor="mc-new-text" style={srOnly}>New memory text</label>
        <input id="mc-new-text" value={newText} onChange={e => setNewText(e.target.value)} placeholder="teach VP something durable…"
          onKeyDown={e => e.key === 'Enter' && add()} aria-label="New memory text"
          style={{ flex: 1, background: 'transparent', border: '1px solid var(--border, #223)', borderRadius: 4, color: 'inherit', padding: '6px 10px', fontSize: 13 }} />
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
        <button type="button" onClick={distill} disabled={busy} title="Distill recent terminal session into memories"
          aria-label="Distill recent terminal session into memories"
          style={{ ...chip(false), display: 'flex', alignItems: 'center', gap: 4 }}><Sparkles size={12} /> distill session</button>
      </div>

      {shown.length === 0 && <div style={{ color: 'var(--text-dim, #8aa)', fontSize: 13, padding: 20 }}>No memories match.</div>}
      {shown.map(m => (
        <div key={m.id} style={{ border: '1px solid var(--border, #223)', borderLeft: m.pinned ? '3px solid var(--accent, #00ff40)' : '1px solid var(--border, #223)', borderRadius: 6, padding: '10px 12px', marginBottom: 8, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            {editingId === m.id ? (
              <div>
                <label htmlFor={`mc-edit-${m.id}`} style={srOnly}>Edit memory text</label>
                <textarea id={`mc-edit-${m.id}`} value={editText} onChange={e => setEditText(e.target.value)}
                  autoFocus rows={3} aria-label="Edit memory text"
                  style={{ width: '100%', background: 'transparent', border: '1px solid var(--border, #223)', borderRadius: 4, color: 'inherit', padding: '6px 8px', fontSize: 13, fontFamily: 'inherit', resize: 'vertical' }} />
              </div>
            ) : (
              <div style={{ fontSize: 13, lineHeight: 1.5 }}>{m.text}</div>
            )}
            <div style={{ fontSize: 10, color: 'var(--text-dim, #8aa)', marginTop: 4, display: 'flex', gap: 8 }}>
              <span>[{m.type || m.category || 'fact'}]</span>
              {m.title && <span>{m.title}</span>}
              <span>{new Date(m.timestamp).toLocaleDateString()}</span>
              <span>{m.source}</span>
            </div>
          </div>
          {editingId === m.id ? (
            <>
              <button type="button" onClick={() => saveEdit(m.id)} disabled={busy} title="save edit" aria-label="Save memory edit"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent, #00ff40)' }}>
                <Check size={14} />
              </button>
              <button type="button" onClick={cancelEdit} title="cancel edit" aria-label="Cancel memory edit"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim, #8aa)' }}>
                <X size={14} />
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => startEdit(m)} title="edit" aria-label={`Edit memory: ${m.text.slice(0, 40)}`}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim, #8aa)' }}>
                <Pencil size={14} />
              </button>
              <button type="button" onClick={() => pin(m.id)} title={m.pinned ? 'unpin' : 'pin — always injected'}
                aria-label={m.pinned ? 'Unpin memory' : 'Pin memory — always injected'} aria-pressed={m.pinned}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: m.pinned ? 'var(--accent, #00ff40)' : 'var(--text-dim, #8aa)' }}>
                <Pin size={14} />
              </button>
              <button type="button" onClick={() => del(m.id)} title="delete" aria-label={`Delete memory: ${m.text.slice(0, 40)}`}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim, #8aa)' }}>
                <Trash2 size={14} />
              </button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
