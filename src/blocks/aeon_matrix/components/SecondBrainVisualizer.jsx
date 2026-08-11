import React, { useEffect, useState, useRef, useMemo } from 'react';
import EditorMode from './EditorMode';
import NarratorPlayer from './NarratorPlayer';

// ── Chapter-aware retrieval ─────────────────────────────────────────────────
// Documents are split on chapter/episode/part headings (or fixed-size sections
// as a fallback) so Ask and Summary can target the right slice instead of only
// ever seeing the first 12k characters.

const CHAPTER_RE = /^(?:\s{0,3}#{1,6}\s*)?((?:chapter|episode|part|section|book|act)\s+(?:\d+|[ivxlcdm]+)\b[^\n]{0,120})$/gim;

function splitChapters(text) {
  if (!text || typeof text !== 'string') return [];
  const matches = [...text.matchAll(CHAPTER_RE)];
  if (matches.length >= 2) {
    const chapters = [];
    if (matches[0].index > 300) chapters.push({ title: 'Front matter / Intro', text: text.slice(0, matches[0].index) });
    matches.forEach((m, i) => {
      const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
      chapters.push({ title: m[1].trim().slice(0, 90), text: text.slice(m.index, end) });
    });
    return chapters;
  }
  // No headings found — fall back to fixed-size sections so long docs are still coverable
  const SIZE = 9000;
  const chunks = [];
  for (let i = 0; i < text.length; i += SIZE) {
    chunks.push({ title: `Section ${chunks.length + 1}`, text: text.slice(i, i + SIZE) });
  }
  return chunks;
}

// Pick the most relevant chapters for a question: explicit chapter references
// win ("chapter 10", "last episode"), otherwise keyword-score every chapter
// and pack the best ones into the context budget.
function pickContext(question, text, maxChars = 12000) {
  const chapters = splitChapters(text);
  if (chapters.length <= 1) return { context: text.slice(0, maxChars), scope: chapters[0]?.title || 'document' };
  const q = question.toLowerCase();

  const numMatch = q.match(/(?:chapter|episode|part|section|book|act)\s+(\d+|[ivxlcdm]+)/i);
  if (numMatch) {
    const hit = chapters.find(c => c.title.toLowerCase().includes(numMatch[0].toLowerCase()))
      || chapters.find(c => new RegExp(`\\b${numMatch[1]}\\b`, 'i').test(c.title));
    if (hit) return { context: hit.text.slice(0, maxChars), scope: hit.title };
  }
  if (/\b(last|final)\s+(chapter|episode|part|section)/.test(q)) {
    const hit = chapters[chapters.length - 1];
    return { context: hit.text.slice(0, maxChars), scope: hit.title };
  }
  if (/\bfirst\s+(chapter|episode|part|section)/.test(q)) {
    const hit = chapters.find(c => !/front matter/i.test(c.title)) || chapters[0];
    return { context: hit.text.slice(0, maxChars), scope: hit.title };
  }

  // Keyword scoring — poor-man's RAG, no embeddings needed, runs instantly in the browser
  const words = q.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3);
  const scored = chapters.map(c => {
    const t = c.text.toLowerCase();
    let score = 0;
    for (const w of words) score += t.split(w).length - 1;
    return { ...c, score };
  }).sort((a, b) => b.score - a.score);

  let context = '';
  const used = [];
  for (const c of scored) {
    if (used.length > 0 && (c.score === 0 || context.length + c.text.length > maxChars)) break;
    context += `\n\n=== ${c.title} ===\n${c.text}`.slice(0, maxChars - context.length);
    used.push(c.title);
    if (context.length >= maxChars) break;
  }
  if (!context) { context = text.slice(0, maxChars); used.push('start of document'); }
  return { context, scope: used.join(' · ') };
}

