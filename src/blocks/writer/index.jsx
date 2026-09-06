import React, { useState, useEffect, useCallback, useRef } from 'react';
import { FileText, Plus, Trash2, Save, Download, Eye, Edit3, Bold, Italic, Strikethrough, Heading, List, Link, Minus, Copy, Sparkles, X, ChevronDown, MessageSquare, Dna, Wand2, ArrowDown, Search, BookOpen,
  Underline, ListOrdered, AlignLeft, AlignCenter, AlignRight, IndentDecrease, IndentIncrease,
  Unlink, Eraser, Baseline, Highlighter, Undo2, Redo2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Paragraph styles. formatBlock takes an angle-bracketed tag; the bare form is
// ignored by Firefox, so every call site wraps it.
const PARA_STYLES = [
  { tag: 'p',          label: 'Normal text' },
  { tag: 'h1',         label: 'Title' },
  { tag: 'h2',         label: 'Heading 1' },
  { tag: 'h3',         label: 'Heading 2' },
  { tag: 'blockquote', label: 'Quote' },
  { tag: 'pre',        label: 'Code block' },
];

const FONTS = [
  { css: 'Inter',           label: 'Inter (Sans)' },
  { css: 'Space Grotesk',   label: 'Space Grotesk' },
  { css: 'Georgia',         label: 'Georgia (Serif)' },
  { css: 'Times New Roman', label: 'Times New Roman' },
  { css: 'Arial',           label: 'Arial' },
  { css: 'JetBrains Mono',  label: 'JetBrains Mono' },
  { css: 'Courier New',     label: 'Courier New' },
];

const SWATCHES = [
  '#ffffff', '#dce8f5', '#9aa3b2', '#00f2ff', '#22c55e', '#b388ff',
  '#f59e0b', '#f85149', '#ec4899', '#14b8a6', '#3b82f6', '#a3e635',
];

const HIGHLIGHTS = [
  'rgba(0,242,255,0.28)', 'rgba(34,197,94,0.28)', 'rgba(245,158,11,0.30)',
  'rgba(248,81,73,0.28)', 'rgba(179,136,255,0.30)', 'rgba(236,72,153,0.28)',
];

// ── Legacy corpus bridge ────────────────────────────────────────────────────
// Documents written before the WYSIWYG switch are markdown. Assigning them to
// innerHTML renders their ##, **bold** and 1. as literal visible characters, so
// anything without tags is converted on open and re-saved in the new form.
const looksLikeHtml = (s) => /<(p|div|h[1-6]|ul|ol|li|br|span|b|i|u|s|strong|em|blockquote|hr|a|pre|table)\b/i.test(s || '');

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function markdownToHtml(md) {
  if (!md) return '';
  const lines = md.split('\n');
  const out = [];
  let inList = null; // 'ul' | 'ol'
  const closeList = () => { if (inList) { out.push(`</${inList}>`); inList = null; } };
  const inline = (t) => escapeHtml(t)
    .replace(/\*\*\*(.+?)\*\*\*/g, '<b><i>$1</i></b>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*]+?)\*/g, '$1<i>$2</i>')
    .replace(/~~(.+?)~~/g, '<s>$1</s>')
    .replace(/`([^`]+?)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { closeList(); out.push('<hr>'); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); const n = h[1].length; out.push(`<h${n}>${inline(h[2])}</h${n}>`); continue; }
    const q = line.match(/^>\s?(.*)$/);
    if (q) { closeList(); out.push(`<blockquote>${inline(q[1])}</blockquote>`); continue; }
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) { if (inList !== 'ul') { closeList(); out.push('<ul>'); inList = 'ul'; } out.push(`<li>${inline(ul[1])}</li>`); continue; }
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) { if (inList !== 'ol') { closeList(); out.push('<ol>'); inList = 'ol'; } out.push(`<li>${inline(ol[1])}</li>`); continue; }
    if (line.trim() === '') { closeList(); continue; }
    closeList(); out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}

// Anything assigned to innerHTML passes through here first. Once the AI prompts
// ask for HTML we are deliberately requesting markup from a remote model and
// injecting it, so an allowlist is not optional.
const ALLOWED_TAGS = new Set(['P','DIV','BR','SPAN','B','STRONG','I','EM','U','S','STRIKE','H1','H2','H3','H4','H5','H6','UL','OL','LI','A','BLOCKQUOTE','HR','CODE','PRE','FONT','TABLE','THEAD','TBODY','TR','TD','TH']);

