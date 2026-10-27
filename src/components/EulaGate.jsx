import React, { useCallback, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * EulaGate — the AEON License Agreement (EULA.md), shown before anything else
 * on first start and again whenever its version changes. It cannot be
 * dismissed: the kernel answers its API with 428 EULA_REQUIRED until the agreement is
 * accepted (src/kernel/eula.cjs), so this screen is the way in, not the lock.
 *
 * If the agreement endpoint cannot be read (an older server, the kernel down),
 * the app renders as before: the server, not this screen, is what enforces it.
 */
const S = {
  overlay: { minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: 'rgba(5,9,18,0.96)', color: '#dce8f5', boxSizing: 'border-box' },
  panel: { width: 'min(720px, 100%)', background: 'rgba(10,16,26,0.98)', border: '1px solid rgba(0,242,255,0.22)', borderRadius: 14, padding: 28, boxSizing: 'border-box' },
  h1: { margin: '0 0 6px', fontSize: 20, color: '#00f2ff' },
  sub: { fontSize: 13, color: '#8aa0b8', lineHeight: 1.6, margin: '0 0 16px' },
  text: { maxHeight: '52vh', overflowY: 'auto', background: '#0b0f19', border: '1px solid #1e2d45', borderRadius: 8, padding: '4px 18px', fontSize: 13, lineHeight: 1.6, color: '#c8d4e0' },
  row: { display: 'flex', gap: 10, alignItems: 'flex-start', margin: '16px 0 0', fontSize: 13, color: '#dce8f5', cursor: 'pointer' },
  actions: { display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 18, flexWrap: 'wrap' },
  btn: { background: 'rgba(0,242,255,0.14)', border: '1px solid #00f2ff', color: '#00f2ff', padding: '9px 20px', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 },
  btnOff: { opacity: 0.4, cursor: 'not-allowed' },
  btnGhost: { background: 'transparent', border: '1px solid #33445c', color: '#8aa0b8', padding: '9px 20px', borderRadius: 6, cursor: 'pointer', fontSize: 13 },
  msgErr: { color: '#ff4455', fontSize: 12.5, marginTop: 12 },
  msgInfo: { color: '#8aa0b8', fontSize: 12.5, marginTop: 12 },
  link: { color: '#00f2ff' },
};

// EULA.md links its sibling files (LICENSE, TERMS_OF_USE.md, PRIVACY.md) by
// relative path, which the AEON server does not serve. Point those at the
// published copies; absolute links and mail links are kept as written.
const REPO = 'https://github.com/cgomez1365/AEON/blob/main/';
function Link({ href = '', children }) {
  const abs = /^(https?:|mailto:)/i.test(href) ? href : REPO + href.replace(/^\.?\//, '');
  return <a href={abs} target="_blank" rel="noopener noreferrer" style={S.link}>{children}</a>;
}

export default function EulaGate({ children }) {
  const [state, setState] = useState({ loading: true, accepted: true });
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [declined, setDeclined] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/eula');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setState({ loading: false, accepted: d.accepted === true, version: d.version, text: d.text || '', previousVersion: d.previousVersion || null });
    } catch {
      setState({ loading: false, accepted: true });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const accept = useCallback(async () => {
    if (!agreed || busy) return;
    setBusy(true); setError('');
    try {
      const r = await fetch('/api/eula/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: state.version }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.success) {
        setError(d.hint || d.detail || `The agreement could not be recorded (HTTP ${r.status}).`);
        setBusy(false);
        return;
      }
      // Everything that loaded before acceptance got 428s; start clean.
      window.location.reload();
    } catch (e) {
      setError(`The agreement could not be recorded: ${e.message}`);
      setBusy(false);
    }
  }, [agreed, busy, state.version]);

  if (state.loading) return null;
  if (state.accepted) return children;

  return (
    <div style={S.overlay}>
      <div style={S.panel} role="dialog" aria-modal="true" aria-labelledby="eula-title">
        <h1 id="eula-title" style={S.h1}>Before you start: the AEON License Agreement</h1>
        <p style={S.sub}>
          {state.previousVersion
            ? `The agreement changed (you accepted version ${state.previousVersion}; this is version ${state.version}). Please read it and accept it to keep using AEON.`
            : `Please read the agreement (version ${state.version}) and accept it to use AEON. You only do this once per version.`}
        </p>
        <div style={S.text} tabIndex={0} aria-label="Agreement text">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: Link }}>{state.text}</ReactMarkdown>
        </div>
        <label style={S.row}>
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} aria-label="I agree" />
          <span>I am 18 or older (or the age of majority where I live), and I have read and agree to the AEON License Agreement, version {state.version}, including the Community License, Terms of Use and Privacy notice it names.</span>
        </label>
        {declined && (
          <p style={S.msgInfo}>AEON can't be used without the agreement. You can close this window; nothing was changed.</p>
        )}
        {error && <p style={S.msgErr}>{error}</p>}
        <div style={S.actions}>
          <button type="button" style={S.btnGhost} onClick={() => setDeclined(true)}>I do not agree</button>
          <button type="button" style={{ ...S.btn, ...(agreed && !busy ? null : S.btnOff) }} disabled={!agreed || busy} onClick={accept}>
            {busy ? 'Saving…' : 'I agree, continue'}
          </button>
        </div>
      </div>
    </div>
  );
}
