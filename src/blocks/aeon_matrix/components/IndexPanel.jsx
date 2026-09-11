/**
 * Matrix ▸ Index — run the indexer by hand, and see what embedding actually did.
 *
 * Two surfaces told the operator to "rebuild the index" — the Matrix help card
 * and Orion's empty-vault warning — and neither pointed at anything that could
 * do it. The only trigger was a terminal slash command (CEO, 2026-09-10).
 *
 * What this panel refuses to blur: INDEXING and EMBEDDING are two jobs on one
 * run. Indexing reads files into the Table of Contents and always works.
 * Embedding attaches a vector so recall can match by meaning, and it only
 * happens if a model is serving the embed role. A vault can be fully indexed
 * and entirely unsearchable by meaning; before this, nothing said so.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader, Play, RefreshCw, AlertTriangle, CheckCircle2, Database, Sparkles } from 'lucide-react';

const NUM = (n) => (typeof n === 'number' ? n.toLocaleString() : '—');

/** "3 minutes ago" beats an ISO string nobody reads as a duration. */
function ago(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return new Date(iso).toLocaleString();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

function Stat({ label, value, tone, title }) {
  return (
    <div title={title} style={{
      border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px',
      background: 'var(--surface-1)', minWidth: 108, flex: '1 1 108px',
    }}>
      <div style={{ fontSize: 20, fontWeight: 700, fontFamily: 'var(--font-mono)', color: tone || 'var(--text)', lineHeight: 1.2 }}>{value}</div>
      <div style={{ fontSize: 10, letterSpacing: '.08em', color: 'var(--text-dim)', marginTop: 2 }}>{label}</div>
    </div>
  );
}

export default function IndexPanel() {
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState(null);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState([]);       // newest last, capped
  const [counts, setCounts] = useState(null); // live tally for this run
  const [result, setResult] = useState(null); // the run's own {done:true,...}
  const [runError, setRunError] = useState(null);
  const logRef = useRef(null);

  const loadStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/crn/second-brain/index-status');
      if (!r.ok) throw new Error(`index-status returned ${r.status}`);
      const d = await r.json();
      setStatus(d); setStatusError(null);
      // A scan started elsewhere (boot sync, the nightly timer, the terminal)
      // owns the button too — otherwise two runs look startable at once.
      if (d.running) setRunning(true);
    } catch (e) { setStatusError(e.message); }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  // Keep the tail in view while a run streams.
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [log]);

  const push = (line) => setLog(prev => (prev.length > 400 ? [...prev.slice(-400), line] : [...prev, line]));

  const run = useCallback(async () => {
    if (running) return;
    setRunning(true); setLog([]); setResult(null); setRunError(null);
    setCounts({ indexed: 0, embedded: 0, migrated: 0, chunked: 0, deleted: 0, failed: 0 });
    const bump = (k) => setCounts(c => ({ ...c, [k]: (c?.[k] || 0) + 1 }));
    try {
      // SSE over POST: EventSource cannot POST, so the stream is read off the
      // fetch body directly. The server keeps scanning even if this read stops
      // (a closed tab must not kill a run), so leaving the page is safe.
      const res = await fetch('/api/crn/second-brain/ingest/scan-docs', { method: 'POST' });
      if (!res.ok) throw new Error(`the indexer returned ${res.status}`);
      if (!res.body) throw new Error('this browser cannot stream the index run');
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const frames = buf.split('\n\n');
        buf = frames.pop();
        for (const frame of frames) {
          const line = frame.split('\n').find(l => l.startsWith('data: '));
          if (!line) continue;
          let ev; try { ev = JSON.parse(line.slice(6)); } catch { continue; }

          if (ev.done) { setResult(ev); continue; }
          if (ev.joined) { push({ kind: 'note', text: ev.message }); continue; }
          if (ev.error) { bump('failed'); push({ kind: 'error', text: `${ev.file} — ${ev.error}` }); continue; }
          if (ev.deleted) { bump('deleted'); push({ kind: 'deleted', text: ev.file }); continue; }
          if (ev.action === 'embed-backfill') { bump('embedded'); push({ kind: 'embed', text: ev.file }); continue; }
          if (ev.action === 'space-migrate') { bump('migrated'); push({ kind: 'embed', text: `${ev.file} — re-embedded into ${ev.to}` }); continue; }
          if (ev.action === 'chunk-backfill') { bump('chunked'); push({ kind: 'note', text: `${ev.file} — ${ev.chunks} chunks` }); continue; }
          if (ev.file) { bump('indexed'); push({ kind: 'file', text: ev.file }); }
        }
      }
    } catch (e) {
      setRunError(e.message);
    } finally {
      setRunning(false);
      loadStatus();
    }
  }, [running, loadStatus]);

  const emb = status?.embedding || null;
  const canEmbed = !!emb?.available;
  const pending = emb?.pending ?? 0;

  // The button says what this particular press will DO. With vectors owed and a
  // model present it is an embed push; with none owed it is an ordinary rescan.
  const label = running
    ? 'Indexing…'
    : canEmbed && pending > 0
      ? `Push embeddings (${NUM(pending)})`
      : 'Run index';

  return (
    <div style={{ paddingBottom: 24, display: 'grid', gap: 14 }}>

      {statusError && (
        <div style={{ border: '1px solid var(--coral)', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: 'var(--coral)' }}>
          Could not read the index status — {statusError}
        </div>
      )}

      {/* ── The numbers, and what each one means for recall ── */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <Stat label="DOCUMENTS" value={NUM(emb?.documents ?? status?.totalDocs)} title="Files in the Table of Contents." />
        <Stat label="EMBEDDED" value={NUM(emb?.embedded)} tone={emb?.embedded ? 'var(--accent)' : 'var(--text-dim)'}
          title="Documents carrying a vector — the only ones meaning-based recall can match." />
        <Stat label="NO VECTOR" value={NUM(emb?.missing)} tone={emb?.missing ? '#ffaa00' : 'var(--text-dim)'}
          title="Indexed, but invisible to meaning-based recall until embedded." />
        <Stat label="STALE SPACE" value={NUM(emb?.stale)} tone={emb?.stale ? '#ffaa00' : 'var(--text-dim)'}
          title="Embedded by a different model than the one serving now. Vectors from two spaces cannot be compared, so these are re-embedded." />
        <Stat label="LAST RUN" value={ago(status?.lastRun)} title={status?.lastRun || 'no run recorded'} />
      </div>

      {/* ── The embedder, named, or the remedy ── */}
      <div style={{
        border: '1px solid var(--border)', borderLeft: `3px solid ${canEmbed ? 'var(--accent)' : '#ffaa00'}`,
        borderRadius: 8, padding: '12px 14px', background: 'var(--surface-1)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          {canEmbed ? <Sparkles size={13} style={{ color: 'var(--accent)' }} /> : <AlertTriangle size={13} style={{ color: '#ffaa00' }} />}
          <strong style={{ fontSize: 12.5 }}>{canEmbed ? 'Embedding model ready' : 'No embedding model'}</strong>
          {canEmbed && (
            <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)', border: '1px solid var(--border)', borderRadius: 999, padding: '2px 8px' }}>
              {emb.provider} · {emb.model}
            </span>
          )}
        </div>
        <p style={{ margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--text-dim)' }}>
          {canEmbed
            ? pending > 0
              ? <>Indexing will attach vectors to <strong style={{ color: 'var(--text)' }}>{NUM(pending)}</strong> document{pending === 1 ? '' : 's'} that need one. Nothing is re-read: only the missing vectors are filled in.</>
              : <>Every indexed document carries a current vector. Running again picks up new and changed files only.</>
            : <>Indexing still works and still finds documents by keyword. Vectors are what let recall match meaning rather than wording, and none can be written until a model serves the Embedding role. Install one in Cookbook (nomic-embed, about 150&nbsp;MB, runs on CPU), or assign an endpoint in Settings → Model Assignment — then run this again to backfill.</>}
        </p>
        {canEmbed && emb.spaces?.length > 1 && (
          <p style={{ margin: '8px 0 0', fontSize: 11.5, color: '#ffaa00' }}>
            Vectors from {emb.spaces.length} different models are on disk. Only the active space is searchable; the rest are re-embedded on the next run.
          </p>
        )}
      </div>

      {/* ── Trigger ── */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={run} disabled={running} aria-label={label} style={{
          display: 'flex', alignItems: 'center', gap: 7, padding: '9px 18px', borderRadius: 6,
          fontSize: 12, fontWeight: 700, cursor: running ? 'default' : 'pointer',
          border: '1px solid var(--accent)', background: running ? 'transparent' : 'var(--accent-dim)',
          color: 'var(--accent)', opacity: running ? 0.6 : 1,
        }}>
          {running ? <Loader size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Play size={13} />}
          {label}
        </button>
        <button onClick={loadStatus} disabled={running} aria-label="Refresh index status" style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '9px 14px', borderRadius: 6,
          fontSize: 11.5, cursor: running ? 'default' : 'pointer',
          border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-dim)',
        }}><RefreshCw size={12} /> Refresh</button>
        <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
          Incremental — unchanged files are skipped. Safe to leave: the run continues if you close this.
        </span>
      </div>

      {runError && (
        <div style={{ border: '1px solid var(--coral)', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: 'var(--coral)' }}>
          The run stopped — {runError}
        </div>
      )}

      {/* ── Live tally ── */}
      {counts && (
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--text-dim)' }}>
          <span>indexed <strong style={{ color: 'var(--text)' }}>{counts.indexed}</strong></span>
          <span>embedded <strong style={{ color: 'var(--accent)' }}>{counts.embedded}</strong></span>
          {counts.migrated > 0 && <span>re-embedded <strong style={{ color: 'var(--accent)' }}>{counts.migrated}</strong></span>}
          {counts.chunked > 0 && <span>chunked <strong style={{ color: 'var(--text)' }}>{counts.chunked}</strong></span>}
          {counts.deleted > 0 && <span>removed <strong style={{ color: 'var(--text)' }}>{counts.deleted}</strong></span>}
          {counts.failed > 0 && <span style={{ color: 'var(--coral)' }}>failed <strong>{counts.failed}</strong></span>}
        </div>
      )}

      {/* ── Outcome, stated rather than implied by an empty log ── */}
      {result && (
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 8, border: '1px solid var(--border)',
          borderLeft: `3px solid ${result.errors?.length ? '#ffaa00' : 'var(--accent)'}`,
          borderRadius: 8, padding: '10px 14px', fontSize: 12, color: 'var(--text-dim)',
        }}>
          {result.errors?.length ? <AlertTriangle size={13} style={{ color: '#ffaa00', marginTop: 2 }} /> : <CheckCircle2 size={13} style={{ color: 'var(--accent)', marginTop: 2 }} />}
          <div>
            <strong style={{ color: 'var(--text)' }}>
              {result.ingested} ingested · {result.skipped} unchanged · {result.deleted} removed
            </strong>
            {result.reason && <div style={{ marginTop: 4 }}>{result.reason}</div>}
            {result.errors?.length > 0 && (
              <div style={{ marginTop: 4, color: '#ffaa00' }}>
                {result.errors.length} file{result.errors.length === 1 ? '' : 's'} could not be read — they stay out of the index rather than being indexed empty.
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── The stream itself ── */}
      {log.length > 0 && (
        <div ref={logRef} style={{
          maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border-mute)', borderRadius: 6,
          background: 'var(--surface-1)', padding: '8px 12px', fontFamily: 'var(--font-mono)', fontSize: 10.5, lineHeight: 1.7,
        }}>
          {log.map((l, i) => (
            <div key={i} style={{
              color: l.kind === 'error' ? 'var(--coral)'
                : l.kind === 'embed' ? 'var(--accent)'
                : l.kind === 'deleted' ? 'var(--text-faint)'
                : 'var(--text-dim)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              <span style={{ color: 'var(--text-faint)', marginRight: 8 }}>
                {l.kind === 'embed' ? 'embed' : l.kind === 'deleted' ? 'del' : l.kind === 'error' ? 'fail' : l.kind === 'note' ? 'note' : 'idx'}
              </span>
              {l.text}
            </div>
          ))}
        </div>
      )}

      {!running && !log.length && !result && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--text-faint)' }}>
          <Database size={12} /> Nothing has run in this session. The index also refreshes on boot and once a night.
        </div>
      )}
    </div>
  );
}