const SecondBrainVisualizer = () => {
  const [mounted, setMounted] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);
  const [fileContent, setFileContent] = useState('');
  // BO-D2d — which of the three sources answered: 'disk' | 'cloud' | 'notes'
  // | 'none'. Only 'disk' has a file that Edit can write back to.
  const [contentSource, setContentSource] = useState(null);
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [viewMode, setViewMode] = useState('READ');
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  // AI features
  const [qaQuestion, setQaQuestion] = useState('');
  const [qaAnswer, setQaAnswer] = useState('');
  const [qaLoading, setQaLoading] = useState(false);
  const [qaScope, setQaScope] = useState('');
  const [summary, setSummary] = useState('');
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryProgress, setSummaryProgress] = useState('');
  const [chapterSel, setChapterSel] = useState('all');
  const [sumDetail, setSumDetail] = useState('brief');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [activeTab, setActiveTab] = useState('read');
  const qaInputRef = useRef(null);

  // aiText drives Ask/Summary/Search: the raw string for text docs,
  // server-extracted text for PDFs (where fileContent is an <iframe>).
  const [aiText, setAiText] = useState('');
  const [aiTextStatus, setAiTextStatus] = useState(''); // '', 'loading', 'ready', 'failed'

  const chapters = useMemo(() => splitChapters(aiText), [aiText]);

  // Text documents feed the AI tabs directly; PDFs get aiText from the
  // pdf-text endpoint instead (fileContent is an <iframe> element there).
  useEffect(() => {
    if (typeof fileContent === 'string' && fileContent.trim()) {
      setAiText(fileContent);
      setAiTextStatus('ready');
    }
  }, [fileContent]);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setMounted(true), 100);

    const handleMessage = async (event) => {
      if (event.data && event.data.type === 'NODE_CLICK') {
        const nodeId = event.data.nodeId;
        setSelectedFile(nodeId);
        setIsLoadingFile(true);
        setFileContent('');
        // D2d — provenance is per-document; a stale 'disk' from the previous
        // selection would re-offer Edit on a document that has no local file.
        setContentSource(null);
        setViewMode('READ');
        setActiveTab('read');
        setQaAnswer(''); setQaScope(''); setSummary(''); setSummaryProgress(''); setChapterSel('all'); setSearchResults([]); setSearchQuery('');
        setAiText(''); setAiTextStatus('');

        try {
          if (nodeId.startsWith('folder_') || event.data.nodeType === 'folder' || event.data.nodeType === 'dir') {
            const folderName = event.data.nodeName || nodeId.split(/[\\/]/).pop();
            setFileContent(`📁 TOPIC HUB: ${folderName}\n\nThis is an organic cluster hub generated to group all related files within this directory.`);
            // A hub is generated, not read from anywhere — nothing to edit.
            setContentSource('none');
            setIsLoadingFile(false);
            return;
          }

          const extInName = (nodeId.split('.').pop() || '').toLowerCase();
          const isImage = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'].includes(extInName);

          // Background extraction — feeds Ask/Summary/Search for any file type,
          // including OCR on scanned PDFs and images.
          const extractInBackground = () => {
            setAiTextStatus('loading');
            fetch(`/api/crn/second-brain/extract?path=${encodeURIComponent(nodeId)}`)
              .then(r => r.json())
              .then(d => {
                if (d.text && d.text.trim()) { setAiText(d.text); setAiTextStatus(d.method === 'ocr' || d.method === 'pdf-ocr' ? 'ready-ocr' : 'ready'); }
                else setAiTextStatus('failed');
              })
              .catch(() => setAiTextStatus('failed'));
          };

          if (nodeId.endsWith('.pdf') && !window.location.hostname.includes('vercel.app')) {
            setFileContent(<iframe src={`/api/crn/second-brain/pdf?path=${encodeURIComponent(nodeId)}`} width="100%" height="100%" style={{ border: 'none', backgroundColor: 'white' }} title="PDF Preview" />);
            setIsLoadingFile(false);
            extractInBackground();
            return;
          }

          if (isImage && !window.location.hostname.includes('vercel.app')) {
            setFileContent(
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'flex-start', overflow: 'auto', height: '100%', padding: '16px' }}>
                <img src={`/api/crn/second-brain/raw?path=${encodeURIComponent(nodeId)}`} alt={`Preview of ${nodeId.split(/[\\/]/).pop()}`} style={{ maxWidth: '100%', height: 'auto' }} />
              </div>
            );
            setIsLoadingFile(false);
            extractInBackground();
            return;
          }

          // Office docs (docx/xlsx/pptx) are binary — reading them raw shows
          // garbage. Show the server-extracted text as the document content.
          const isOffice = ['docx', 'xlsx', 'pptx'].includes(extInName);
          if (isOffice && !window.location.hostname.includes('vercel.app')) {
            setAiTextStatus('loading');
            try {
              const r = await fetch(`/api/crn/second-brain/extract?path=${encodeURIComponent(nodeId)}`);
              const d = await r.json();
              if (d.text && d.text.trim()) {
                setFileContent(d.text); // useEffect syncs this into aiText too
              } else {
                setFileContent('No readable text found in this file.');
                setAiTextStatus('failed');
              }
            } catch (err) {
              setFileContent('Extraction failed: ' + err.message);
              setAiTextStatus('failed');
            }
            setIsLoadingFile(false);
            return;
          }

          // BO-D2d — WHERE the content came from is part of the content.
          //
          // Three sources answer in sequence and the UI used to record none of
          // them. If the cloud index or the notes store answered, the document
          // rendered while no file existed on disk — so Edit → Save PUT the
          // path and got back "File not found", and the operator saw their
          // document and "File not found" on one screen. Both statements were
          // true; they were about different things.
          //
          // An action is only offered when the source can support it.
          let fetched = false;
          const tried = [];

          try {
            const response = await fetch(`/api/crn/second-brain/document?path=${encodeURIComponent(nodeId)}`);
            if (response.ok) {
              const data = await response.json();
              if (data.content) { setFileContent(data.content); setContentSource('disk'); fetched = true; }
              else tried.push('local file: no content returned');
            } else tried.push(`local file: HTTP ${response.status}`);
          } catch (e) { tried.push(`local file: ${e.message}`); }

          if (!fetched) {
            try {
              const sbUrl = import.meta.env.VITE_SUPABASE_URL || '';
              const sbKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
              const encoded = encodeURIComponent(nodeId);
              const sbRes = await fetch(
                `${sbUrl}/rest/v1/documents?or=(metadata->>original_id.eq.${encoded},metadata->>title.eq.${encoded})&select=content,metadata&limit=1`,
                { headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` } }
              );
              const rows = await sbRes.json();
              if (rows?.[0]?.content) { setFileContent(rows[0].content); setContentSource('cloud'); fetched = true; }
              else tried.push('cloud index: no matching document');
            } catch (e) { tried.push(`cloud index: ${e.message}`); }
          }

          if (!fetched) {
            try {
              const notesRes = await fetch('/api/notes');
              const data = await notesRes.json();
              if (data?.notes) {
                const foundNote = data.notes.find(n =>
                  n.title === nodeId || n.filename === nodeId ||
                  (n.filepath && n.filepath.endsWith(nodeId))
                );
                if (foundNote) {
                  setFileContent(foundNote.content || foundNote.body || 'File is empty.');
                  setContentSource('notes');
                  fetched = true;
                } else tried.push('notes store: no note with this title');
              } else tried.push('notes store: no notes returned');
            } catch (e) { tried.push(`notes store: ${e.message}`); }
          }

          if (!fetched) {
            setContentSource('none');
            // R-05 — every source used to fail into a bare catch, so a total
            // failure could not say what it had tried. Now it can.
            setFileContent(
              `Could not load this document.\n\nNode: ${nodeId}\n\nSources tried:\n`
              + tried.map(t => `  • ${t}`).join('\n')
            );
          }
        } catch (error) {
          setFileContent(`Error fetching file: ${error.message}`);
        } finally {
          setIsLoadingFile(false);
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => {
      clearTimeout(timer);
      setMounted(false);
      window.removeEventListener('message', handleMessage);
    };
  }, []);

  // ── AI: Ask a question about the document ──────────────────────────────────

  const askQuestion = async () => {
    if (!qaQuestion.trim() || !aiText.trim()) return;
    setQaLoading(true); setQaAnswer(''); setQaScope('');
    try {
      const { context, scope } = pickContext(qaQuestion, aiText);
      setQaScope(scope);
      const r = await fetch('/api/kernel/llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          background: true,
          prompt: `You are AEON, an AI assistant. Answer the user's question using ONLY the provided document context. The context is the most relevant section(s) of a larger document (retrieved scope: ${scope}). If the answer isn't in the context, say so clearly.\n\nDOCUMENT CONTEXT:\n${context}\n\nQUESTION: ${qaQuestion}\n\nANSWER:`,
          role: 'analyst'
        })
      });
      const d = await r.json();
      if (!r.ok) {
        setQaAnswer('Error: ' + (d.error || `LLM error ${r.status}`));
      } else {
        setQaAnswer(d.text || 'No answer generated.');
      }
    } catch (e) {
      setQaAnswer('Error: ' + e.message);
    }
    setQaLoading(false);
  };

  // ── AI: Summarize ──────────────────────────────────────────────────────────

  const llm = async (prompt) => {
    const r = await fetch('/api/kernel/llm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, role: 'analyst', background: true }),
    });
    const d = await r.json();
    if (!r.ok) {
      throw new Error(d.error || `LLM error ${r.status}`);
    }
    return d.text || '';
  };

  const summarizeDoc = async () => {
    if (!aiText.trim()) return;
    setSummaryLoading(true); setSummary(''); setSummaryProgress('');
    const detail = sumDetail === 'detailed'
      ? 'Write a detailed summary (2-4 paragraphs) covering plot points, key details, and important moments in order.'
      : 'Summarize in 3-5 concise sentences capturing the key points.';
    try {
      // Single chapter selected — summarize just that slice
      if (chapterSel !== 'all' && chapters[chapterSel]) {
        const ch = chapters[chapterSel];
        const text = await llm(`${detail}\n\nThis is "${ch.title}" from a larger document.\n\nTEXT:\n${ch.text.slice(0, 14000)}\n\nSUMMARY:`);
        setSummary(text || 'No summary generated.');
      }
      // Whole document — map-reduce: summarize each chapter, then combine
      else if (chapters.length > 1 && aiText.length > 13000) {
        const parts = [];
        const capped = chapters.slice(0, 25);
        for (let i = 0; i < capped.length; i++) {
          setSummaryProgress(`Summarizing ${i + 1}/${capped.length}: ${capped[i].title}`);
          const s = await llm(`Summarize this section in 2-3 sentences. Capture what happens and any key details.\n\nSECTION ("${capped[i].title}"):\n${capped[i].text.slice(0, 12000)}\n\nSUMMARY:`);
          parts.push(`${capped[i].title}: ${s.trim()}`);
        }
        setSummaryProgress('Combining...');
        const combined = await llm(`${detail}\n\nBelow are per-chapter summaries of a document. Combine them into one coherent summary of the whole document.\n\n${parts.join('\n\n')}\n\nOVERALL SUMMARY:`);
        setSummary(`${combined.trim()}\n\n───── Per chapter ─────\n\n${parts.join('\n\n')}`);
      }
      // Short doc — one shot
      else {
        const text = await llm(`${detail}\n\nDOCUMENT:\n${fileContent.slice(0, 14000)}\n\nSUMMARY:`);
        setSummary(text || 'No summary generated.');
      }
    } catch (e) {
      setSummary('Error: ' + e.message);
    }
    setSummaryProgress('');
    setSummaryLoading(false);
  };

  // ── Keyword Search ─────────────────────────────────────────────────────────

  const keywordSearch = (query) => {
    setSearchQuery(query);
    if (!query.trim() || !aiText) { setSearchResults([]); return; }
    const lines = aiText.split('\n');
    const q = query.toLowerCase();
    const results = [];
    lines.forEach((line, i) => {
      if (line.toLowerCase().includes(q)) {
        results.push({ line: i + 1, text: line.trim() });
      }
    });
    setSearchResults(results.slice(0, 50));
  };

  // ── Save to Memory ────────────────────────────────────────────────────────

  // Save status for the Memory buttons. Previously this function ended in a
  // bare `catch {}` and set no state on success either — so pressing Memory was
  // indistinguishable from a no-op no matter what the server did. The route was
  // mounted and the request was fine; the outcome simply never reached the UI.
  //
  // Listen, right next to it, appears to work for one reason: it is a synchronous
  // setViewMode() whose feedback never depends on a network call. That difference
  // was the entire bug. EditorMode.jsx in this same block already does this
  // correctly — same pattern, kept deliberately consistent.
  const [memoryStatus, setMemoryStatus] = useState('');
  const memoryStatusTimer = useRef(null);
  const flashMemoryStatus = (msg, holdMs = 2500) => {
    setMemoryStatus(msg);
    clearTimeout(memoryStatusTimer.current);
    memoryStatusTimer.current = setTimeout(() => setMemoryStatus(''), holdMs);
  };

  const saveToMemory = async (contentToSave, titlePrefix = 'Document') => {
    const text = contentToSave || aiText;
    if (!text) { flashMemoryStatus('⚠ Nothing to save yet.'); return; }
    const fileName = selectedFile?.split(/[/\\]/).pop() || 'Unknown';
    setMemoryStatus('Saving…');
    try {
      const response = await fetch('/api/memory/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `${titlePrefix}: ${fileName}`,
          text: text.slice(0, 8000),
          category: titlePrefix === 'Q&A' ? 'decision' : 'fact',
          type: titlePrefix.toLowerCase(),
          tags: ['aeon_matrix', titlePrefix.toLowerCase()],
          source: 'aeon_matrix',
          refs: selectedFile ? [{ kind: 'matrix-node', id: selectedFile, title: fileName }] : [],
        })
      });
      if (!response.ok) {
        let reason = `${response.status}`;
        try { reason = (await response.json())?.error || reason; } catch { /* non-JSON body */ }
        throw new Error(reason);
      }
      flashMemoryStatus('✅ Saved to Memory Core');
    } catch (e) {
      flashMemoryStatus(`❌ Save failed: ${e.message}`, 5000);
    }
  };

  // ── Tab rendering ──────────────────────────────────────────────────────────

  const renderTabContent = () => {
    if (isLoadingFile) {
      return <div style={{ color: '#00e5ff', textAlign: 'center', marginTop: '50px' }}>Decrypting neural block...</div>;
    }

    if (viewMode === 'EDIT') {
      return <EditorMode nodeId={selectedFile} initialContent={fileContent} onSave={(c) => setFileContent(c)} onCancel={() => setViewMode('READ')} />;
    }

    if (viewMode === 'LISTEN') {
      {/* aiText is always a narratable STRING (raw text, or server-extracted
          text for PDFs). fileContent is an <iframe> element for PDFs, which
          stringifies to "[object Object]" — never hand that to the narrator. */}
      return <NarratorPlayer nodeId={selectedFile} content={aiText || (typeof fileContent === 'string' ? fileContent : '')} onClose={() => setViewMode('READ')} />;
    }

    // PDF text still extracting (or failed) — Ask/Summary/Search need aiText
    if (activeTab !== 'read' && !aiText) {
      return (
        <div style={{ color: '#888', textAlign: 'center', marginTop: '50px', padding: '0 24px', fontSize: '13px', lineHeight: 1.7 }}>
          {aiTextStatus === 'loading' ? '⏳ Extracting text... Scanned PDFs and images run through OCR — this can take a minute the first time (results are cached).'
            : aiTextStatus === 'failed' ? '⚠️ Text extraction failed — no readable text found in this file.'
            : 'No text available for AI features on this document.'}
        </div>
      );
    }

    switch (activeTab) {
      case 'read':
        return (
          <div style={{ padding: '20px', overflowY: 'auto', flex: 1, lineHeight: '1.6', whiteSpace: 'pre-wrap', fontSize: '0.9rem' }}>
            {fileContent}
          </div>
        );

      case 'ask':
        return (
          <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px', flex: 1, overflowY: 'auto' }}>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input ref={qaInputRef} value={qaQuestion} onChange={e => setQaQuestion(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') askQuestion(); }}
                placeholder="Ask a question about this document..."
                aria-label="Ask a question about this document"
                className="input"
                style={{ flex: 1, background: '#111', border: '1px solid #333', borderRadius: '6px', padding: '8px 12px', color: '#E0E0E0', fontSize: '13px', outline: 'none' }} />
              <button onClick={askQuestion} disabled={qaLoading}
                style={{ padding: '8px 16px', background: '#FFD700', color: '#000', border: 'none', borderRadius: '6px', cursor: qaLoading ? 'wait' : 'pointer', fontWeight: 600, fontSize: '12px' }}>
                {qaLoading ? '...' : 'Ask'}
              </button>
            </div>
            {chapters.length > 1 && (
              <div style={{ fontSize: '10px', color: '#666' }}>
                {chapters.length} chapters detected — ask "summarize chapter 3", "what happens in the last chapter", or any question (best-matching chapters are retrieved automatically).
              </div>
            )}
            {qaAnswer && (
              <div style={{ background: 'rgba(255,215,0,0.05)', border: '1px solid rgba(255,215,0,0.2)', borderRadius: '8px', padding: '14px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', flexWrap: 'wrap', gap: '6px' }}>
                  <span style={{ fontSize: '10px', color: '#FFD700', letterSpacing: '1px', textTransform: 'uppercase' }}>
                    Answer{qaScope ? <span style={{ color: '#666', textTransform: 'none', letterSpacing: 0 }}> · read: {qaScope}</span> : null}
                  </span>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button onClick={() => navigator.clipboard.writeText(qaAnswer)}
                      style={{ fontSize: '11px', background: 'none', border: '1px solid #444', borderRadius: '4px', color: '#999', padding: '2px 8px', cursor: 'pointer' }}>Copy</button>
                    <button onClick={() => saveToMemory(`Q: ${qaQuestion}\n\nA: ${qaAnswer}`, 'Q&A')}
                      style={{ fontSize: '11px', background: 'none', border: '1px solid #444', borderRadius: '4px', color: '#999', padding: '2px 8px', cursor: 'pointer' }}>💾 Save</button>
                  </div>
                </div>
                <div style={{ fontSize: '13px', lineHeight: '1.7', whiteSpace: 'pre-wrap', color: '#E0E0E0' }}>{qaAnswer}</div>
              </div>
            )}
          </div>
        );

      case 'summary':
        return (
          <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px', flex: 1, overflowY: 'auto' }}>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
              {chapters.length > 1 && (
                <select value={chapterSel} onChange={e => setChapterSel(e.target.value === 'all' ? 'all' : Number(e.target.value))}
                  aria-label="Summary scope"
                  style={{ background: '#111', border: '1px solid #333', borderRadius: '6px', padding: '7px 10px', color: '#E0E0E0', fontSize: '12px', maxWidth: '260px' }}>
                  <option value="all">Entire document ({chapters.length} chapters)</option>
                  {chapters.map((c, i) => <option key={i} value={i}>{c.title}</option>)}
                </select>
              )}
              <div style={{ display: 'inline-flex', border: '1px solid #333', borderRadius: '6px', overflow: 'hidden' }}>
                {['brief', 'detailed'].map(m => (
                  <button key={m} onClick={() => setSumDetail(m)}
                    style={{ padding: '7px 12px', fontSize: '11px', border: 'none', cursor: 'pointer',
                      background: sumDetail === m ? '#FFD700' : 'transparent', color: sumDetail === m ? '#000' : '#888' }}>
                    {m === 'brief' ? 'Brief' : 'Detailed'}
                  </button>
                ))}
              </div>
              <button onClick={summarizeDoc} disabled={summaryLoading}
                style={{ padding: '8px 16px', background: '#FFD700', color: '#000', border: 'none', borderRadius: '6px', cursor: summaryLoading ? 'wait' : 'pointer', fontWeight: 600, fontSize: '12px' }}>
                {summaryLoading ? 'Summarizing...' : '📋 Summarize'}
              </button>
              {summary && (
                <button onClick={() => saveToMemory(summary, 'Summary')}
                  style={{ padding: '8px 16px', background: 'none', border: '1px solid #444', borderRadius: '6px', color: '#999', cursor: 'pointer', fontSize: '12px' }}>
                  💾 Save to Memory
                </button>
              )}
            </div>
            {chapterSel === 'all' && chapters.length > 1 && aiText.length > 13000 && !summaryLoading && !summary && (
              <div style={{ fontSize: '10px', color: '#666' }}>
                Entire document runs one AI call per chapter ({Math.min(chapters.length, 25)} calls) then combines them. Pick a single chapter for a faster, cheaper summary.
              </div>
            )}
            {summaryProgress && (
              <div style={{ fontSize: '11px', color: '#FFD700' }}>{summaryProgress}</div>
            )}
            {summary && (
              <div style={{ background: 'rgba(255,215,0,0.05)', border: '1px solid rgba(255,215,0,0.2)', borderRadius: '8px', padding: '14px', fontSize: '13px', lineHeight: '1.7', whiteSpace: 'pre-wrap', color: '#E0E0E0' }}>
                {summary}
              </div>
            )}
          </div>
        );

      case 'search':
        return (
          <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px', flex: 1, overflowY: 'auto' }}>
            <input value={searchQuery} onChange={e => keywordSearch(e.target.value)}
              placeholder="Search keywords in this document..."
              aria-label="Search keywords in this document"
              className="input"
              style={{ background: '#111', border: '1px solid #333', borderRadius: '6px', padding: '8px 12px', color: '#E0E0E0', fontSize: '13px', outline: 'none' }} />
            {searchResults.length > 0 && (
              <div style={{ fontSize: '11px', color: '#999' }}>{searchResults.length} match{searchResults.length !== 1 ? 'es' : ''}</div>
            )}
            {searchResults.map((r, i) => (
              <div key={i} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid #222', borderRadius: '6px', padding: '10px 12px', fontSize: '12px' }}>
                <span style={{ color: '#FFD700', fontSize: '10px', marginRight: '8px' }}>Line {r.line}</span>
                <span style={{ color: '#E0E0E0', lineHeight: '1.5' }}>{r.text}</span>
              </div>
            ))}
            {searchQuery && searchResults.length === 0 && (
              <div style={{ color: '#666', fontSize: '12px', textAlign: 'center', marginTop: '20px' }}>No matches found.</div>
            )}
          </div>
        );

      default:
        return null;
    }
  };

  const isTextContent = typeof fileContent === 'string';

  return (
    <div style={{ width: '100%', flex: 1, minHeight: 520, height: '100%', overflow: 'hidden', position: 'relative', backgroundColor: '#000' }}>
      {!mounted && (
        <div style={{ display: 'flex', width: '100%', height: '100%', justifyContent: 'center', alignItems: 'center', color: '#888' }}>
          <p>Initializing Neural Interface...</p>
        </div>
      )}

      {mounted && (
        <iframe src="/api/crn/second-brain/visualizer" style={{ width: '100%', height: '100%', border: 'none', display: 'block' }} title="Second Brain Visualizer" />
      )}

      {/* File Viewer Overlay */}
      {selectedFile && (
        <div style={{
          position: 'absolute', right: '0', top: '0',
          width: isMobile ? '100%' : '45vw', minWidth: isMobile ? '320px' : '500px', maxWidth: '1200px',
          height: '100%', backgroundColor: 'rgba(11, 15, 25, 0.95)',
          borderLeft: '1px solid #FFD700', boxShadow: '-5px 0 20px rgba(0,0,0,0.8)',
          zIndex: 20, display: 'flex', flexDirection: 'column', color: '#E0E0E0', fontFamily: 'Inter, sans-serif'
        }}>
          {/* Header */}
          <div style={{
            padding: '12px 16px', borderBottom: '1px solid rgba(255, 215, 0, 0.3)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px'
          }}>
            <h3 title={selectedFile} style={{ margin: 0, color: '#FFD700', fontSize: '1rem', wordBreak: 'break-all', flex: 1, minWidth: '150px' }}>
              📄 {selectedFile.split(/[/\\]/).pop()}
            </h3>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              {/* D2d — Edit is offered only when there is a local file to
                  write back to. Content served from the cloud index or the
                  notes store has no path on disk, and offering Edit there
                  produced a save that failed with "File not found" AFTER the
                  operator had typed. The label says which case this is
                  instead of the button silently disappearing. */}
              {isTextContent && (selectedFile.endsWith('.md') || selectedFile.endsWith('.txt')) && viewMode === 'READ' && (
                contentSource === 'disk' ? (
                  <button onClick={() => setViewMode('EDIT')}
                    style={{ background: '#333', color: '#fff', border: '1px solid #555', padding: '4px 10px', borderRadius: '4px', cursor: 'pointer', fontSize: '11px' }}>
                    ✏️ Edit
                  </button>
                ) : (contentSource === 'cloud' || contentSource === 'notes') && (
                  <span
                    title={contentSource === 'cloud'
                      ? 'This came from the cloud index, not a file on this machine. Run a scan to bring it local before editing.'
                      : 'This came from the notes store, not a file on this machine.'}
                    style={{ color: '#8aa0b8', fontSize: '11px', border: '1px solid #333', padding: '4px 10px', borderRadius: '4px' }}>
                    ✏️ Edit — no local file ({contentSource})
                  </span>
                )
              )}
              {viewMode === 'READ' && (
                <button onClick={() => setViewMode('LISTEN')}
                  style={{ background: '#d4795a', color: '#fff', border: 'none', padding: '4px 10px', borderRadius: '4px', cursor: 'pointer', fontSize: '11px' }}>
                  🎙️ Listen
                </button>
              )}
              {memoryStatus && (
                <span style={{
                  fontSize: '11px', marginRight: '4px',
                  color: memoryStatus.startsWith('❌') ? '#ff6b6b'
                    : memoryStatus.startsWith('✅') ? '#22d36f' : '#999',
                }}>
                  {memoryStatus}
                </span>
              )}
              {!!aiText && viewMode === 'READ' && (
                <button onClick={() => saveToMemory(null, 'Document')}
                  disabled={memoryStatus === 'Saving…'}
                  style={{ background: 'none', color: '#999', border: '1px solid #444', padding: '4px 10px', borderRadius: '4px', cursor: memoryStatus === 'Saving…' ? 'default' : 'pointer', fontSize: '11px' }}>
                  💾 Memory
                </button>
              )}
              <button onClick={() => setSelectedFile(null)} aria-label="Close document viewer"
                style={{ background: 'transparent', border: 'none', color: '#888', cursor: 'pointer', fontSize: '1.2rem', marginLeft: '6px' }}>
                ✕
              </button>
            </div>
          </div>

          {/* Tabs — shown for text docs and for PDFs once/while text extraction runs */}
          {(isTextContent || aiTextStatus !== '') && viewMode === 'READ' && (
            <div style={{
              display: 'flex', gap: '0', borderBottom: '1px solid rgba(255,215,0,0.15)', padding: '0 16px', flexShrink: 0
            }}>
              {[
                { id: 'read', label: '📖 Read' },
                { id: 'ask', label: '💬 Ask' },
                { id: 'summary', label: '📋 Summary' },
                { id: 'search', label: '🔍 Search' },
              ].map(tab => (
                <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                  style={{
                    padding: '8px 14px', fontSize: '12px', background: 'none', border: 'none',
                    borderBottom: activeTab === tab.id ? '2px solid #FFD700' : '2px solid transparent',
                    color: activeTab === tab.id ? '#FFD700' : '#888',
                    cursor: 'pointer', transition: 'all 0.15s'
                  }}>
                  {tab.label}
                </button>
              ))}
            </div>
          )}

          {/* Content */}
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {renderTabContent()}
          </div>
        </div>
      )}
    </div>
  );
};

export default SecondBrainVisualizer;
