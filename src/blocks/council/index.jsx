/**
 * Council — multi-model deliberation with a persistent, operator-built roster.
 * Members (each = a persona + an assigned model AEON can reach) answer
 * independently → read each other and may revise → the chair synthesizes a
 * verdict. Every debate is saved to the Second Brain vault as history.
 * Each turn goes through /api/council/speak (kernelLLM.stream), so it works on
 * whatever providers are alive and says when an answer was cut off.
 */
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Landmark, Play, Loader, ChevronDown, Copy, Check, Users, Plus, Trash2, Save, Clock, X, Pencil, Scissors } from 'lucide-react';
import { runDebate, savePayload } from './debate.mjs';

// A persona and a debate question are prose, not a label — CEO, on the 2017
// Air blind test: "council block needs flex fields!! on all text boxes."
// These were fixed one-line <input>s that scrolled their own text sideways
// as it grew, the same defect the terminal's chat box had (2026-09-20: "chat
// box needs to be a flex field"). Grows to fit up to maxPx, then scrolls
// internally rather than pushing the panel taller. Reading scrollHeight
// without resetting height to 'auto' first would only ever grow, never
// shrink, since the box's own prior height caps what it can report.
function useAutoGrow(ref, value, maxPx) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, maxPx)}px`;
  }, [ref, value, maxPx]);
}

// One councilor's turn. /api/council/speak (not /api/ai) because it reports
// whether the model cut the answer off at its output limit, and which provider
// actually answered — /api/ai returns the text alone.
async function ask(prompt, member) {
  const r = await fetch('/api/council/speak', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, provider: member.provider, model: member.model }),
  });
  let d = null;
  try { d = await r.json(); } catch { /* empty/non-JSON body — e.g. backend unreachable */ }
  if (!r.ok) {
    const e = new Error(d?.error || `LLM call failed (${r.status || 'no response'})`);
    if (d?.partialText) e.partialText = d.partialText;
    throw e;
  }
  return d || { text: '' };
}

const CUT_NOTE = 'Cut off — the model stopped at its output limit (free OpenRouter models stop at 1024 tokens). Give this seat a model with a larger budget, or shorten its persona.';

export default function Council() {
  const [members, setMembers] = useState([]);
  const [availModels, setAvailModels] = useState([]);
  const [question, setQuestion] = useState('');
  const [phase, setPhase] = useState('idle');
  const [statusLine, setStatusLine] = useState('');
  const [opinions, setOpinions] = useState({});
  const [verdict, setVerdict] = useState('');
  const [verdictCut, setVerdictCut] = useState(false);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState({});
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [tab, setTab] = useState('debate'); // debate | roster | history
  const [debates, setDebates] = useState([]);
  const [viewing, setViewing] = useState(null);
  const runningRef = useRef(false);
  const questionRef = useRef(null);
  useAutoGrow(questionRef, question, 200);

  const councilors = members.filter(m => !m.chair);
  const chair = members.find(m => m.chair) || councilors[0];

  const loadRoster = useCallback(async () => {
    try {
      const [m, mo] = await Promise.all([
        fetch('/api/council/members').then(r => r.json()).catch(() => ({ members: [] })),
        fetch('/api/council/models').then(r => r.json()).catch(() => ({ models: [] })),
      ]);
      setMembers(m.members || []);
      setAvailModels(mo.models || []);
    } catch {}
  }, []);
  useEffect(() => { loadRoster(); }, [loadRoster]);

  const loadHistory = useCallback(async () => {
    try { const d = await fetch('/api/council/debates').then(r => r.json()); setDebates(d.debates || []); } catch {}
  }, []);
  useEffect(() => { if (tab === 'history') loadHistory(); }, [tab, loadHistory]);

  const convene = async () => {
    const q = question.trim();
    if (!q || runningRef.current) return;
    if (councilors.length < 2) { setError('Add at least 2 councilors in the Roster tab.'); return; }
    runningRef.current = true;
    setError(null); setVerdict(''); setVerdictCut(false); setOpinions({}); setOpen({}); setSaved(false);
    // Every value the chair and the Vault transcript use comes from this run
    // (./debate.mjs). It used to be read from `opinions` as captured when
    // CONVENE was clicked, so the chair — and the saved transcript — got the
    // openings repeated, or the PREVIOUS debate's final positions.
    try {
      const result = await runDebate({
        question: q, councilors, chair, ask,
        onOpinion: (id, o) => setOpinions(prev => ({ ...prev, [id]: o })),
        onStatus: setStatusLine,
        onPhase: setPhase,
      });
      setVerdict(result.verdict);
      setVerdictCut(!!result.verdictTruncated);
      if (result.verdictError) setError(result.verdictError);
      setPhase('done');
      setStatusLine('');
      // Persist to the vault — a debate without a verdict is saved too, with
      // the reason, so the opinions the operator waited for are not lost.
      try {
        const r = await fetch('/api/council/debate/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(savePayload(q, councilors, result)) });
        if (r.ok) setSaved(true);
        else setError(prev => `${prev ? prev + ' ' : ''}The debate could not be saved to the Vault (${r.status}).`);
      } catch (e) { setError(prev => `${prev ? prev + ' ' : ''}The debate could not be saved to the Vault: ${e.message}`); }
    } catch (e) { setError(e.message); setPhase('error'); }
    runningRef.current = false;
  };

  const copyVerdict = async () => {
    try { await navigator.clipboard.writeText(`# Council verdict\n\nQ: ${question}\n\n${verdict}`); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch {}
  };

  const busy = phase === 'opening' || phase === 'deliberating' || phase === 'verdict';
  const TABBTN = (id, label, Icon) => (
    <button onClick={() => setTab(id)} role="tab" aria-selected={tab === id} id={`council-tab-${id}`} aria-controls={`council-panel-${id}`}
      className="council-focusable"
      style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', padding: '6px 2px', fontSize: 12, fontWeight: 600, color: tab === id ? 'var(--accent)' : 'var(--text-dim)', borderBottom: `2px solid ${tab === id ? 'var(--accent)' : 'transparent'}` }}>
      <Icon size={13} aria-hidden="true" /> {label}
    </button>
  );

  return (
    <div style={{ padding: 24, maxWidth: 940, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <Landmark size={20} aria-hidden="true" style={{ color: 'var(--accent)' }} />
        <h2 style={{ margin: 0, fontSize: '1.3em' }}>Council</h2>
        <span style={{ fontSize: 10, opacity: 0.5, fontFamily: 'var(--font-mono)', border: '1px solid var(--border)', padding: '2px 8px', borderRadius: 4 }}>
          {councilors.length} COUNCILORS + CHAIR
        </span>
      </div>

      <div role="tablist" aria-label="Council views" style={{ display: 'flex', gap: 18, marginBottom: 18, borderBottom: '1px solid var(--border-mute)' }}>
        {TABBTN('debate', 'Debate', Landmark)}
        {TABBTN('roster', 'Roster', Users)}
        {TABBTN('history', 'History', Clock)}
      </div>

      {/* ── ROSTER ─────────────────────────────────────────────── */}
      {tab === 'roster' && <div role="tabpanel" id="council-panel-roster" aria-labelledby="council-tab-roster"><RosterPanel members={members} availModels={availModels} onChange={loadRoster} /></div>}

      {/* ── HISTORY ────────────────────────────────────────────── */}
      {tab === 'history' && (
        <div role="tabpanel" id="council-panel-history" aria-labelledby="council-tab-history">
          {debates.length === 0 && <div style={{ color: 'var(--text-dim)', fontSize: 12, padding: 20 }}>No debates yet. Convene the council and it's saved here — and in your vault.</div>}
          {debates.map(d => {
            const openDebate = async () => { const r = await fetch(`/api/council/debate/${d.id}`).then(x => x.json()); setViewing(r); };
            return (
              <div key={d.id} role="button" tabIndex={0} aria-label={`View debate: ${d.question}`}
                className="council-focusable"
                onClick={openDebate}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDebate(); } }}
                style={{ padding: '10px 12px', border: '1px solid var(--border-mute)', borderRadius: 8, marginBottom: 8, cursor: 'pointer' }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{d.question}</div>
                <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>{d.at}</div>
              </div>
            );
          })}
          {viewing && (
            <div style={{ marginTop: 12, border: '1px solid var(--border)', borderRadius: 10, padding: 16, background: 'var(--bg-card)' }}>
              <button onClick={() => setViewing(null)} aria-label="Close debate transcript" className="council-focusable" style={{ float: 'right', background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer' }}><X size={14} aria-hidden="true" /></button>
              <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, color: 'var(--text)', fontFamily: 'inherit', margin: 0 }}>{viewing.markdown}</pre>
            </div>
          )}
        </div>
      )}

      {/* ── DEBATE ─────────────────────────────────────────────── */}
      {tab === 'debate' && <div role="tabpanel" id="council-panel-debate" aria-labelledby="council-tab-debate">
        <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
          <textarea ref={questionRef} value={question} onChange={e => setQuestion(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !busy && question.trim()) { e.preventDefault(); convene(); } }}
            aria-label="Question for the council" className="council-focusable"
            placeholder="Put a question before the council — a decision, a tradeoff, a plan to stress-test… (Shift+Enter for a new line)" rows={2}
            style={{ flex: 1, background: 'var(--surface-1)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', color: 'var(--text)', fontFamily: 'inherit', fontSize: 13, outline: 'none', resize: 'none', overflowY: 'auto', maxHeight: 200 }} />
          <button onClick={convene} disabled={busy || !question.trim()} className="council-focusable" style={{ background: 'var(--accent-dim)', border: '1px solid var(--accent)', borderRadius: 8, color: 'var(--accent)', padding: '0 20px', cursor: busy ? 'default' : 'pointer', fontWeight: 700, fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
            {busy ? <Loader size={14} aria-hidden="true" style={{ animation: 'spin 1s linear infinite' }} /> : <Play size={14} aria-hidden="true" />}
            {busy ? 'IN SESSION' : 'CONVENE'}
          </button>
        </div>

        {busy && (
          <div style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', boxShadow: '0 0 8px var(--accent)', display: 'inline-block' }} />
            {statusLine} <span style={{ opacity: 0.5 }}>(local models — first call may take a minute while a model loads)</span>
          </div>
        )}
        {error && <div style={{ color: 'var(--coral, #ff6b6b)', fontSize: 12, marginBottom: 12 }}>{error}</div>}

        {Object.keys(opinions).length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10, marginBottom: 16 }}>
            {councilors.filter(c => opinions[c.id]).map(c => {
              const o = opinions[c.id]; const expanded = open[c.id];
              const shown = o.revised || o.opening || `(no answer — ${o.error || 'unavailable'})`;
              const cut = o.revised ? o.revisedTruncated : o.openingTruncated;
              return (
                <div key={c.id} style={{ borderTop: `2px solid ${c.color}`, background: 'var(--bg-card)', border: '1px solid var(--border-mute)', borderRadius: 10, padding: 14 }}>
                  <div role="button" tabIndex={0} aria-expanded={!!expanded} aria-label={`${c.label}'s opinion, ${expanded ? 'expanded' : 'collapsed'}`}
                    className="council-focusable"
                    onClick={() => setOpen(prev => ({ ...prev, [c.id]: !prev[c.id] }))}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(prev => ({ ...prev, [c.id]: !prev[c.id] })); } }}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 8 }}>
                    <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: c.color, flexShrink: 0 }} />
                    <span style={{ fontSize: 12, fontWeight: 700 }}>{c.label}</span>
                    <span style={{ fontSize: 9, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)' }}>{c.model}</span>
                    {cut && (
                      <span title={CUT_NOTE} style={{ fontSize: 9, color: 'var(--amber, #f59e0b)', border: '1px solid var(--amber, #f59e0b)', borderRadius: 3, padding: '1px 5px', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                        <Scissors size={9} aria-hidden="true" /> CUT OFF
                      </span>
                    )}
                    <ChevronDown size={12} aria-hidden="true" style={{ marginLeft: 'auto', color: 'var(--text-dim)', transform: expanded ? 'rotate(180deg)' : 'none' }} />
                  </div>
                  <div style={{ fontSize: 11.5, color: o.opening ? 'var(--text-dim)' : 'var(--coral, #ff6b6b)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                    {shown.slice(0, expanded ? 100000 : 260)}{!expanded && shown.length > 260 ? '…' : ''}
                  </div>
                  {cut && expanded && <div role="note" style={{ fontSize: 10.5, color: 'var(--amber, #f59e0b)', marginTop: 6, lineHeight: 1.5 }}>{CUT_NOTE}</div>}
                  {o.revisedError && <div role="note" style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 6 }}>Final round failed ({o.revisedError}) — showing the opening position.</div>}
                  {o.servedBy?.fallback && <div role="note" style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 6 }}>Answered by {o.servedBy.provider}{o.servedBy.model ? `/${o.servedBy.model}` : ''} — this seat's own model could not.</div>}
                </div>
              );
            })}
          </div>
        )}

        {verdict && (
          <div style={{ borderLeft: `3px solid ${chair?.color || 'var(--accent)'}`, background: 'var(--bg-card)', border: '1px solid var(--border-mute)', borderRadius: 10, padding: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <Landmark size={14} aria-hidden="true" style={{ color: chair?.color || 'var(--accent)' }} />
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', color: chair?.color || 'var(--accent)' }}>COUNCIL VERDICT</span>
              {saved && <span style={{ fontSize: 9, color: 'var(--text-faint)', display: 'flex', alignItems: 'center', gap: 3 }}><Save size={9} aria-hidden="true" /> saved to vault</span>}
              <button onClick={copyVerdict} className="council-focusable" aria-label={copied ? 'Verdict copied to clipboard' : 'Copy verdict to clipboard'} style={{ marginLeft: 'auto', background: 'none', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-dim)', cursor: 'pointer', padding: '3px 8px', display: 'flex', alignItems: 'center', gap: 4, fontSize: 10 }}>
                {copied ? <Check size={11} aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />} {copied ? 'copied' : 'copy'}
              </button>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text)', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{verdict}</div>
            {verdictCut && <div role="note" style={{ fontSize: 11, color: 'var(--amber, #f59e0b)', marginTop: 10, display: 'flex', alignItems: 'center', gap: 5 }}><Scissors size={11} aria-hidden="true" /> {CUT_NOTE}</div>}
          </div>
        )}

        {phase === 'idle' && (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-dim)', fontSize: 12 }}>
            The council is assembled and waiting. Ask it something worth deliberating.
          </div>
        )}
      </div>}
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        .council-focusable:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
      `}</style>
    </div>
  );
}

// ── Roster management: build / assign models / delete council members ──────
function RosterPanel({ members, availModels, onChange }) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ label: '', persona: '', model: '' });
  const [editingId, setEditingId] = useState(null);
  const [edit, setEdit] = useState({ label: '', persona: '' });
  const editPersonaRef = useRef(null);
  const formPersonaRef = useRef(null);
  useAutoGrow(editPersonaRef, edit.persona, 120);
  useAutoGrow(formPersonaRef, form.persona, 120);
  const [err, setErr] = useState('');
  // A "role:<name>" engine is a seat that follows a Settings role — the only
  // way to seat a custom / LM Studio / OpenAI-compatible endpoint's model.
  const optLabel = (engine, id) => (!engine
    ? `${id || 'your chat model'} (follows Settings → chat)`
    : String(engine).startsWith('role:') ? `${id} (follows Settings → ${engine.slice(5)})` : `${id} (${engine})`);
  const modelOpts = availModels.map(m => ({ value: `${m.engine}|${m.id}`, label: optLabel(m.engine, m.id) }));

  const add = async () => {
    if (!form.label || !form.model) { setErr('A new member needs a name and a model.'); return; }
    const [provider, model] = form.model.split('|');
    const r = await fetch('/api/council/members', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: form.label, persona: form.persona, provider, model }) }).catch(() => null);
    if (!r || !r.ok) { setErr((await r?.json().catch(() => ({})))?.error || 'Could not add that member.'); return; }
    setErr('');
    setForm({ label: '', persona: '', model: '' }); setAdding(false); onChange();
  };

  // Every mutation reports what the server said. These all used to fire and
  // ignore the response, so a refusal — the chair rules below, a 404 on a
  // stale id — looked exactly like success until the list failed to change.
  const patch = async (id, body) => {
    setErr('');
    const r = await fetch(`/api/council/members/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!r.ok) { setErr((await r.json().catch(() => ({}))).error || 'Could not save that change.'); return false; }
    onChange();
    return true;
  };

  const del = async (id) => {
    setErr('');
    const r = await fetch(`/api/council/members/${id}`, { method: 'DELETE' });
    if (!r.ok) { setErr((await r.json().catch(() => ({}))).error || 'Could not remove that member.'); return; }
    const d = await r.json().catch(() => ({}));
    if (d.newChair) setErr(`Removed. ${d.newChair} is the new chair.`);
    onChange();
  };

  const setModel = (id, val) => { const [provider, model] = val.split('|'); return patch(id, { provider, model }); };
  const makeChair = (id) => patch(id, { chair: true });

  const startEdit = (m) => { setEditingId(m.id); setEdit({ label: m.label || '', persona: m.persona || '' }); setErr(''); };
  const saveEdit = async (id) => {
    if (!edit.label.trim()) { setErr('A member needs a name.'); return; }
    if (await patch(id, { label: edit.label.trim(), persona: edit.persona.trim() })) setEditingId(null);
  };

  const inp = { background: 'var(--surface-1)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 10px', color: 'var(--text)', fontSize: 12, outline: 'none' };
  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 12 }}>
        Build your council. Each member is a persona + a model AEON can reach. The chair writes the verdict. {availModels.length} models available.
      </div>
      {availModels.length === 0 && (
        <div style={{ padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 8, marginBottom: 12, fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.6 }}>
          No models are reachable right now. Add an API key in <b>Settings</b>, or install a local model from the <b>Cookbook</b> block — the roster fills in automatically once AEON can reach a model.
        </div>
      )}
      {members.length === 0 && availModels.length > 0 && (
        <div style={{ padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 8, marginBottom: 12, fontSize: 12, color: 'var(--text-dim)' }}>
          No council members yet — add one below.
        </div>
      )}
      {err && <div role="status" style={{ fontSize: 11.5, color: 'var(--amber)', background: 'var(--amber-dim)', border: '1px solid var(--amber-dim)', borderRadius: 6, padding: '7px 11px', marginBottom: 8, lineHeight: 1.5 }}>{err}</div>}

      {members.map(m => (
        <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', border: '1px solid var(--border-mute)', borderRadius: 8, marginBottom: 8 }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: m.color, flexShrink: 0 }} />

          {editingId === m.id ? (
            // Name and persona were fixed at creation: the API had accepted a
            // PUT for both since it was written, and nothing in the UI ever
            // sent one, so a typo in a member's name was permanent.
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <input autoFocus style={inp} className="council-focusable" aria-label="Member name" value={edit.label}
                onChange={e => setEdit({ ...edit, label: e.target.value })}
                onKeyDown={e => { if (e.key === 'Enter') saveEdit(m.id); if (e.key === 'Escape') setEditingId(null); }} />
              <textarea ref={editPersonaRef} rows={1} style={{ ...inp, fontFamily: 'inherit', resize: 'none', overflowY: 'auto', maxHeight: 120, lineHeight: 1.5 }}
                className="council-focusable" aria-label="Member persona" placeholder="Persona / role — how this voice thinks (Shift+Enter for a new line)" value={edit.persona}
                onChange={e => setEdit({ ...edit, persona: e.target.value })}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(m.id); }
                  if (e.key === 'Escape') setEditingId(null);
                }} />
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => saveEdit(m.id)} className="council-focusable" style={{ ...inp, cursor: 'pointer', color: 'var(--accent)', border: '1px solid var(--accent)', fontWeight: 600, padding: '5px 12px' }}>Save</button>
                <button onClick={() => setEditingId(null)} className="council-focusable" style={{ ...inp, cursor: 'pointer', color: 'var(--text-dim)', padding: '5px 12px' }}>Cancel</button>
              </div>
            </div>
          ) : (
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                {m.label}
                {m.chair && <span style={{ fontSize: 9, color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: 3, padding: '1px 5px', marginLeft: 4 }}>CHAIR</span>}
              </div>
              {m.persona && <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{m.persona}</div>}
            </div>
          )}

          {editingId !== m.id && (
            <>
              <select value={`${m.provider}|${m.model}`} onChange={e => setModel(m.id, e.target.value)}
                aria-label={`Change model for ${m.label}`} className="council-focusable" style={{ ...inp, maxWidth: 220 }}>
                <option value={`${m.provider}|${m.model}`}>{optLabel(m.provider, m.model)}</option>
                {modelOpts.filter(o => o.value !== `${m.provider}|${m.model}`).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>

              {/* Chair was assigned once at seeding and never reassignable, so
                  the member who writes the verdict was whoever happened to be
                  created first. */}
              {!m.chair && (
                <button onClick={() => makeChair(m.id)} title="Make chair — this member writes the verdict"
                  aria-label={`Make ${m.label} the chair`} className="council-focusable"
                  style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-dim)', cursor: 'pointer', fontSize: 9, padding: '3px 7px', letterSpacing: '0.05em' }}>
                  CHAIR
                </button>
              )}

              <button onClick={() => startEdit(m)} title="Edit name and persona" aria-label={`Edit ${m.label}`}
                className="council-focusable" style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', display: 'flex' }}>
                <Pencil size={13} aria-hidden="true" />
              </button>

              {/* Was hidden whenever the roster held 2 or fewer, so a council
                  seeded with two members could never be changed — the state
                  the operator was most likely to land in on a fresh install.
                  A debate needs two voices, so that is the real floor, and
                  the reason is stated rather than the control vanishing. */}
              <button onClick={() => members.length > 2 ? del(m.id) : setErr('A debate needs at least two voices. Add another member before removing this one.')}
                title={members.length > 2 ? 'Remove' : 'A debate needs at least two voices'}
                aria-label={`Remove ${m.label} from council`} className="council-focusable"
                style={{ background: 'none', border: 'none', color: members.length > 2 ? 'var(--text-dim)' : 'var(--text-faint)', cursor: members.length > 2 ? 'pointer' : 'not-allowed', display: 'flex' }}>
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      ))}
      {adding ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, border: '1px dashed var(--border)', borderRadius: 8, marginTop: 4 }}>
          <input style={inp} className="council-focusable" aria-label="Council member name" placeholder="Name (e.g. The Skeptic)" value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} />
          <textarea ref={formPersonaRef} rows={1} style={{ ...inp, fontFamily: 'inherit', resize: 'none', overflowY: 'auto', maxHeight: 120, lineHeight: 1.5 }}
            className="council-focusable" aria-label="Council member persona or role (optional)"
            placeholder="Persona / role (optional) — how this voice thinks" value={form.persona}
            onChange={e => setForm({ ...form, persona: e.target.value })} />
          <select style={inp} className="council-focusable" aria-label="Assign a model to this council member" value={form.model} onChange={e => setForm({ ...form, model: e.target.value })}>
            <option value="">Assign a model…</option>
            {modelOpts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={add} className="council-focusable" style={{ ...inp, cursor: 'pointer', color: 'var(--accent)', border: '1px solid var(--accent)', fontWeight: 600 }}>Add member</button>
            <button onClick={() => setAdding(false)} className="council-focusable" style={{ ...inp, cursor: 'pointer', color: 'var(--text-dim)' }}>Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} className="council-focusable" style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, background: 'none', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--accent)', cursor: 'pointer', padding: '8px 14px', fontSize: 12, fontWeight: 600 }}>
          <Plus size={13} aria-hidden="true" /> Add council member
        </button>
      )}
    </div>
  );
}
