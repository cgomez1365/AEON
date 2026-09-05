import React, { useState, useEffect, useCallback, useRef } from 'react';
import { FileText, Plus, Trash2, Save, Download, Eye, Edit3, Bold, Italic, Strikethrough, Heading, List, Link, Minus, Copy, Sparkles, X, ChevronDown, MessageSquare, Dna, Wand2, ArrowDown, Search, BookOpen } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const IMPROVE_ACTIONS = [
  { id: 'improve', label: 'Improve', icon: '✨' },
  { id: 'expand', label: 'Expand', icon: '📖' },
  { id: 'shorten', label: 'Shorten', icon: '✂️' },
  { id: 'casual', label: 'Casual', icon: '😎' },
  { id: 'professional', label: 'Professional', icon: '🎩' },
  { id: 'critique', label: 'Critique', icon: '🔍' },
];

export default function Writer() {
  const [docs, setDocs] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [content, setContent] = useState('');
  const [title, setTitle] = useState('Untitled');
  const [preview, setPreview] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [aiMenu, setAiMenu] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [writeMode, setWriteMode] = useState('write');
  const [styleProfile, setStyleProfile] = useState(null);
  const [cowriteOpen, setCowriteOpen] = useState(false);
  const [cowriteHistory, setCowriteHistory] = useState([]);
  const [cowriteInput, setCowriteInput] = useState('');
  const [cowriteLoading, setCowriteLoading] = useState(false);
  const [critiqueText, setCritiqueText] = useState('');
  const [undoStack, setUndoStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [generatePrompt, setGeneratePrompt] = useState('');
  const [generateTone, setGenerateTone] = useState('clear and professional');
  const [generateLength, setGenerateLength] = useState('medium');
  const generateInputRef = useRef(null);
  const [toast, setToast] = useState('');
  const toastTimer = useRef(null);
  const lastEditRef = useRef(0);
  const [autosaving, setAutosaving] = useState(false);
  const editorRef = useRef(null);
  const skipHistoryRef = useRef(false);

  // ── Writer 2.0 state ──
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [templates, setTemplates] = useState([]);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [versions, setVersions] = useState([]);
  const [versionPreview, setVersionPreview] = useState(null); // { ts, content }

  useEffect(() => {
    fetch('/api/writer/templates').then(r => r.json())
      .then(d => setTemplates(d.templates || [])).catch(() => {});
  }, []);

  // Global Escape exits focus mode even when the editor isn't the focused
  // element (the div's onKeyDown only fires when a child has focus, which
  // left users trapped in focus mode with no way out).
  useEffect(() => {
    if (!focusMode) return;
    const onKey = (e) => { if (e.key === 'Escape') setFocusMode(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusMode]);

  // Outline: every #/##/### heading with its character offset
  const outline = React.useMemo(() => {
    const items = [];
    let offset = 0;
    for (const line of content.split('\n')) {
      const m = line.match(/^(#{1,3})\s+(.*)$/);
      if (m) items.push({ level: m[1].length, text: m[2].slice(0, 60), offset });
      offset += line.length + 1;
    }
    return items;
  }, [content]);

  const jumpTo = (offset) => {
    setPreview(false);
    setTimeout(() => {
      const el = editorRef.current; if (!el) return;
      el.focus(); el.setSelectionRange(offset, offset);
      const before = content.slice(0, offset).split('\n').length;
      el.scrollTop = Math.max(0, (before - 4) * 22);
    }, 50);
  };

  const findCount = React.useMemo(() => {
    if (!findText) return 0;
    return content.split(findText).length - 1;
  }, [content, findText]);

  const findNext = () => {
    if (!findText) return;
    const el = editorRef.current; if (!el) return;
    const from = el.selectionEnd || 0;
    let idx = content.indexOf(findText, from);
    if (idx === -1) idx = content.indexOf(findText);   // wrap around
    if (idx === -1) return;
    setPreview(false);
    setTimeout(() => {
      el.focus(); el.setSelectionRange(idx, idx + findText.length);
      const before = content.slice(0, idx).split('\n').length;
      el.scrollTop = Math.max(0, (before - 4) * 22);
    }, 30);
  };

  const replaceAll = () => {
    if (!findText || findCount === 0) return;
    setVal(content.split(findText).join(replaceText));
    showToast(`Replaced ${findCount} occurrence${findCount !== 1 ? 's' : ''}`);
  };

  const loadVersions = async (id) => {
    if (!id) { setVersions([]); return; }
    try {
      const d = await fetch(`/api/writer/versions/${id}`).then(r => r.json());
      setVersions(d.versions || []);
    } catch { setVersions([]); }
  };

  const restoreVersion = async (ts) => {
    if (!activeId) return;
    try {
      const d = await fetch(`/api/writer/restore/${activeId}/${ts}`, { method: 'POST' }).then(r => r.json());
      if (d.ok) { setVal(d.content); setVersionPreview(null); loadVersions(activeId); showToast('Version restored (current draft was snapshotted first)'); }
    } catch {}
  };

  const startFromTemplate = (t) => {
    setActiveId(null); setTitle(t.id === 'blank' ? 'Untitled' : t.label); setContent(t.content);
    setDirty(!!t.content); setPreview(false); setCritiqueText('');
    setUndoStack([]); setRedoStack([]); setTemplatesOpen(false);
    setTimeout(() => editorRef.current?.focus(), 100);
  };

  const loadDocs = useCallback(async () => {
    try { const r = await fetch('/api/writer/docs'); setDocs(await r.json()); } catch {}
  }, []);

  useEffect(() => { loadDocs(); }, [loadDocs]);

  useEffect(() => {
    fetch('/api/writer/style').then(r => r.json()).then(d => { if (d.profile) setStyleProfile(d.profile); }).catch(() => {});
  }, []);

  const showToast = (msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2500);
  };

  // Every AI action funnels its failures here. Two rules, both learned the hard
  // way: an AI failure must never be silent, and it must never reach setVal() —
  // writing an empty result over the document was destroying user work.
  const aiFail = (d, res) => {
    if (res && !res.ok) {
      showToast(d?.error || `AI unavailable (${res.status})`);
      return true;
    }
    if (d?.error) { showToast(d.error); return true; }
    return false;
  };
  const aiCrash = (e) => showToast(e?.message ? `AI request failed: ${e.message}` : 'AI request failed');

  // ── Autosave: debounce 2.5s after last edit + 30s safety interval ──
  const silentSave = useCallback(async (currentContent, currentTitle, currentId) => {
    if (!currentId && !currentContent.trim()) return;
    setAutosaving(true);
    try {
      const r = await fetch('/api/writer/doc', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: currentId || undefined, title: currentTitle, content: currentContent }) });
      const d = await r.json();
      if (d.ok && !currentId) setActiveId(d.id);
      setDirty(false);
    } catch {}
    setAutosaving(false);
  }, []);

  useEffect(() => {
    lastEditRef.current = Date.now();
  }, [content]);

  useEffect(() => {
    // 2.5s debounce after last edit
    const debounce = setInterval(() => {
      if (!dirty) return;
      if (Date.now() - lastEditRef.current < 2500) return;
      silentSave(content, title, activeId);
    }, 500);
    // 30s safety net
    const periodic = setInterval(() => {
      if (dirty) silentSave(content, title, activeId);
    }, 30000);
    return () => { clearInterval(debounce); clearInterval(periodic); };
  }, [dirty, content, title, activeId, silentSave]);

  const openDoc = async (id) => {
    try {
      const r = await fetch(`/api/writer/doc/${id}`);
      const d = await r.json();
      setActiveId(id); setContent(d.content); setTitle(docs.find(x => x.id === id)?.title || 'Untitled');
      setDirty(false); setPreview(false); setCritiqueText('');
      setUndoStack([]); setRedoStack([]);
    } catch {}
  };

  const newDoc = () => {
    setActiveId(null); setContent(''); setTitle('Untitled'); setDirty(false); setPreview(false);
    setCritiqueText(''); setUndoStack([]); setRedoStack([]);
    setTimeout(() => editorRef.current?.focus(), 100);
  };

  const saveDoc = async () => {
    setSaving(true);
    try {
      const r = await fetch('/api/writer/doc', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: activeId, title, content }) });
      const d = await r.json();
      if (d.ok) { if (!activeId) setActiveId(d.id); setDirty(false); loadDocs(); }
    } catch {}
    setSaving(false);
  };

  const deleteDoc = async (id) => {
    if (!confirm('Delete this document?')) return;
    await fetch(`/api/writer/doc/${id}`, { method: 'DELETE' });
    if (activeId === id) newDoc();
    loadDocs();
  };

  const pushUndo = (val) => {
    if (skipHistoryRef.current) return;
    setUndoStack(prev => [...prev.slice(-99), val]);
    setRedoStack([]);
  };

  const undo = () => {
    if (undoStack.length === 0) return;
    setRedoStack(prev => [...prev, content]);
    const prev = undoStack[undoStack.length - 1];
    setUndoStack(s => s.slice(0, -1));
    skipHistoryRef.current = true;
    setContent(prev); setDirty(true);
    skipHistoryRef.current = false;
  };

  const redo = () => {
    if (redoStack.length === 0) return;
    setUndoStack(prev => [...prev, content]);
    const next = redoStack[redoStack.length - 1];
    setRedoStack(s => s.slice(0, -1));
    skipHistoryRef.current = true;
    setContent(next); setDirty(true);
    skipHistoryRef.current = false;
  };

  const setVal = (v) => {
    pushUndo(content);
    setContent(v); setDirty(true);
  };

  const insertMarkdown = (before, after = '') => {
    const el = editorRef.current; if (!el) return;
    const start = el.selectionStart, end = el.selectionEnd;
    const selected = content.slice(start, end);
    const newContent = content.slice(0, start) + before + selected + after + content.slice(end);
    setVal(newContent);
    if (selected.length > 0) {
      // Text was selected: the user is formatting something that exists.
      // Flip to Preview so they see bold/italic/etc. rendered, not raw asterisks.
      setPreview(true);
    } else {
      // No selection: cursor-only — they're about to type formatted text.
      // Stay in Edit so they can keep typing without switching modes.
      setTimeout(() => { el.focus(); el.setSelectionRange(start + before.length, start + before.length); }, 0);
    }
  };

  const getSelection = () => {
    const el = editorRef.current;
    return el ? content.slice(el.selectionStart, el.selectionEnd) : '';
  };

  const wordCount = content.trim().split(/\s+/).filter(Boolean).length;

  // ── AI: Improve ────────────────────────────────────────────────────────────

  const improve = async (action) => {
    if (!content.trim()) return;
    setAiMenu(false); setAiLoading(true); setCritiqueText('');
    const sel = getSelection();
    try {
      const r = await fetch('/api/writer/improve', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: content, action, selection: sel || undefined }) });
      const d = await r.json();
      if (aiFail(d, r)) { setAiLoading(false); return; }
      // Guard the write itself as well as the error path: never replace the
      // document with an empty or non-string result, whatever the status said.
      if (typeof d.content !== 'string' || d.content.trim() === '') {
        showToast('AI returned no content — your document was not changed.');
        setAiLoading(false);
        return;
      }
      if (action === 'critique') { setCritiqueText(d.content); }
      else { setVal(d.content); }
    } catch (e) { aiCrash(e); }
    setAiLoading(false);
  };

  // ── AI: Generate ───────────────────────────────────────────────────────────

  const toggleGenerate = () => {
    setGenerateOpen(o => {
      if (!o) setTimeout(() => generateInputRef.current?.focus(), 80);
      return !o;
    });
  };

  const generate = async () => {
    const p = generatePrompt.trim();
    if (!p) return;
    setGenerateOpen(false);
    setGeneratePrompt('');
    setAiLoading(true);
    try {
      const r = await fetch('/api/writer/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: p, mode: writeMode, draft: content, tone: generateTone, length: generateLength }) });
      const d = await r.json();
      if (aiFail(d, r)) { setAiLoading(false); return; }
      if (d.content) { setVal(d.content); setPreview(true); }
      else showToast('AI returned no content.');
    } catch (e) { aiCrash(e); }
    setAiLoading(false);
  };

  const continueWriting = async () => {
    if (!content.trim()) return;
    setAiLoading(true);
    try {
      const r = await fetch('/api/writer/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'continue', draft: content }) });
      const d = await r.json();
      if (aiFail(d, r)) { setAiLoading(false); return; }
      if (d.content) { setVal(content + '\n\n' + d.content); setPreview(true); }
      else showToast('AI returned no continuation.');
    } catch (e) { aiCrash(e); }
    setAiLoading(false);
  };

  const styleCheck = async () => {
    if (!content.trim()) return;
    setAiLoading(true);
    try {
      const r = await fetch('/api/writer/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'stylecheck', draft: content, prompt: content }) });
      const d = await r.json();
      if (aiFail(d, r)) { setAiLoading(false); return; }
      if (d.content) setCritiqueText(d.content);
      else showToast('Style check returned no feedback.');
    } catch (e) { aiCrash(e); }
    setAiLoading(false);
  };

  // ── Writing DNA ────────────────────────────────────────────────────────────

  const analyzeStyle = async () => {
    setAiLoading(true);
    try {
      const r = await fetch('/api/writer/style/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const d = await r.json();
      if (aiFail(d, r)) { setAiLoading(false); return; }
      if (d.profile) { setStyleProfile(d.profile); showToast('Writing DNA updated.'); }
      else showToast('Style analysis returned no profile — nothing was changed.');
    } catch (e) { aiCrash(e); }
    setAiLoading(false);
  };

  // ── Co-Write ───────────────────────────────────────────────────────────────

  const sendCowrite = async (text) => {
    const msg = text || cowriteInput.trim();
    if (!msg) return;
    setCowriteInput('');
    const newHistory = [...cowriteHistory, { role: 'user', content: msg }];
    setCowriteHistory(newHistory);
    setCowriteLoading(true);

    const apiHistory = [];
    for (let i = 0; i < newHistory.length - 1; i += 2) {
      const u = newHistory[i], a = newHistory[i + 1];
      if (u && a) apiHistory.push({ q: u.content, a: a.content });
    }

    try {
      const r = await fetch('/api/writer/cowrite', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: msg, draft: content, history: apiHistory }) });
      const d = await r.json();
      setCowriteHistory(prev => [...prev, { role: 'ai', content: d.response || d.error || 'No response' }]);
    } catch (e) {
      setCowriteHistory(prev => [...prev, { role: 'ai', content: 'Error: ' + e.message }]);
    }
    setCowriteLoading(false);
  };

  const insertCowriteAt = (text) => {
    const el = editorRef.current;
    if (!el) { setVal(content + '\n\n' + text); return; }
    const s = el.selectionStart;
    const before = content.slice(0, s);
    const after = content.slice(s);
    const gap = before && !before.endsWith('\n') ? '\n\n' : '';
    setVal(before + gap + text + '\n\n' + after);
  };

  // ── Push to Memory Core ────────────────────────────────────────────────────
  // The toast reports what the route actually did. It used to read `d.ok`,
  // which the route set unconditionally — so "✓ Saved to Memory" appeared
  // whether the write happened, threw, or was skipped entirely.

  const pushToMemory = async () => {
    if (!activeId) { showToast('Save document first'); return; }
    try {
      const r = await fetch(`/api/writer/doc/${activeId}/to-memory`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d?.ok) { showToast(d?.error || `✗ Memory Core save failed (${r.status})`); return; }
      if (d.deduped) showToast('✓ Already in Memory Core');
      else showToast(d.truncated ? '✓ Saved to Memory Core (long draft trimmed)' : '✓ Saved to Memory Core');
    } catch (e) { showToast(`✗ Memory Core unreachable: ${e?.message || 'network error'}`); }
  };

  // ── Export ──────────────────────────────────────────────────────────────────

  const exportDoc = (format) => {
    if (format === 'print') { window.print(); return; }
    const blob = format === 'html'
      ? new Blob([`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font-family:Georgia,serif;max-width:760px;margin:60px auto;color:#1a1a1a;line-height:1.8;font-size:16px;padding:0 20px}h1{font-size:28px}h2{font-size:22px}code{background:#f4f4f4;padding:2px 6px;border-radius:3px}@media print{body{margin:20px}}</style></head><body><h1>${title}</h1><div style="color:#666;font-size:13px;margin-bottom:40px">Exported from AEON — ${new Date().toLocaleDateString()}</div>${content}</body></html>`], { type: 'text/html' })
      : new Blob([`# ${title}\n\n${content}`], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `${title.replace(/[^a-z0-9]/gi, '_')}.${format === 'html' ? 'html' : 'md'}`; a.click();
    URL.revokeObjectURL(url);
  };

  const handleKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveDoc(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'b') { e.preventDefault(); insertMarkdown('**', '**'); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'i') { e.preventDefault(); insertMarkdown('*', '*'); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); setFindOpen(true); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); setFocusMode(f => !f); }
    if (e.key === 'Escape' && focusMode) setFocusMode(false);
  };

  const QUICK_PROMPTS = ['Spell check', 'Flag weak words', 'Grammar check', 'Weakest part?', 'What next?'];

  return (
    <div className={`writer-root ${focusMode ? 'writer-root--focus' : ''}`} onKeyDown={handleKey}>
      {/* ── Sidebar: Documents ──────────────────────────────────────────── */}
      <div className="writer-sidebar writer-chrome">
        <div className="writer-sidebar-head">
          <FileText size={14} color="var(--accent)" /> <span>Documents</span>
          <button className="writer-btn-icon" onClick={() => setTemplatesOpen(true)} title="New document" aria-label="New document"><Plus size={13} /></button>
        </div>
        {docs.map(d => (
          <div key={d.id} className={`writer-doc-item ${activeId === d.id ? 'writer-doc-item--active' : ''}`} onClick={() => openDoc(d.id)}>
            <span className="writer-doc-title">{d.title}</span>
            <span className="writer-doc-meta">{Math.ceil((d.size || 0) / 100) / 10}k</span>
            <button className="writer-doc-del" onClick={e => { e.stopPropagation(); deleteDoc(d.id); }}><Trash2 size={11} /></button>
          </div>
        ))}
        {docs.length === 0 && <div className="writer-empty">No documents yet</div>}
      </div>

      {/* ── Main Editor ─────────────────────────────────────────────────── */}
      <div className="writer-main">
        {/* Top bar: mode + DNA + actions */}
        <div className="writer-topbar">
          <div className="writer-mode-pill">
            <button className={writeMode === 'write' ? 'active' : ''} onClick={() => setWriteMode('write')}>Write</button>
            <button className={writeMode === 'braindump' ? 'active' : ''} onClick={() => setWriteMode('braindump')}>Brain Dump</button>
          </div>
          <button className={`writer-dna-badge ${styleProfile ? 'has-dna' : ''}`}
            onClick={() => { if (styleProfile) { if (confirm(`Writing DNA\n\n${styleProfile.summary}\n\nTraits: ${styleProfile.traits.join(', ')}\nFormality: ${styleProfile.formality}\n\nRe-analyze?`)) analyzeStyle(); } else { analyzeStyle(); } }}>
            <Dna size={12} /> {styleProfile ? 'Style DNA' : 'No DNA'}
          </button>
          <span className="writer-tb-sep" />
          <button className="writer-tb" onClick={() => setCowriteOpen(!cowriteOpen)} title="Co-Write Sidebar">
            <MessageSquare size={13} /> Co-Write
          </button>
        </div>

        {/* Toolbar */}
        <div className="writer-toolbar">
          <div className="writer-toolbar-left">
            <button className={`writer-tb ${!preview ? 'writer-tb--active' : ''}`} onClick={() => { setPreview(false); setTimeout(() => editorRef.current?.focus(), 0); }} title="Edit"><Edit3 size={13} /></button>
            <button className={`writer-tb ${preview ? 'writer-tb--active' : ''}`} onClick={() => setPreview(true)} title="Preview"><Eye size={13} /></button>
            <span className="writer-tb-sep" />
            <button className="writer-tb" onClick={() => insertMarkdown('**', '**')} title="Bold"><Bold size={13} /></button>
            <button className="writer-tb" onClick={() => insertMarkdown('*', '*')} title="Italic"><Italic size={13} /></button>
            <button className="writer-tb" onClick={() => insertMarkdown('~~', '~~')} title="Strikethrough"><Strikethrough size={13} /></button>
            <span className="writer-tb-sep" />
            <button className="writer-tb" onClick={() => insertMarkdown('## ')} title="Heading"><Heading size={13} /></button>
            <button className="writer-tb" onClick={() => insertMarkdown('1. ')} title="List"><List size={13} /></button>
            <button className="writer-tb" onClick={() => insertMarkdown('[', '](url)')} title="Link"><Link size={13} /></button>
            <button className="writer-tb" onClick={() => insertMarkdown('---\n')} title="Divider"><Minus size={13} /></button>
            <span className="writer-tb-sep" />
            <button className="writer-tb" onClick={undo} disabled={undoStack.length === 0} title="Undo (Ctrl+Z)">Undo</button>
            <button className="writer-tb" onClick={redo} disabled={redoStack.length === 0} title="Redo (Ctrl+Shift+Z)">Redo</button>
            <span className="writer-tb-sep" />
            <button className={`writer-tb ${outlineOpen ? 'writer-tb--active' : ''}`} onClick={() => setOutlineOpen(o => !o)} title="Outline">☰ Outline</button>
            <button className={`writer-tb ${findOpen ? 'writer-tb--active' : ''}`} onClick={() => setFindOpen(o => !o)} title="Find & replace (Ctrl+F)">🔍 Find</button>
            <button className="writer-tb" onClick={() => setFocusMode(true)} title="Focus mode (Ctrl+Enter) — Esc to exit">◎ Focus</button>
            <button className={`writer-tb ${historyOpen ? 'writer-tb--active' : ''}`} disabled={!activeId}
              onClick={() => { const next = !historyOpen; setHistoryOpen(next); setVersionPreview(null); if (next) loadVersions(activeId); }}
              title="Version history">⏱ History</button>
          </div>
          <div className="writer-toolbar-right">
            <button className={`writer-tb writer-tb--gen ${generateOpen ? 'writer-tb--active' : ''}`} onClick={toggleGenerate} disabled={aiLoading}>
              <Wand2 size={13} /> Generate
            </button>
            <button className="writer-tb" onClick={continueWriting} disabled={aiLoading || !content.trim()} title="Continue writing">
              <ArrowDown size={13} /> Continue
            </button>
            <button className="writer-tb" onClick={styleCheck} disabled={aiLoading || !content.trim() || !styleProfile} title="Check against your Writing DNA">
              <Search size={13} /> Style Check
            </button>
            <span className="writer-tb-sep" />
            <div style={{ position: 'relative' }}>
              <button className={`writer-tb writer-tb--ai ${aiLoading ? 'writer-tb--spin' : ''}`} onClick={() => setAiMenu(!aiMenu)}>
                <Sparkles size={13} /> Edit <ChevronDown size={10} />
              </button>
              {aiMenu && (
                <div className="writer-ai-menu">
                  {IMPROVE_ACTIONS.map(a => (
                    <button key={a.id} className="writer-ai-item" onClick={() => improve(a.id)}>
                      <span>{a.icon}</span> {a.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Generate bar */}
        {generateOpen && (
          <div className="writer-genbar">
            <textarea
              ref={generateInputRef}
              className="writer-genbar-input"
              value={generatePrompt}
              onChange={e => setGeneratePrompt(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); generate(); } if (e.key === 'Escape') setGenerateOpen(false); }}
              placeholder={writeMode === 'braindump' ? 'Paste your brain dump — AEON will reshape it into prose...' : 'What would you like to write?'}
              rows={2}
            />
            <div className="writer-genbar-opts">
              <select className="writer-genbar-sel" value={generateTone} onChange={e => setGenerateTone(e.target.value)}>
                <option value="clear and professional">Professional</option>
                <option value="casual and conversational">Casual</option>
                <option value="academic and formal">Academic</option>
                <option value="persuasive">Persuasive</option>
                <option value="creative and expressive">Creative</option>
              </select>
              <select className="writer-genbar-sel" value={generateLength} onChange={e => setGenerateLength(e.target.value)}>
                <option value="short">Short</option>
                <option value="medium">Medium</option>
                <option value="long">Long</option>
              </select>
              <button className="writer-btn-primary" onClick={generate} disabled={aiLoading || !generatePrompt.trim()}>
                <Wand2 size={12} /> {aiLoading ? 'Writing...' : 'Generate'}
              </button>
              <button className="writer-btn-sm" onClick={() => setGenerateOpen(false)}><X size={12} /></button>
            </div>
          </div>
        )}

        {/* Title */}
        <input className="writer-title-input" value={title} onChange={e => { setTitle(e.target.value); setDirty(true); }} placeholder="Document title" />

        {writeMode === 'braindump' && <div className="writer-braindump-hint">Paste raw thoughts — AEON reshapes them into prose matching your voice.</div>}

        {/* Find & replace */}
        {findOpen && (
          <div className="writer-findbar writer-chrome">
            <input className="writer-find-input" placeholder="Find…" value={findText} autoFocus
              aria-label="Find text"
              onChange={e => setFindText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') findNext(); if (e.key === 'Escape') setFindOpen(false); }} />
            <input className="writer-find-input" placeholder="Replace with…" value={replaceText}
              aria-label="Replace with"
              onChange={e => setReplaceText(e.target.value)} />
            <span className="writer-find-count">{findText ? `${findCount} found` : ''}</span>
            <button className="writer-btn-sm" onClick={findNext} disabled={!findCount}>Next</button>
            <button className="writer-btn-sm" onClick={replaceAll} disabled={!findCount}>Replace all</button>
            <button className="writer-btn-sm" onClick={() => setFindOpen(false)} aria-label="Close find bar">✕</button>
          </div>
        )}

        {/* Editor / Preview */}
        <div className="writer-body-wrap">
          {/* Outline rail */}
          {outlineOpen && !focusMode && (
            <nav className="writer-outline writer-chrome" aria-label="Document outline">
              <div className="writer-outline-head">Outline</div>
              {outline.length === 0 && <div className="writer-empty">Add # headings to build an outline</div>}
              {outline.map((h, i) => (
                <button key={i} className="writer-outline-item" style={{ paddingLeft: 8 + (h.level - 1) * 14 }}
                  onClick={() => jumpTo(h.offset)}>
                  {h.text}
                </button>
              ))}
            </nav>
          )}
          <div className="writer-editor-col">
            {preview ? (
              <div className="writer-preview"><ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown></div>
            ) : (
              <textarea ref={editorRef} className="writer-editor" value={content}
                onChange={e => { pushUndo(content); setContent(e.target.value); setDirty(true); }}
                placeholder={writeMode === 'braindump' ? 'Paste your brain dump here...' : 'Start typing or use Generate above...'}
                spellCheck={false} />
            )}
            <div className="writer-word-count">{wordCount} word{wordCount !== 1 ? 's' : ''}</div>
          </div>

          {/* Version history panel */}
          {historyOpen && !focusMode && (
            <div className="writer-history writer-chrome">
              <div className="cowrite-header">
                <span>⏱ History</span>
                <button className="writer-btn-sm" onClick={() => { setHistoryOpen(false); setVersionPreview(null); }} aria-label="Close history">✕</button>
              </div>
              <div className="writer-history-list">
                {versions.length === 0 && <div className="writer-empty">No versions yet — every save keeps the copy it replaces.</div>}
                {versions.map(v => (
                  <div key={v.ts} className={`writer-history-item ${versionPreview?.ts === v.ts ? 'writer-history-item--active' : ''}`}>
                    <button className="writer-history-when" onClick={async () => {
                      const d = await fetch(`/api/writer/version/${activeId}/${v.ts}`).then(r => r.json());
                      setVersionPreview({ ts: v.ts, content: d.content || '' });
                    }}>
                      {new Date(v.ts).toLocaleString()} <span className="writer-doc-meta">{Math.round(v.size / 100) / 10}k</span>
                    </button>
                    <button className="writer-btn-sm" onClick={() => restoreVersion(v.ts)}>Restore</button>
                  </div>
                ))}
              </div>
              {versionPreview && (
                <div className="writer-history-preview">
                  <div className="writer-outline-head">Preview — {new Date(versionPreview.ts).toLocaleTimeString()}</div>
                  <pre>{versionPreview.content.slice(0, 4000)}</pre>
                </div>
              )}
            </div>
          )}

          {/* Co-Write Sidebar */}
          {cowriteOpen && (
            <div className="cowrite-panel">
              <div className="cowrite-header">
                <span>🤝 Co-Write</span>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <button className="writer-btn-sm" onClick={() => setCowriteHistory([])}>Clear</button>
                  <button className="writer-btn-sm" onClick={() => setCowriteOpen(false)}>✕</button>
                </div>
              </div>
              <div className="cowrite-msgs">
                {cowriteHistory.length === 0 && (
                  <div className="cowrite-empty">Your editorial assistant — flags spelling, grammar, weak words, and structure. Use the quick prompts below, or ask anything. Say "rewrite" only when you want a full pass.</div>
                )}
                {cowriteHistory.map((m, i) => (
                  <div key={i} className={`cowrite-msg ${m.role === 'user' ? 'cowrite-msg--user' : 'cowrite-msg--ai'}`}>
                    <div style={{ whiteSpace: 'pre-wrap' }}>{m.content}</div>
                    {m.role === 'ai' && (
                      <button className="cowrite-insert" onClick={() => insertCowriteAt(m.content)}>Insert at cursor</button>
                    )}
                  </div>
                ))}
                {cowriteLoading && <div className="cowrite-msg cowrite-msg--ai" style={{ opacity: 0.5 }}>Thinking...</div>}
              </div>
              <div className="cowrite-quick">
                {QUICK_PROMPTS.map(p => (
                  <button key={p} className="cowrite-qp" onClick={() => sendCowrite(p)}>{p}</button>
                ))}
              </div>
              <div className="cowrite-input-row">
                <textarea className="cowrite-input" value={cowriteInput}
                  onChange={e => setCowriteInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCowrite(); } }}
                  placeholder="Ask anything..." rows={1} />
                <button className="writer-btn-primary-sm" onClick={() => sendCowrite()}>→</button>
              </div>
            </div>
          )}
        </div>

        {/* Critique panel */}
        {critiqueText && (
          <div className="writer-critique">
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
              <span style={{ fontSize: '11px', color: 'var(--accent)', letterSpacing: '1px', textTransform: 'uppercase' }}>Feedback</span>
              <button className="writer-btn-sm" onClick={() => setCritiqueText('')}>✕</button>
            </div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{critiqueText}</div>
          </div>
        )}

        {/* Footer */}
        <div className="writer-footer">
          {toast && <span className="writer-toast">{toast}</span>}
          <span className="writer-footer-info">
            {autosaving ? <span className="writer-autosave">saving…</span> : dirty && <span className="writer-dirty">unsaved</span>}
            <span>{wordCount} words</span>
            <span>{content.length.toLocaleString()} chars</span>
            <span>~{Math.max(1, Math.ceil(wordCount / 200))} min read</span>
            {styleProfile && <span style={{ color: 'var(--w-green)' }}>DNA active</span>}
          </span>
          <div className="writer-footer-actions">
            {activeId && <button className="writer-btn-sm" onClick={pushToMemory} title="Promote this draft into Memory Core"><BookOpen size={12} /> Memory</button>}
            <button className="writer-btn-sm" onClick={() => exportDoc('md')} title="Export MD"><Download size={12} /> MD</button>
            <button className="writer-btn-sm" onClick={() => exportDoc('html')} title="Export HTML"><Download size={12} /> HTML</button>
            {activeId && <button className="writer-btn-sm" title="Export Word (.doc)"
              onClick={async () => { if (dirty) await saveDoc(); window.location.assign(`/api/writer/export/${activeId}.doc`); }}>
              <Download size={12} /> Word</button>}
            <button className="writer-btn-sm" onClick={() => exportDoc('print')} title="Print/PDF"><Download size={12} /> PDF</button>
            <button className="writer-btn-sm" onClick={() => { navigator.clipboard.writeText(content); }} title="Copy"><Copy size={12} /> Copy</button>
            <button className="writer-btn-primary" onClick={saveDoc} disabled={saving}>
              <Save size={12} /> {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>

      {/* Focus mode exit — always visible, always clickable */}
      {focusMode && (
        <button className="writer-focus-exit" onClick={() => setFocusMode(false)} aria-label="Exit focus mode" title="Exit focus mode (Esc)">
          <X size={13} /> Exit focus
        </button>
      )}

      {/* Templates modal */}
      {templatesOpen && (
        <div className="writer-modal-backdrop" role="dialog" aria-label="New document" onClick={() => setTemplatesOpen(false)}>
          <div className="writer-modal" onClick={e => e.stopPropagation()}>
            <div className="cowrite-header"><span>New document</span>
              <button className="writer-btn-sm" onClick={() => setTemplatesOpen(false)} aria-label="Close">✕</button>
            </div>
            <div className="writer-template-grid">
              {(templates.length ? templates : [{ id: 'blank', icon: '📄', label: 'Blank document', content: '' }]).map(t => (
                <button key={t.id} className="writer-template-card" onClick={() => startFromTemplate(t)}>
                  <span className="writer-template-icon">{t.icon}</span>
                  <span>{t.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <style>{`
        /* ── Writer local tokens (override per-theme if needed) ── */
        .writer-root {
          --w-green: #22c55e;
          --w-green-bg: rgba(34,197,94,0.1);
          --w-green-border: rgba(34,197,94,0.25);
          --w-purple: #b388ff;
          --w-purple-bg: rgba(123,47,255,0.1);
          --w-purple-border: rgba(123,47,255,0.2);
          --w-editor-font: 'JetBrains Mono','Fira Code',monospace;
        }
        .writer-root { display: flex; height: 100%; overflow: hidden; }
        .writer-sidebar { width: 200px; flex-shrink: 0; border-right: 1px solid var(--border); display: flex; flex-direction: column; overflow-y: auto; padding: 8px; }
        .writer-sidebar-head { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: var(--text-dim); padding: 8px 6px; border-bottom: 1px solid var(--border); margin-bottom: 6px; }
        .writer-sidebar-head span { flex: 1; }
        .writer-btn-icon { background: none; border: none; color: var(--text-dim); cursor: pointer; padding: 3px; border-radius: 4px; }
        .writer-btn-icon:hover { color: var(--accent); background: var(--accent-dim); }
        .writer-doc-item { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 6px; cursor: pointer; transition: all 0.12s; }
        .writer-doc-item:hover { background: rgba(255,255,255,0.03); }
        .writer-doc-item--active { background: var(--accent-dim); }
        .writer-doc-title { flex: 1; font-size: 11px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .writer-doc-item--active .writer-doc-title { color: var(--accent); font-weight: 600; }
        .writer-doc-meta { font-size: 9px; color: var(--text-dim); }
        .writer-doc-del { background: none; border: none; color: var(--text-dim); cursor: pointer; padding: 2px; opacity: 0; transition: opacity 0.15s; }
        .writer-doc-item:hover .writer-doc-del { opacity: 1; }
        .writer-doc-del:hover { color: #ff4466; }
        .writer-empty { font-size: 11px; color: var(--text-dim); text-align: center; padding: 20px; }
        .writer-main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }

        .writer-topbar { display: flex; align-items: center; padding: 6px 12px; gap: 8px; border-bottom: 1px solid var(--border); }
        .writer-mode-pill { display: inline-flex; background: rgba(255,255,255,0.04); border: 1px solid var(--border); border-radius: 20px; overflow: hidden; }
        .writer-mode-pill button { padding: 4px 12px; font-size: 11px; background: transparent; border: none; color: var(--text-dim); cursor: pointer; }
        .writer-mode-pill button.active { background: var(--accent); color: #020508; }
        .writer-dna-badge { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 20px; font-size: 11px; border: 1px solid var(--border); background: transparent; color: var(--text-dim); cursor: pointer; }
        .writer-dna-badge.has-dna { border-color: var(--w-green-border); background: var(--w-green-bg); color: var(--w-green); }
        .writer-braindump-hint { font-size: 11px; color: var(--text-dim); padding: 4px 20px; }

        .writer-toolbar { display: flex; align-items: center; padding: 6px 12px; border-bottom: 1px solid var(--border); gap: 2px; flex-wrap: wrap; }
        .writer-toolbar-left { display: flex; align-items: center; gap: 2px; flex: 1; flex-wrap: wrap; }
        .writer-toolbar-right { display: flex; gap: 4px; flex-wrap: wrap; }
        .writer-tb { background: none; border: none; color: var(--text-dim); cursor: pointer; padding: 5px 7px; border-radius: 5px; transition: all 0.12s; display: flex; align-items: center; gap: 4px; font-size: 11px; white-space: nowrap; }
        .writer-tb:hover { background: rgba(255,255,255,0.05); color: var(--text); }
        .writer-tb:disabled { opacity: 0.3; cursor: default; }
        .writer-tb--active { background: var(--accent-dim); color: var(--accent); }
        .writer-tb--ai { background: var(--w-purple-bg); color: var(--w-purple); border: 1px solid var(--w-purple-border); }
        .writer-tb--ai:hover { background: rgba(123,47,255,0.2); }
        .writer-tb--gen { background: var(--w-green-bg); color: var(--w-green); border: 1px solid var(--w-green-border); }
        .writer-tb--gen:hover { background: rgba(34,197,94,0.2); }
        .writer-tb--spin { opacity: 0.6; }
        .writer-tb-sep { width: 1px; height: 16px; background: var(--border); margin: 0 4px; flex-shrink: 0; }
        .writer-ai-menu { position: absolute; top: 100%; right: 0; background: rgba(8,12,22,0.97); border: 1px solid var(--border-hi); border-radius: 8px; z-index: 50; box-shadow: 0 8px 24px rgba(0,0,0,0.5); overflow: hidden; min-width: 160px; }
        .writer-ai-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 12px; border: none; background: none; color: var(--text); font-size: 12px; cursor: pointer; transition: background 0.1s; }
        .writer-ai-item:hover { background: var(--accent-dim); }
        .writer-title-input { border: none; background: transparent; font-size: 20px; font-weight: 700; color: var(--text); padding: 16px 20px 8px; outline: none; }
        .writer-title-input::placeholder { color: var(--text-dim); }

        .writer-body-wrap { flex: 1; display: flex; min-height: 0; overflow: hidden; }
        .writer-editor-col { flex: 1; display: flex; flex-direction: column; position: relative; min-width: 0; }
        .writer-editor { flex: 1; border: none; background: transparent; color: var(--text); font-family: var(--w-editor-font); font-size: 13px; line-height: 1.7; padding: 12px 20px; resize: none; outline: none; overflow-y: auto; tab-size: 2; }
        .writer-preview { flex: 1; padding: 12px 20px; overflow-y: auto; color: var(--text); font-size: 14px; line-height: 1.7; }
        .writer-preview h1,.writer-preview h2,.writer-preview h3 { color: var(--text); margin: 20px 0 8px; }
        .writer-preview h1 { font-size: 1.5em; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
        .writer-preview h2 { font-size: 1.25em; color: var(--accent); }
        .writer-preview code { background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
        .writer-preview ul,.writer-preview ol { padding-left: 24px; }
        .writer-preview blockquote { border-left: 3px solid var(--accent); margin: 12px 0; padding: 4px 16px; color: var(--text-dim); }
        .writer-word-count { position: absolute; bottom: 8px; right: 12px; font-size: 10px; color: var(--text-dim); pointer-events: none; }

        .writer-critique { background: rgba(255,255,255,0.03); border: 1px solid var(--border); border-radius: 8px; margin: 0 12px; padding: 14px; font-size: 13px; color: var(--text-dim); line-height: 1.7; max-height: 200px; overflow-y: auto; }

        .writer-footer { display: flex; align-items: center; justify-content: space-between; padding: 6px 12px; border-top: 1px solid var(--border); flex-wrap: wrap; gap: 6px; }
        .writer-footer-info { display: flex; gap: 10px; font-size: 10px; color: var(--text-dim); }
        .writer-dirty { color: #ffaa00; }
        .writer-autosave { color: var(--text-dim); font-style: italic; }
        .writer-toast { padding: 3px 10px; border-radius: 5px; background: rgba(255,255,255,0.08); border: 1px solid var(--border); font-size: 10px; color: var(--text); }
        .writer-footer-actions { display: flex; gap: 6px; flex-wrap: wrap; }
        .writer-btn-sm { display: flex; align-items: center; gap: 4px; padding: 4px 10px; font-size: 10px; border-radius: 5px; border: 1px solid var(--border); background: rgba(255,255,255,0.02); color: var(--text-dim); cursor: pointer; }
        .writer-btn-sm:hover { color: var(--text); border-color: var(--border-hi); }
        .writer-btn-primary { display: flex; align-items: center; gap: 4px; padding: 5px 14px; font-size: 11px; font-weight: 600; border-radius: 6px; border: none; background: var(--accent); color: var(--bg, #020508); cursor: pointer; }
        .writer-btn-primary:disabled { opacity: 0.4; }
        .writer-btn-primary-sm { padding: 5px 10px; font-size: 12px; font-weight: 600; border-radius: 6px; border: none; background: var(--accent); color: var(--bg, #020508); cursor: pointer; }

        /* Generate Bar */
        .writer-genbar { border-bottom: 1px solid var(--border); background: rgba(34,197,94,0.04); padding: 10px 14px; display: flex; flex-direction: column; gap: 8px; }
        .writer-genbar-input { background: rgba(255,255,255,0.04); border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px; color: var(--text); font-size: 13px; font-family: inherit; resize: none; outline: none; width: 100%; box-sizing: border-box; }
        .writer-genbar-input:focus { border-color: var(--w-green); }
        .writer-genbar-opts { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
        .writer-genbar-sel { background: rgba(255,255,255,0.04); border: 1px solid var(--border); border-radius: 5px; padding: 4px 8px; color: var(--text-dim); font-size: 11px; outline: none; cursor: pointer; }
        .writer-genbar-sel:focus { border-color: var(--w-green); }

        /* Co-Write Panel */
        .cowrite-panel { width: 300px; flex-shrink: 0; border-left: 1px solid var(--border); display: flex; flex-direction: column; }
        .cowrite-header { padding: 10px 14px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
        .cowrite-header span { font-size: 13px; font-weight: 600; color: var(--text); }
        .cowrite-msgs { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
        .cowrite-empty { font-size: 12px; color: var(--text-dim); text-align: center; margin-top: 20px; }
        .cowrite-msg { padding: 10px 12px; border-radius: 8px; font-size: 13px; line-height: 1.6; }
        .cowrite-msg--user { background: rgba(255,255,255,0.05); color: var(--text); align-self: flex-end; max-width: 90%; }
        .cowrite-msg--ai { background: transparent; border: 1px solid var(--border); color: var(--text-dim); align-self: flex-start; max-width: 95%; }
        .cowrite-insert { margin-top: 8px; display: inline-block; padding: 3px 8px; font-size: 11px; border-radius: 5px; border: 1px solid var(--accent); color: var(--accent); cursor: pointer; background: transparent; }
        .cowrite-insert:hover { background: var(--accent); color: #020508; }
        .cowrite-quick { padding: 4px 10px; display: flex; gap: 5px; flex-wrap: wrap; }
        .cowrite-qp { padding: 3px 8px; font-size: 11px; border-radius: 20px; border: 1px solid var(--border); background: transparent; color: var(--text-dim); cursor: pointer; white-space: nowrap; }
        .cowrite-qp:hover { border-color: var(--accent); color: var(--accent); }
        .cowrite-input-row { padding: 10px; border-top: 1px solid var(--border); display: flex; gap: 6px; }
        .cowrite-input { flex: 1; background: rgba(255,255,255,0.03); border: 1px solid var(--border); border-radius: 6px; padding: 7px 10px; color: var(--text); font-size: 13px; font-family: inherit; resize: none; outline: none; min-height: 36px; max-height: 100px; }
        .cowrite-input:focus { border-color: var(--accent); }

        /* ── Writer 2.0 ── */
        .writer-findbar { display: flex; align-items: center; gap: 6px; padding: 6px 14px; border-bottom: 1px solid var(--border); background: rgba(0,242,255,0.03); flex-wrap: wrap; }
        .writer-find-input { background: rgba(255,255,255,0.04); border: 1px solid var(--border); border-radius: 5px; padding: 5px 10px; color: var(--text); font-size: 12px; outline: none; width: 180px; }
        .writer-find-input:focus { border-color: var(--accent); }
        .writer-find-count { font-size: 10px; color: var(--text-dim); min-width: 60px; }

        .writer-outline { width: 190px; flex-shrink: 0; border-right: 1px solid var(--border); overflow-y: auto; padding: 8px 4px; }
        .writer-outline-head { font-size: 10px; letter-spacing: 1px; text-transform: uppercase; color: var(--text-dim); padding: 4px 8px 8px; }
        .writer-outline-item { display: block; width: 100%; text-align: left; background: none; border: none; color: var(--text-dim); font-size: 11.5px; padding: 4px 8px; border-radius: 5px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .writer-outline-item:hover { color: var(--accent); background: var(--accent-dim); }

        .writer-history { width: 290px; flex-shrink: 0; border-left: 1px solid var(--border); display: flex; flex-direction: column; overflow: hidden; }
        .writer-history-list { overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 4px; }
        .writer-history-item { display: flex; align-items: center; gap: 6px; }
        .writer-history-item--active .writer-history-when { color: var(--accent); }
        .writer-history-when { flex: 1; text-align: left; background: none; border: 1px solid var(--border); border-radius: 5px; padding: 6px 8px; color: var(--text-dim); font-size: 11px; cursor: pointer; }
        .writer-history-when:hover { border-color: var(--accent); }
        .writer-history-preview { border-top: 1px solid var(--border); overflow-y: auto; max-height: 40%; padding: 8px; }
        .writer-history-preview pre { white-space: pre-wrap; font-size: 11px; color: var(--text-dim); font-family: var(--w-editor-font); }

        .writer-modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.65); z-index: 90; display: flex; align-items: center; justify-content: center; }
        .writer-modal { background: rgba(8,12,22,0.98); border: 1px solid var(--border-hi); border-radius: 12px; width: min(560px, 92vw); max-height: 80vh; overflow-y: auto; box-shadow: 0 12px 40px rgba(0,0,0,0.6); }
        .writer-template-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; padding: 14px; }
        .writer-template-card { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 18px 10px; border: 1px solid var(--border); border-radius: 10px; background: rgba(255,255,255,0.02); color: var(--text); font-size: 12px; cursor: pointer; transition: all 0.12s; }
        .writer-template-card:hover { border-color: var(--accent); background: var(--accent-dim); }
        .writer-template-icon { font-size: 26px; }

        .writer-root--focus .writer-sidebar, .writer-root--focus .writer-topbar,
        .writer-root--focus .writer-toolbar, .writer-root--focus .writer-footer,
        .writer-root--focus .cowrite-panel, .writer-root--focus .writer-findbar,
        .writer-root--focus .writer-outline, .writer-root--focus .writer-history,
        .writer-root--focus .writer-genbar, .writer-root--focus .writer-critique { display: none !important; }
        .writer-root--focus .writer-title-input { max-width: 720px; margin: 24px auto 0; width: 100%; }
        .writer-root--focus .writer-editor, .writer-root--focus .writer-preview { max-width: 720px; margin: 0 auto; width: 100%; font-size: 16px; line-height: 1.9; }
        .writer-focus-exit { position: fixed; top: 16px; right: 20px; z-index: 96; display: inline-flex; align-items: center; gap: 6px; background: var(--accent); border: 1px solid var(--accent); color: #020508; font-size: 12px; font-weight: 700; padding: 7px 14px; border-radius: 20px; cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,0.4); }
        .writer-focus-exit:hover { filter: brightness(1.1); }
        .writer-focus-exit:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }

        @media print {
          .writer-sidebar, .writer-topbar, .writer-toolbar, .writer-footer,
          .writer-title-input, .writer-word-count, .cowrite-panel, .writer-critique { display: none !important; }
          .writer-root { display: block !important; }
          .writer-editor { font-size: 12pt; line-height: 1.8; height: auto !important; overflow: visible !important; }
        }
      `}</style>
    </div>
  );
}