function sanitizeHtml(html) {
  if (!html) return '';
  let doc;
  try { doc = new DOMParser().parseFromString(String(html), 'text/html'); } catch { return ''; }
  const walk = (node) => {
    for (const child of [...node.children]) {
      if (!ALLOWED_TAGS.has(child.tagName)) { child.replaceWith(...child.childNodes); continue; }
      for (const attr of [...child.attributes]) {
        const n = attr.name.toLowerCase();
        if (n === 'style') {
          if (/url\s*\(|expression|javascript:/i.test(attr.value)) child.removeAttribute(attr.name);
        } else if (n === 'href') {
          if (!/^(https?:|mailto:|#|\/)/i.test(attr.value.trim())) child.removeAttribute(attr.name);
        } else if (n === 'size' || n === 'face' || n === 'color') {
          // legacy <font> attributes execCommand still emits — harmless
        } else {
          child.removeAttribute(attr.name); // strips every on* handler
        }
      }
      walk(child);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

// HTML → Markdown, for the .md export. Structure survives; colour, highlight,
// font and size do not — markdown has no syntax for them.
function htmlToMarkdown(html) {
  if (!html) return '';
  let doc;
  try { doc = new DOMParser().parseFromString(String(html), 'text/html'); } catch { return String(html); }
  const walk = (node) => {
    let out = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { out += n.textContent.replace(/ /g, ' '); continue; }
      if (n.nodeType !== 1) continue;
      const inner = walk(n);
      switch (n.tagName) {
        case 'H1': out += `\n# ${inner}\n\n`; break;
        case 'H2': out += `\n## ${inner}\n\n`; break;
        case 'H3': out += `\n### ${inner}\n\n`; break;
        case 'H4': case 'H5': case 'H6': out += `\n#### ${inner}\n\n`; break;
        case 'B': case 'STRONG': out += `**${inner}**`; break;
        case 'I': case 'EM': out += `*${inner}*`; break;
        case 'S': case 'STRIKE': out += `~~${inner}~~`; break;
        case 'CODE': out += `\`${inner}\``; break;
        case 'PRE': out += `\n\`\`\`\n${inner}\n\`\`\`\n\n`; break;
        case 'A': out += `[${inner}](${n.getAttribute('href') || ''})`; break;
        case 'BLOCKQUOTE': out += `\n> ${inner}\n\n`; break;
        case 'HR': out += `\n---\n\n`; break;
        case 'BR': out += `\n`; break;
        case 'LI': {
          const ordered = n.parentElement?.tagName === 'OL';
          const idx = [...(n.parentElement?.children || [])].indexOf(n) + 1;
          out += `${ordered ? idx + '.' : '-'} ${inner}\n`;
          break;
        }
        case 'UL': case 'OL': out += `\n${inner}\n`; break;
        case 'P': case 'DIV': out += `${inner}\n\n`; break;
        default: out += inner;
      }
    }
    return out;
  };
  return walk(doc.body).replace(/\n{3,}/g, '\n\n').trim();
}

// Visible text of an HTML string — for word/char counts, clipboard, and every
// payload sent to the AI or Memory Core.
const htmlToText = (html) => {
  if (!html) return '';
  try {
    const d = new DOMParser().parseFromString(String(html), 'text/html');
    return (d.body.textContent || '').replace(/ /g, ' ');
  } catch { return String(html).replace(/<[^>]*>/g, ' '); }
};

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
  // editorMode kept for toolbar-right AI buttons that gate on preview
  const editorMode = 'edit';
  const setEditorMode = () => {}; // no-op — WYSIWYG has no modes
  const preview = false;
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
  const [selLen, setSelLen] = useState(0); // unused now (WYSIWYG tracks its own selection)
  const [fontSize, setFontSize] = useState(16);
  const [fontFamily, setFontFamily] = useState('Inter');
  const [colorOpen, setColorOpen] = useState(null); // 'text' | 'highlight' | null

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

  // Outline: parse h1/h2/h3 elements from HTML content
  const outline = React.useMemo(() => {
    const items = [];
    const matches = [...content.matchAll(/<h([1-3])[^>]*>(.*?)<\/h[1-3]>/gi)];
    for (const m of matches) {
      const text = m[2].replace(/<[^>]*>/g, '').slice(0, 60);
      items.push({ level: parseInt(m[1]), text });
    }
    return items;
  }, [content]);

  const jumpTo = (text) => {
    const el = editorRef.current; if (!el) return;
    // Find heading node by text content and scroll to it
    const headings = el.querySelectorAll('h1,h2,h3');
    for (const h of headings) {
      if (h.textContent.slice(0, 60) === text) {
        h.scrollIntoView({ behavior: 'smooth', block: 'start' });
        break;
      }
    }
  };

  const findCount = React.useMemo(() => {
    if (!findText) return 0;
    return htmlToText(content).split(findText).length - 1;
  }, [content, findText]);

  const findNext = () => {
    if (!findText || !editorRef.current) return;
    // Use browser's native find on the contenteditable
    const sel = window.getSelection();
    const range = document.createRange();
    const walker = document.createTreeWalker(editorRef.current, NodeFilter.SHOW_TEXT);
    let node; let found = false;
    // Start after current selection end if possible
    const curNode = sel?.focusNode;
    let past = !curNode;
    while ((node = walker.nextNode())) {
      if (!past && node === curNode) { past = true; continue; }
      if (!past) continue;
      const idx = node.textContent.indexOf(findText);
      if (idx !== -1) {
        range.setStart(node, idx);
        range.setEnd(node, idx + findText.length);
        sel?.removeAllRanges(); sel?.addRange(range);
        range.startContainer.parentElement?.scrollIntoView({ block: 'center' });
        found = true; break;
      }
    }
    // Wrap: try from beginning
    if (!found) {
      const w2 = document.createTreeWalker(editorRef.current, NodeFilter.SHOW_TEXT);
      while ((node = w2.nextNode())) {
        const idx = node.textContent.indexOf(findText);
        if (idx !== -1) {
          range.setStart(node, idx); range.setEnd(node, idx + findText.length);
          sel?.removeAllRanges(); sel?.addRange(range);
          range.startContainer.parentElement?.scrollIntoView({ block: 'center' });
          break;
        }
      }
    }
  };

  const replaceAll = () => {
    if (!findText || findCount === 0 || !editorRef.current) return;
    // Walk TEXT NODES, never the markup string. A split/join over innerHTML
    // rewrites anything matching inside a tag or attribute — searching for
    // "center", "color", "span" or "14" would have silently mangled the
    // document's formatting or produced unparseable HTML.
    const walker = document.createTreeWalker(editorRef.current, NodeFilter.SHOW_TEXT);
    let n = 0, node;
    while ((node = walker.nextNode())) {
      if (node.textContent.includes(findText)) {
        n += node.textContent.split(findText).length - 1;
        node.textContent = node.textContent.split(findText).join(replaceText);
      }
    }
    syncContent();
    showToast(`Replaced ${n} occurrence${n !== 1 ? 's' : ''}`);
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
    // The built-in templates are all authored in markdown.
    const raw = t.content || '';
    const html = sanitizeHtml(looksLikeHtml(raw) ? raw : markdownToHtml(raw));
    setActiveId(null); setTitle(t.id === 'blank' ? 'Untitled' : t.label); setContent(html);
    setDirty(!!raw); setCritiqueText('');
    setUndoStack([]); setRedoStack([]); setTemplatesOpen(false);
    setTimeout(() => {
      const el = editorRef.current; if (!el) return;
      el.innerHTML = html;
      el.focus();
    }, 100);
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
      const raw = d.content || '';
      // Pre-WYSIWYG documents are markdown — convert so they don't render as
      // literal ## and **bold**, and mark dirty so autosave persists the upgrade.
      const migrated = raw && !looksLikeHtml(raw);
      const html = sanitizeHtml(migrated ? markdownToHtml(raw) : raw);
      setActiveId(id); setContent(html); setTitle(docs.find(x => x.id === id)?.title || 'Untitled');
      setDirty(migrated); setCritiqueText('');
      setUndoStack([]); setRedoStack([]);
      setTimeout(() => {
        const el = editorRef.current; if (!el) return;
        el.innerHTML = html;
        el.focus();
      }, 0);
      if (migrated) showToast('Document upgraded to rich text');
    } catch {}
  };

  const newDoc = () => {
    setActiveId(null); setContent(''); setTitle('Untitled'); setDirty(false);
    setCritiqueText(''); setUndoStack([]); setRedoStack([]);
    setTimeout(() => {
      const el = editorRef.current; if (!el) return;
      el.innerHTML = '';
      el.focus();
    }, 100);
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

  // This stack used to call setContent() and nothing else. React never writes
  // into the contenteditable (it has no children and no dangerouslySetInnerHTML),
  // so Undo changed state without changing the visible document, and autosave
  // then persisted the divergence. It has to write the DOM.
  //
  // The browser's own execCommand('undo') is not a safe substitute here: the
  // block assigns innerHTML directly in five places (open, new, template, AI
  // write, replace-all), and every such assignment desynchronises the native
  // history — undoing after an AI insert can restore an unrelated document.
  const applyHistory = (html) => {
    const el = editorRef.current;
    skipHistoryRef.current = true;
    setContent(html);
    setDirty(true);
    if (el) {
      el.innerHTML = html;
      el.focus();
      const range = document.createRange();
      const sel = window.getSelection();
      range.selectNodeContents(el); range.collapse(false);
      sel?.removeAllRanges(); sel?.addRange(range);
    }
    skipHistoryRef.current = false;
  };

  const undo = () => {
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1];
    setRedoStack(r => [...r, editorRef.current?.innerHTML ?? content]);
    setUndoStack(s => s.slice(0, -1));
    applyHistory(prev);
  };

  const redo = () => {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    setUndoStack(s => [...s, editorRef.current?.innerHTML ?? content]);
    setRedoStack(r => r.slice(0, -1));
    applyHistory(next);
  };

  // ── WYSIWYG helpers ────────────────────────────────────────────────────────
  // The editor is a contenteditable div. All formatting goes through
  // document.execCommand — the same path browsers use natively for ctrl+b, ctrl+i.
  // content state mirrors innerHTML for AI/save purposes; the ground truth is the DOM.

  // Typing coalesces into one undo step per pause, rather than one per keystroke.
  const typingSnapRef = useRef({ at: 0, html: null });

  const syncContent = () => {
    const el = editorRef.current; if (!el) return;
    const html = el.innerHTML;
    if (!skipHistoryRef.current) {
      const now = performance.now();
      const snap = typingSnapRef.current;
      if (snap.html === null || now - snap.at > 900) {
        if (snap.html !== null && snap.html !== html) pushUndo(snap.html);
        typingSnapRef.current = { at: now, html: content };
      }
    }
    setContent(html);
    setDirty(true);
  };

  const setVal = (v) => {
    // Every AI path funnels here. The models are asked for HTML but will
    // sometimes return markdown or a ```html fence anyway, so normalise both,
    // then run the allowlist before anything reaches innerHTML.
    let s = String(v ?? '').trim();
    s = s.replace(/^```(?:html|markdown|md)?\s*\n?/i, '').replace(/\n?```$/i, '');
    const html = sanitizeHtml(looksLikeHtml(s) ? s : markdownToHtml(s));
    pushUndo(content);
    setContent(html);
    setDirty(true);
    // Reflect in DOM on next tick
    setTimeout(() => {
      const el = editorRef.current;
      if (!el) return;
      el.innerHTML = html;
      // Move caret to end
      const range = document.createRange();
      const sel = window.getSelection();
      range.selectNodeContents(el);
      range.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(range);
      el.focus();
    }, 0);
  };

  // ── Formatting engine ──────────────────────────────────────────────────────
  // Every command runs through execFmt. Toolbar buttons fire it from onMouseDown
  // with preventDefault so the editor keeps focus and the selection stays alive —
  // a <button> that takes focus on mousedown collapses the selection first, which
  // is why Bold silently did nothing before.
  //
  // styleWithCSS(true) is set once on mount: without it browsers emit legacy
  // <font> tags that later CSS cannot override.

  // A native <select> or a colour input CANNOT be operated with preventDefault —
  // the user has to click into it, which blurs the editor and collapses the
  // selection, so execCommand would run against an empty range and format nothing.
  // The last in-editor range is therefore mirrored here and restored before every
  // command.
  const savedRangeRef = useRef(null);

  const restoreRange = () => {
    const el = editorRef.current;
    const r = savedRangeRef.current;
    if (!el) return;
    el.focus();
    if (!r) return;
    const sel = window.getSelection();
    if (!sel) return;
    try { sel.removeAllRanges(); sel.addRange(r); } catch {}
  };

  const execFmt = (command, value = null) => {
    restoreRange();
    pushUndo(editorRef.current?.innerHTML ?? content);
    document.execCommand(command, false, value);
    syncContent();
    refreshFmtState();
  };

  // Colour and font-family only produce inline styles when styleWithCSS is on.
  // It is turned on for the single call and turned straight back off, so the
  // rest of the commands keep emitting semantic tags (<b>, <i>, <s>).
  const execFmtCss = (command, value) => {
    restoreRange();
    pushUndo(editorRef.current?.innerHTML ?? content);
    try {
      document.execCommand('styleWithCSS', false, true);
      if (!document.execCommand(command, false, value) && command === 'hiliteColor') {
        document.execCommand('backColor', false, value); // older WebKit spelling
      }
    } finally {
      document.execCommand('styleWithCSS', false, false);
    }
    syncContent();
    refreshFmtState();
  };

  // Live toolbar state — which formats are active at the caret.
  const [fmtState, setFmtState] = useState({});
  const rafRef = useRef(0);

  const refreshFmtState = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const el = editorRef.current;
      const sel = document.getSelection();
      if (!el || !sel || !el.contains(sel.anchorNode)) return;
      // Mirror the live range so dropdowns can restore it after they steal focus.
      if (sel.rangeCount) { try { savedRangeRef.current = sel.getRangeAt(0).cloneRange(); } catch {} }
      const q = (c) => { try { return document.queryCommandState(c); } catch { return false; } };
      let block = '';
      try { block = (document.queryCommandValue('formatBlock') || '').toLowerCase(); } catch {}
      setFmtState({
        bold: q('bold'), italic: q('italic'), underline: q('underline'),
        strike: q('strikeThrough'),
        ul: q('insertUnorderedList'), ol: q('insertOrderedList'),
        left: q('justifyLeft'), center: q('justifyCenter'), right: q('justifyRight'),
        block,
      });
    });
  }, []);

  // Set up the editor's command defaults once, and track selection for live state.
  useEffect(() => {
    try {
      // styleWithCSS stays FALSE by default. It is a document-global, persistent
      // flag, and with it on Chrome emits <span style="font-weight:bold"> for
      // execCommand('bold') instead of <b> — which would slip straight past the
      // editor's bold styling and undo the whole point of this change. It is
      // switched on only around the three commands that require it (see
      // execFmtCss) and switched back immediately.
      document.execCommand('styleWithCSS', false, false);
      // Without this, queryCommandValue('formatBlock') reports 'div' forever and
      // the paragraph-style dropdown can never show the current block.
      document.execCommand('defaultParagraphSeparator', false, 'p');
    } catch {}
    const onSel = () => refreshFmtState();
    document.addEventListener('selectionchange', onSel);
    return () => {
      document.removeEventListener('selectionchange', onSel);
      cancelAnimationFrame(rafRef.current);
    };
  }, [refreshFmtState]);

  // Paragraph style. formatBlock ALWAYS takes an angle-bracketed tag — bare 'h2'
  // works in Chromium/Safari but is ignored by Firefox. Clicking the style you are
  // already in toggles back to a plain paragraph, the way Docs behaves.
  const setBlockFmt = (tag) => {
    const current = fmtState.block;
    const target = current === tag.replace(/[<>]/g, '') ? 'p' : tag.replace(/[<>]/g, '');
    execFmt('formatBlock', `<${target}>`);
  };

  // execCommand('fontSize') only accepts legacy buckets 1-7 and emits <font size=N>.
  // Standard sentinel-swap: let the browser do the hard work of splitting text nodes
  // and crossing element boundaries using size 7 as a marker, then rewrite each
  // marked <font> into a <span> carrying the real px value.
  const SENTINEL = '7';
  const applyFontSize = (px) => {
    const el = editorRef.current;
    const sel = window.getSelection();
    if (!el || !sel || !sel.rangeCount || sel.isCollapsed) { setFontSize(px); return; }
    el.focus();
    try {
      document.execCommand('styleWithCSS', false, false); // force legacy <font> output
      if (!document.execCommand('fontSize', false, SENTINEL)) return;
      const marked = el.querySelectorAll(`font[size="${SENTINEL}"]`);
      const swapped = [];
      marked.forEach((font) => {
        const span = document.createElement('span');
        span.style.fontSize = `${px}px`;
        if (font.getAttribute('color')) span.style.color = font.getAttribute('color');
        if (font.getAttribute('face')) span.style.fontFamily = font.getAttribute('face');
        while (font.firstChild) span.appendChild(font.firstChild);
        font.replaceWith(span);
        // Nested older sizes would win by document order — clear them.
        span.querySelectorAll('[style*="font-size"]').forEach((n) => {
          n.style.removeProperty('font-size');
          if (!n.getAttribute('style')) n.removeAttribute('style');
        });
        swapped.push(span);
      });
      // replaceWith() collapses the selection — put it back.
      if (swapped.length) {
        const range = document.createRange();
        range.setStartBefore(swapped[0]);
        range.setEndAfter(swapped[swapped.length - 1]);
        sel.removeAllRanges(); sel.addRange(range);
      }
    } finally {
      // Back to the default. The sentinel trick REQUIRES legacy mode — with
      // styleWithCSS on, fontSize emits <span style="font-size:xxx-large"> and
      // the font[size="7"] query finds nothing at all.
      document.execCommand('styleWithCSS', false, false);
    }
    setFontSize(px);
    syncContent();
  };

  // Link needs the selection saved before the prompt steals focus.
  const insertLink = () => {
    const sel = window.getSelection();
    const saved = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    const url = prompt('Link URL:', 'https://');
    if (!url) return;
    const s = window.getSelection();
    if (saved && s) { s.removeAllRanges(); s.addRange(saved); }
    editorRef.current?.focus();
    execFmt(saved && !saved.collapsed ? 'createLink' : 'insertHTML',
      saved && !saved.collapsed ? url : `<a href="${url}">${url}</a>`);
  };

  const insertBlock = (type) => {
    switch (type) {
      case 'h2':   setBlockFmt('h2'); return;
      case 'ul':   execFmt('insertUnorderedList'); return;
      case 'hr':   execFmt('insertHTML', '<hr>'); return;
      case 'link': insertLink(); return;
      default: break;
    }
  };

  // Only ever report a selection made INSIDE the editor. Unguarded, text
  // highlighted in the Co-Write panel or the outline rail would be sent to the
  // AI as the passage to rewrite and spliced back into the document.
  const getSelection = () => {
    const sel = window.getSelection();
    if (!sel || !editorRef.current?.contains(sel.anchorNode)) return '';
    return sel.toString();
  };

  // Counts measure the writing, not the markup — a 400-word document carrying
  // colour and size spans reports thousands of characters otherwise.
  const plainText = React.useMemo(() => htmlToText(content), [content]);
  const wordCount = plainText.trim().split(/\s+/).filter(Boolean).length;

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
      if (d.content) { setVal(d.content); setEditorMode('read'); }
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
      if (d.content) { setVal(content + '\n\n' + d.content); setEditorMode('read'); }
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
    // If the Co-Write response is a list of `old → new` corrections (spell
    // check, grammar, weak-word flags), apply them as in-document replacements
    // rather than dumping the suggestion text literally into the document.
    const correctionLines = text.split('\n')
      .map(l => l.match(/^(.+?)\s*→\s*(.+)$/))
      .filter(Boolean);
    if (correctionLines.length > 0 && correctionLines.length === text.trim().split('\n').filter(Boolean).length) {
      // Apply over TEXT NODES. Matching against `content` would run over markup:
      // a correction whose target happens to appear in an attribute would rewrite
      // the formatting, and a word split by a tag (part of it bold or coloured)
      // would never match at all — so corrections silently applied 0 of N and
      // then dumped the suggestion list into the document as prose.
      const el = editorRef.current;
      if (!el) return;
      let replaced = 0;
      for (const [, from, to] of correctionLines) {
        const f = from.trim(), t = to.trim();
        if (!f || !t) continue;
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let node, hit = false;
        while ((node = walker.nextNode())) {
          if (node.textContent.includes(f)) { node.textContent = node.textContent.split(f).join(t); hit = true; }
        }
        if (hit) replaced++;
      }
      if (replaced > 0) {
        syncContent();
        showToast(`✓ Applied ${replaced} correction${replaced > 1 ? 's' : ''}`);
        return;
      }
      showToast('None of those corrections matched the current text.');
      return;
    }
    // Fall back: regular prose response — insert at the cursor as a real
    // paragraph. escapeHtml first: this string came from a model, and
    // insertHTML would otherwise execute any markup in it.
    const el = editorRef.current;
    if (!el) return;
    restoreRange();
    execFmt('insertHTML', `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`);
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
      // The document is HTML now, so a .md export has to convert. Colour,
      // highlight, font and size cannot survive the trip — markdown has no
      // syntax for them — and the toast says so rather than dropping silently.
      : new Blob([`# ${title}\n\n${htmlToMarkdown(content)}`], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `${title.replace(/[^a-z0-9]/gi, '_')}.${format === 'html' ? 'html' : 'md'}`; a.click();
    URL.revokeObjectURL(url);
  };

  const handleKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveDoc(); }
    // Bold/italic/underline: let the browser handle ctrl+b/i natively in contenteditable,
    // just sync state after.
    if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'i' || e.key === 'u')) {
      setTimeout(syncContent, 0);
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); setFindOpen(true); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); setFocusMode(f => !f); }
    if (e.key === 'Escape' && focusMode) setFocusMode(false);
  };

  const QUICK_PROMPTS = ['Spell check', 'Flag weak words', 'Grammar check', 'Weakest part?', 'What next?'];

  // handleKey is bound on the EDITOR only. It used to be on this root div as
  // well, and React events bubble — so every editor keystroke ran it twice,
  // which made Ctrl+Enter toggle focus mode straight back to where it started
  // and Ctrl+S fire two saves. Escape-exits-focus-mode is covered by the window
  // listener near the top of the component.
  return (
    <div className={`writer-root ${focusMode ? 'writer-root--focus' : ''}`}>
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

        {/* ── Toolbar row 1: document level ──────────────────────────────── */}
        <div className="writer-toolbar writer-toolbar--row1">
          <div className="writer-toolbar-left">
            <button className="writer-tb writer-tb--icon" onMouseDown={e => { e.preventDefault(); undo(); }} title="Undo (Ctrl+Z)"><Undo2 size={14} /></button>
            <button className="writer-tb writer-tb--icon" onMouseDown={e => { e.preventDefault(); redo(); }} title="Redo (Ctrl+Shift+Z)"><Redo2 size={14} /></button>
            <span className="writer-tb-div" />

            {/* Paragraph style */}
            <select className="writer-sel writer-sel--style" value={PARA_STYLES.some(s => s.tag === fmtState.block) ? fmtState.block : 'p'}
              onMouseDown={() => editorRef.current?.focus()}
              onChange={e => execFmt('formatBlock', `<${e.target.value}>`)}
              title="Paragraph style">
              {PARA_STYLES.map(s => <option key={s.tag} value={s.tag}>{s.label}</option>)}
            </select>

            {/* Font family */}
            <select className="writer-sel writer-sel--font" value={fontFamily}
              onMouseDown={() => editorRef.current?.focus()}
              onChange={e => { setFontFamily(e.target.value); execFmtCss('fontName', e.target.value); }}
              title="Font">
              {FONTS.map(f => <option key={f.css} value={f.css} style={{ fontFamily: f.css }}>{f.label}</option>)}
            </select>

            {/* Font size stepper */}
            <span className="writer-stepper">
              <button className="writer-step-btn" onMouseDown={e => { e.preventDefault(); applyFontSize(Math.max(8, fontSize - 1)); }} title="Decrease font size">−</button>
              <input className="writer-step-val" type="text" value={fontSize}
                onChange={e => { const n = parseInt(e.target.value, 10); if (!isNaN(n)) setFontSize(n); }}
                onBlur={e => { const n = parseInt(e.target.value, 10); if (!isNaN(n) && n >= 8 && n <= 96) applyFontSize(n); }}
                aria-label="Font size" />
              <button className="writer-step-btn" onMouseDown={e => { e.preventDefault(); applyFontSize(Math.min(96, fontSize + 1)); }} title="Increase font size">+</button>
            </span>
            <span className="writer-tb-div" />

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

        {/* ── Toolbar row 2: selection level ─────────────────────────────── */}
        <div className="writer-toolbar writer-toolbar--row2">
          <div className="writer-toolbar-left">
            {/* Inline formats. onMouseDown + preventDefault keeps the editor focused
                so the selection survives long enough for execCommand to act on it. */}
            <button className={`writer-tb writer-tb--icon ${fmtState.bold ? 'writer-tb--on' : ''}`}
              onMouseDown={e => { e.preventDefault(); execFmt('bold'); }} title="Bold (Ctrl+B)"><Bold size={14} /></button>
            <button className={`writer-tb writer-tb--icon ${fmtState.italic ? 'writer-tb--on' : ''}`}
              onMouseDown={e => { e.preventDefault(); execFmt('italic'); }} title="Italic (Ctrl+I)"><Italic size={14} /></button>
            <button className={`writer-tb writer-tb--icon ${fmtState.underline ? 'writer-tb--on' : ''}`}
              onMouseDown={e => { e.preventDefault(); execFmt('underline'); }} title="Underline (Ctrl+U)"><Underline size={14} /></button>
            <button className={`writer-tb writer-tb--icon ${fmtState.strike ? 'writer-tb--on' : ''}`}
              onMouseDown={e => { e.preventDefault(); execFmt('strikeThrough'); }} title="Strikethrough"><Strikethrough size={14} /></button>
            <span className="writer-tb-div" />

            {/* Colour */}
            <span className="writer-swatch-wrap">
              <button className="writer-tb writer-tb--icon writer-swatch" onMouseDown={e => { e.preventDefault(); setColorOpen(c => c === 'text' ? null : 'text'); }} title="Text colour">
                <Baseline size={14} />
              </button>
              {colorOpen === 'text' && (
                <div className="writer-palette">
                  {SWATCHES.map(c => (
                    <button key={c} className="writer-swatch-cell" style={{ background: c }} title={c}
                      onMouseDown={e => { e.preventDefault(); execFmtCss('foreColor', c); setColorOpen(null); }} />
                  ))}
                </div>
              )}
            </span>
            <span className="writer-swatch-wrap">
              <button className="writer-tb writer-tb--icon writer-swatch" onMouseDown={e => { e.preventDefault(); setColorOpen(c => c === 'highlight' ? null : 'highlight'); }} title="Highlight colour">
                <Highlighter size={14} />
              </button>
              {colorOpen === 'highlight' && (
                <div className="writer-palette">
                  <button className="writer-swatch-cell writer-swatch-none" title="No highlight"
                    onMouseDown={e => { e.preventDefault(); execFmtCss('hiliteColor', 'transparent'); setColorOpen(null); }}>✕</button>
                  {HIGHLIGHTS.map(c => (
                    <button key={c} className="writer-swatch-cell" style={{ background: c }} title={c}
                      onMouseDown={e => { e.preventDefault(); execFmtCss('hiliteColor', c); setColorOpen(null); }} />
                  ))}
                </div>
              )}
            </span>
            <span className="writer-tb-div" />

            {/* Alignment */}
            <button className={`writer-tb writer-tb--icon ${fmtState.left ? 'writer-tb--on' : ''}`}
              onMouseDown={e => { e.preventDefault(); execFmt('justifyLeft'); }} title="Align left"><AlignLeft size={14} /></button>
            <button className={`writer-tb writer-tb--icon ${fmtState.center ? 'writer-tb--on' : ''}`}
              onMouseDown={e => { e.preventDefault(); execFmt('justifyCenter'); }} title="Align centre"><AlignCenter size={14} /></button>
            <button className={`writer-tb writer-tb--icon ${fmtState.right ? 'writer-tb--on' : ''}`}
              onMouseDown={e => { e.preventDefault(); execFmt('justifyRight'); }} title="Align right"><AlignRight size={14} /></button>
            <span className="writer-tb-div" />

            {/* Lists + indent */}
            <button className={`writer-tb writer-tb--icon ${fmtState.ul ? 'writer-tb--on' : ''}`}
              onMouseDown={e => { e.preventDefault(); execFmt('insertUnorderedList'); }} title="Bulleted list"><List size={14} /></button>
            <button className={`writer-tb writer-tb--icon ${fmtState.ol ? 'writer-tb--on' : ''}`}
              onMouseDown={e => { e.preventDefault(); execFmt('insertOrderedList'); }} title="Numbered list"><ListOrdered size={14} /></button>
            <button className="writer-tb writer-tb--icon" onMouseDown={e => { e.preventDefault(); execFmt('outdent'); }} title="Decrease indent"><IndentDecrease size={14} /></button>
            <button className="writer-tb writer-tb--icon" onMouseDown={e => { e.preventDefault(); execFmt('indent'); }} title="Increase indent"><IndentIncrease size={14} /></button>
            <span className="writer-tb-div" />

            {/* Insert + clear */}
            <button className="writer-tb writer-tb--icon" onMouseDown={e => { e.preventDefault(); insertBlock('link'); }} title="Insert link"><Link size={14} /></button>
            <button className="writer-tb writer-tb--icon" onMouseDown={e => { e.preventDefault(); execFmt('unlink'); }} title="Remove link"><Unlink size={14} /></button>
            <button className="writer-tb writer-tb--icon" onMouseDown={e => { e.preventDefault(); insertBlock('hr'); }} title="Horizontal line"><Minus size={14} /></button>
            <button className="writer-tb writer-tb--icon" onMouseDown={e => { e.preventDefault(); execFmt('removeFormat'); }} title="Clear formatting"><Eraser size={14} /></button>
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
                  onClick={() => jumpTo(h.text)}>
                  {h.text}
                </button>
              ))}
            </nav>
          )}
          <div className="writer-editor-col">
            {/* WYSIWYG contenteditable — bold/italic/etc. are real formatting, not markdown tokens */}
            <div
              ref={editorRef}
              className="writer-editor writer-editor--rich"
              contentEditable
              suppressContentEditableWarning
              onInput={syncContent}
              onKeyDown={handleKey}
              data-placeholder={writeMode === 'braindump' ? 'Paste your brain dump here…' : 'Start typing…'}
            />
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
            <span>{plainText.length.toLocaleString()} chars</span>
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
            {/* Write both flavours: pasting into Word or Docs keeps the formatting,
                pasting into a plain-text field gets clean prose rather than markup. */}
            <button className="writer-btn-sm" title="Copy"
              onClick={async () => {
                try {
                  await navigator.clipboard.write([new ClipboardItem({
                    'text/html': new Blob([content], { type: 'text/html' }),
                    'text/plain': new Blob([plainText], { type: 'text/plain' }),
                  })]);
                } catch { try { await navigator.clipboard.writeText(plainText); } catch {} }
                showToast('Copied');
              }}><Copy size={12} /> Copy</button>
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
          /* The editor body is a DOCUMENT, not a terminal. A monospace face holds a
             fixed advance width, so its weight axis has a far shorter runway — 400→700
             in JetBrains Mono is roughly a third of the stem change Inter or Arial give
             you, which is why Bold read as almost nothing. Inter is already loaded by
             aurora.css at 400 AND 700, and every fallback in the tail ships a real Bold
             face, so the offline path still gets true bold. */
          --w-editor-font: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
          --w-editor-display: 'Space Grotesk', var(--w-editor-font);
          --w-editor-bold: 700;
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

        /* Two rows: row 1 acts on the document, row 2 on the selection.
           Cramped is fixed by GROUPING, not padding — 2px inside a group,
           a divider between groups. */
        .writer-toolbar { display: flex; align-items: center; padding: 5px 12px; border-bottom: 1px solid var(--border); gap: 2px; flex-wrap: wrap; }
        .writer-toolbar--row1 { background: rgba(255,255,255,0.022); }
        .writer-toolbar--row2 { background: rgba(255,255,255,0.035); padding: 4px 12px; }
        .writer-toolbar-left { display: flex; align-items: center; gap: 2px; flex: 1; flex-wrap: wrap; }
        .writer-toolbar-right { display: flex; gap: 4px; flex-wrap: wrap; }
        .writer-tb-div { width: 1px; height: 18px; background: var(--border); opacity: 0.55; margin: 0 8px; flex-shrink: 0; }

        /* Square icon buttons — 28x28, like a real editor shelf */
        .writer-tb--icon { width: 28px; height: 28px; padding: 0; justify-content: center; color: rgba(255,255,255,0.72); }
        .writer-tb--icon:hover:not(:disabled) { background: rgba(255,255,255,0.08); color: #fff; }
        /* Latched state, driven by queryCommandState — B/I/U, lists and alignment
           visibly stay lit while the caret sits inside that formatting. */
        .writer-tb--on { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); }
        .writer-tb--on:hover { background: color-mix(in srgb, var(--accent) 26%, transparent); }

        /* Dark-styled dropdowns. A native <select> renders with light macOS chrome
           and punches a hole in the dark strip, so the surface is painted here. */
        .writer-sel {
          background: rgba(255,255,255,0.05); border: 1px solid var(--border); border-radius: 5px;
          color: var(--text); font-size: 11.5px; font-family: inherit; padding: 4px 6px;
          outline: none; cursor: pointer; height: 28px;
        }
        .writer-sel:hover { background: rgba(255,255,255,0.09); }
        .writer-sel:focus { border-color: var(--accent); }
        .writer-sel--style { width: 118px; }
        .writer-sel--font { width: 132px; }
        .writer-sel option { background: #12161f; color: var(--text); }

        /* Font size stepper: − [16] + */
        .writer-stepper { display: flex; align-items: center; gap: 0; border: 1px solid var(--border); border-radius: 5px; overflow: hidden; height: 28px; background: rgba(255,255,255,0.05); }
        .writer-step-btn { width: 22px; height: 100%; border: none; background: none; color: var(--text-dim); cursor: pointer; font-size: 14px; line-height: 1; display: flex; align-items: center; justify-content: center; }
        .writer-step-btn:hover { background: rgba(255,255,255,0.1); color: #fff; }
        .writer-step-val { width: 30px; height: 100%; border: none; background: none; color: var(--text); font-size: 11.5px; text-align: center; outline: none; font-family: inherit; }

        /* Colour swatch popovers */
        .writer-swatch-wrap { position: relative; display: inline-flex; }
        .writer-palette {
          position: absolute; top: calc(100% + 5px); left: 0; z-index: 60;
          display: grid; grid-template-columns: repeat(6, 20px); gap: 4px; padding: 8px;
          background: rgba(10,14,24,0.98); border: 1px solid var(--border-hi);
          border-radius: 7px; box-shadow: 0 8px 24px rgba(0,0,0,0.55);
        }
        .writer-swatch-cell { width: 20px; height: 20px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.18); cursor: pointer; padding: 0; }
        .writer-swatch-cell:hover { transform: scale(1.14); border-color: #fff; }
        .writer-swatch-none { background: rgba(255,255,255,0.05); color: var(--text-dim); font-size: 11px; display: flex; align-items: center; justify-content: center; }
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
        .writer-editor-col { flex: 1; display: flex; flex-direction: column; position: relative; min-width: 0; overflow: hidden; }

        /* WYSIWYG contenteditable editor */
        /* Body keeps full --text. Dimming the whole document to make bold stand out
           would trade legibility on ~99% of the text for contrast on ~1%, and leave
           the editor looking washed out next to every other AEON surface. Bold gets
           its second axis by going brighter instead (see below). */
        .writer-editor--rich {
          flex: 1; border: none; background: transparent;
          color: var(--text);
          font-family: var(--w-editor-font);
          font-size: 16px; line-height: 1.7;
          padding: 24px 28px; outline: none; overflow-y: auto;
          word-break: break-word; white-space: pre-wrap;
        }
        .writer-editor--rich:empty::before {
          content: attr(data-placeholder); color: var(--text-dim);
          font-style: italic; pointer-events: none;
        }
        /* Rich text element styles inside the editor */
        /* Bold moves on TWO axes — weight 400→700 in a proportional face, and
           luminance 16.1:1→20:1. Weight alone never read on a dark ground, where
           irradiation blooms the regular strokes and closes the gap.
           The attribute selectors matter: whenever styleWithCSS is on, Chrome and
           Firefox emit <span style="font-weight:bold"> rather than <b>, and a
           tag-only selector would silently miss every one of them. */
        .writer-editor--rich b,
        .writer-editor--rich strong,
        .writer-editor--rich [style*="font-weight: bold"],
        .writer-editor--rich [style*="font-weight:bold"],
        .writer-editor--rich [style*="font-weight: 700"],
        .writer-editor--rich [style*="font-weight:700"] { font-weight: var(--w-editor-bold); color: #fff; }
        .writer-editor--rich i, .writer-editor--rich em { font-style: italic; }
        .writer-editor--rich s, .writer-editor--rich strike { text-decoration: line-through; }
        .writer-editor--rich u { text-decoration: underline; }
        .writer-editor--rich h1 { font-family: var(--w-editor-display); font-size: 1.6em; font-weight: 700; color: var(--text); margin: 24px 0 10px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
        .writer-editor--rich h2 { font-family: var(--w-editor-display); font-size: 1.3em; font-weight: 700; margin: 20px 0 8px; color: var(--accent); }
        .writer-editor--rich h3 { font-family: var(--w-editor-display); font-size: 1.1em; font-weight: 600; color: var(--text); margin: 16px 0 6px; }
        .writer-editor--rich ul { list-style: disc; padding-left: 24px; margin: 8px 0; }
        .writer-editor--rich ol { list-style: decimal; padding-left: 24px; margin: 8px 0; }
        .writer-editor--rich li { margin: 4px 0; }
        .writer-editor--rich a { color: var(--accent); text-decoration: underline; }
        .writer-editor--rich hr { border: none; border-top: 1px solid var(--border); margin: 20px 0; }
        /* Pin monospace explicitly — --w-editor-font is proportional now, and code
           spans would otherwise have silently de-monospaced in every document. */
        .writer-editor--rich code, .writer-editor--rich pre { font-family: var(--font-mono); background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
        /* Chrome's execCommand('indent') wraps a paragraph in a blockquote with an
           inline margin. Styling every blockquote would grey out each indented
           paragraph and make it look like a pull quote, so the quote treatment is
           scoped to blockquotes that do NOT carry that inline indent margin. */
        .writer-editor--rich blockquote:not([style*="margin-left"]):not([style*="margin:"]) {
          border-left: 3px solid var(--accent); margin: 12px 0; padding: 4px 16px; color: var(--text-dim);
        }
        /* Chrome generates <p> and <div> wrappers on Enter — give them real spacing. */
        .writer-editor--rich p { margin: 0 0 0.75em; }
        .writer-editor--rich div { margin: 0; }
        .writer-editor--rich h4 { font-family: var(--w-editor-display); font-size: 1em; font-weight: 600; color: var(--text); margin: 14px 0 6px; }

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
        /* Renders raw HTML source — must stay monospace. */
        .writer-history-preview pre { white-space: pre-wrap; font-size: 11px; color: var(--text-dim); font-family: var(--font-mono); }

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
        /* Base is 16px now, so focus mode steps to 18 to still feel like a mode change. */
        .writer-root--focus .writer-editor, .writer-root--focus .writer-preview { max-width: 720px; margin: 0 auto; width: 100%; font-size: 18px; line-height: 1.8; }
        .writer-focus-exit { position: fixed; top: 16px; right: 20px; z-index: 96; display: inline-flex; align-items: center; gap: 6px; background: var(--accent); border: 1px solid var(--accent); color: #020508; font-size: 12px; font-weight: 700; padding: 7px 14px; border-radius: 20px; cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,0.4); }
        .writer-focus-exit:hover { filter: brightness(1.1); }
        .writer-focus-exit:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }

        /* Print IS the PDF path (Export → Print → Save as PDF). Three things have
           to be corrected or the output is unusable: browsers drop background
           colours by default so every highlight vanishes; the editor inherits the
           dark theme's near-white text onto white paper; and the h2 rule paints
           neon cyan, which prints almost invisibly. */
        @media print {
          .writer-sidebar, .writer-topbar, .writer-toolbar, .writer-footer,
          .writer-title-input, .writer-word-count, .cowrite-panel, .writer-critique,
          .writer-findbar, .writer-outline, .writer-history, .writer-genbar { display: none !important; }
          .writer-root { display: block !important; }
          .writer-editor {
            font-size: 12pt; line-height: 1.7; height: auto !important; overflow: visible !important;
            color: #111 !important; background: #fff !important; padding: 0 !important;
            -webkit-print-color-adjust: exact; print-color-adjust: exact;
          }
          .writer-editor--rich h1, .writer-editor--rich h2,
          .writer-editor--rich h3, .writer-editor--rich h4 { color: #111 !important; }
          .writer-editor--rich b, .writer-editor--rich strong { color: #000 !important; }
          .writer-editor--rich a { color: #0645ad !important; }
        }
      `}</style>
    </div>
  );
}
