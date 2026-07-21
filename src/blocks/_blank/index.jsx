import React, { useEffect, useState } from 'react';
// Aurora shared components — import what you need:
// import { Card, Button, Badge, StatCard, AgentOrb, Section, EmptyState, Spinner, useToast, ToastContainer } from '../../components/aurora';

// __BLANK__ — block UI. One default-exported component; the kernel mounts it
// at the manifest's route. Fetch your own API with relative /api/crn/... paths.

const S = {
  wrap: { padding: '24px', color: '#E0E0E0', fontFamily: 'Inter, sans-serif', maxWidth: '900px', margin: '0 auto' },
  h1: { color: '#00f2ff', fontSize: '20px', letterSpacing: '2px', margin: '0 0 4px' },
  sub: { color: '#888', fontSize: '12px', marginBottom: '20px' },
  card: { background: '#0d1220', border: '1px solid #1e2a45', borderRadius: '8px', padding: '14px 16px', marginBottom: '10px' },
  input: { flex: 1, background: '#111', border: '1px solid #333', borderRadius: '6px', padding: '10px 14px', color: '#E0E0E0', fontSize: '13px', outline: 'none' },
  btn: { padding: '10px 20px', background: '#00f2ff', color: '#000', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 700, fontSize: '12px' },
};

export default function BlankBlock() {
  const [items, setItems] = useState([]);
  const [text, setText] = useState('');

  const refresh = async () => {
    try { setItems(await (await fetch('/api/crn/__BLANK__/items')).json()); } catch {}
  };
  useEffect(() => { refresh(); }, []);

  const add = async () => {
    if (!text.trim()) return;
    await fetch('/api/crn/__BLANK__/items', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    setText('');
    refresh();
  };

  /// EDIT ZONE — replace this JSX with the block's real interface.
  return (
    <div style={S.wrap}>
      <h1 style={S.h1}>🧩 __BLANK__</h1>
      <div style={S.sub}>Working starter UI — list + add, wired to this block's own API.</div>
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
        <input style={S.input} value={text} onChange={e => setText(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && add()} placeholder="Add an item" aria-label="New item" />
        <button style={S.btn} onClick={add}>ADD</button>
      </div>
      {items.map(i => <div key={i.id} style={S.card}>{i.text}</div>)}
      {items.length === 0 && <div style={{ color: '#555', fontSize: '12px' }}>Nothing yet.</div>}
    </div>
  );
  /// END EDIT ZONE
}
