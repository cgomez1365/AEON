/**
 * Master — the block standard, made operable.
 *
 * This page used to be documentation only: four rules and a copy-paste prompt
 * telling the operator to duplicate src/blocks/master/, rename the folder and
 * ship. That path lands code in src/blocks/ having touched no gate — no
 * manifest validation, no code scan, no complexity gate, no approval queue.
 * The canonical reference block documented the route around the airlock.
 *
 * It now drives that airlock, which already existed and had no front end:
 *
 *   Scaffold  POST /api/build/scaffold  → an envelope, no files written
 *   Check     POST /api/build/validate  → every gate, still no files written
 *   Submit    POST /api/build/submit    → stage → lint → LOW auto-promote,
 *                                         MEDIUM/HIGH → approval queue
 *   Queue     GET/POST /api/build/queue/*  → approve or reject
 *
 * Master renders; it never adjudicates. Every verdict on this page comes from
 * src/kernel/staging.cjs and src/kernel/complexityGate.cjs — the same code the
 * CLI and the tests call. Adding a rule here instead of there would create a
 * second truth, which is the defect this block exists to stop repeating.
 *
 * Accessibility patterns demonstrated here (copy these, not just the JSX):
 *   - Every fetch() call is relative ('/blocks/registry', never a hardcoded
 *     host:port) — Vite proxies /blocks, /core, /api, etc. to the kernel in
 *     dev, and same-origin already works in every deployed target. Any
 *     "which host am I on" display text reads window.location, never a
 *     literal string — a literal 'localhost:3001' is a lie on Vercel/Docker.
 *   - Icons placed next to visible text get aria-hidden="true": the icon is
 *     decorative, the adjacent text is already the accessible name, so a
 *     screen reader should not announce the glyph a second time.
 *   - Section labels use real <h3> elements (not styled <div>s) so screen
 *     reader users can jump between sections with heading navigation.
 *   - Repeated item groups render as <ul role="list">/<li> — role="list" is
 *     required because list-style: none strips list semantics in
 *     Safari/VoiceOver otherwise.
 *   - Async-loaded values sit in an aria-live="polite" region so screen
 *     readers announce the update instead of staying silent.
 *   - Icon-only controls get aria-label and keep the browser's default focus
 *     ring (no `outline: none` — WCAG 2.4.7).
 */
import React, { useState, useEffect, useCallback } from 'react';
import { Card, StatCard } from '../../components/aurora';
import { Dna, FolderTree, Radio, LayoutGrid, RefreshCw, ShieldCheck, PackagePlus, Inbox } from 'lucide-react';

const ANATOMY = [
  ['block.manifest.json', 'Identity + contract. nav, permissions, commands, widget. Manifest is truth.'],
  ['index.jsx', 'The UI. Default-export one component. Use aurora primitives (Card, StatCard).'],
  ['api/<id>.cjs', 'Optional backend: module.exports = (deps) => router. Auto-mounted at /api/*.'],
  ['README.md', 'One paragraph: what it owns, what it reads, what it writes.'],
];

const RULES = [
  ['Folder is truth', 'The displayed name is derived from the folder name (my_block → "My Block"). The builder derives all three from one id, so they cannot drift.'],
  ['Never call what does not exist', 'Fetch only endpoints your own api/ provides or the kernel guarantees (/core, /api/ai, /blocks/registry).'],
  ['Declare a widget', 'Expose GET /api/<id>/widget + a manifest widget section, and the dashboard shows your quick-view automatically.'],
  ['Ask for nothing extra', 'Permissions start at the floor and the sandbox strips deps you did not declare. Every widening below is a deliberate choice.'],
];

const SEV_COLOR = { HIGH: 'var(--bad, #f85149)', MEDIUM: 'var(--warn, #d29922)', LOW: 'var(--ok, #3fb950)' };

const jpost = async (url, body) => {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
};

export default function Master() {
  const [tab, setTab] = useState('build');
  const [registry, setRegistry] = useState(null);
  const [kernel, setKernel] = useState('checking');

  const loadRegistry = useCallback(() => {
    fetch('/blocks/registry')
      .then((r) => r.json())
      .then((d) => { setRegistry(Array.isArray(d) ? d : d.blocks || []); setKernel('online'); })
      // Report it. An empty count that means "the fetch failed" is
      // indistinguishable from "no blocks", which is the bug class this
      // whole block exists to argue against.
      .catch((e) => { setKernel(`unreachable — ${e.message}`); });
  }, []);

  useEffect(() => { loadRegistry(); }, [loadRegistry]);

  return (
    <div className="block-root">
      <header style={{ marginBottom: 18 }}>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 10, margin: 0 }}>
          <Dna size={22} aria-hidden="true" /> Master
          <span style={{ fontSize: 10, letterSpacing: '.18em', padding: '3px 8px', borderRadius: 4, border: '1px solid var(--line, #272d39)', color: 'var(--dim, #9aa3b2)' }}>
            THE BLOCK STANDARD
          </span>
        </h2>
        <p style={{ color: 'var(--dim, #9aa3b2)', fontSize: 13, marginTop: 6 }}>
          Scaffold a block, run the real gates against it, and promote it through the approval
          queue — without touching the filesystem.
        </p>
      </header>

      <div aria-live="polite" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12, marginBottom: 18 }}>
        {/* StatCard renders `icon` directly as a child, so it takes an ELEMENT.
            Passing the bare lucide component here handed React a forwardRef
            object ({$$typeof, render, displayName}) and crashed the page with
            minified error #31 — "objects are not valid as a React child".
            The build compiled it happily: JSX cannot tell the difference. */}
        <StatCard icon={<LayoutGrid size={14} aria-hidden="true" />} label="Installed blocks"
          value={registry ? registry.length : '—'} sub="live from /blocks/registry" />
        <StatCard icon={<Radio size={14} aria-hidden="true" />} label="Kernel"
          value={kernel === 'online' ? 'ONLINE' : 'CHECK'}
          sub={kernel === 'online' ? window.location.host : kernel} />
      </div>

      <nav style={{ display: 'flex', gap: 6, marginBottom: 16, borderBottom: '1px solid var(--line, #272d39)' }}>
        {[['build', 'Build', PackagePlus], ['queue', 'Queue', Inbox], ['reference', 'Reference', FolderTree]].map(([id, label, Icon]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            aria-current={tab === id ? 'page' : undefined}
            style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: '9px 14px',
              fontSize: 13, color: tab === id ? 'var(--pu, #a78bfa)' : 'var(--dim, #9aa3b2)',
              borderBottom: tab === id ? '2px solid var(--pu, #a78bfa)' : '2px solid transparent',
              display: 'flex', alignItems: 'center', gap: 7,
            }}
          >
            <Icon size={14} aria-hidden="true" /> {label}
          </button>
        ))}
      </nav>

      {tab === 'build' && <BuildPanel onPromoted={loadRegistry} />}
      {tab === 'queue' && <QueuePanel onDecided={loadRegistry} />}
      {tab === 'reference' && <ReferencePanel registry={registry} onRefresh={loadRegistry} />}
    </div>
  );
}

/* ── M1 + M2 + M4 submit ────────────────────────────────────────────────── */

function BuildPanel({ onPromoted }) {
  const [form, setForm] = useState({
    id: '', label: '', description: '', category: 'tools', navGroup: 'tools',
    api: true, widget: true, storage: 'none', memory: 'none',
    network: 'internal', ai: false, secrets: false,
  });
  const [envelope, setEnvelope] = useState(null);
  const [check, setCheck] = useState(null);
  const [submitted, setSubmitted] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const set = (k, v) => {
    setForm((f) => ({ ...f, [k]: v }));
    // Any edit invalidates a previous verdict. Showing a stale green next to
    // changed inputs is the false-confidence failure, not a convenience.
    setEnvelope(null); setCheck(null); setSubmitted(null); setError('');
  };

  const runCheck = async () => {
    setBusy('check'); setError(''); setCheck(null); setSubmitted(null);
    try {
      const s = await jpost('/api/build/scaffold', form);
      if (!s.data?.ok) { setError(s.data?.error || 'scaffold failed'); return; }
      setEnvelope(s.data.payload);
      const v = await jpost('/api/build/validate', { source: 'local', ...s.data.payload });
      if (!v.data?.ok) { setError(v.data?.error || 'validate could not run'); return; }
      setCheck(v.data);
    } catch (e) { setError(e.message); } finally { setBusy(''); }
  };

  const submit = async () => {
    if (!envelope) return;
    setBusy('submit'); setError('');
    try {
      const r = await jpost('/api/build/submit', { source: 'local', ...envelope });
      setSubmitted({ status: r.status, ...r.data });
      if (r.data?.stage === 'live') onPromoted?.();
    } catch (e) { setError(e.message); } finally { setBusy(''); }
  };

  const field = { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--line, #272d39)', background: 'var(--panel2, #1b2029)', color: 'inherit', fontSize: 13 };
  const lbl = { display: 'block', fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--dim, #9aa3b2)', marginBottom: 5 };

  return (
    <>
      <Card>
        <h3 style={{ marginTop: 0 }}>1 · Scaffold</h3>
        <p style={{ fontSize: 12.5, color: 'var(--dim, #9aa3b2)' }}>
          One id becomes the folder name, the manifest id and the route — they cannot drift apart.
          Permissions start at the floor; widen only what the block genuinely needs.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: 12, marginTop: 14 }}>
          <div>
            <label style={lbl} htmlFor="mb-id">Block id</label>
            <input id="mb-id" style={field} value={form.id} placeholder="my_block"
              onChange={(e) => set('id', e.target.value)} />
          </div>
          <div>
            <label style={lbl} htmlFor="mb-label">Label <span style={{ textTransform: 'none' }}>(optional)</span></label>
            <input id="mb-label" style={field} value={form.label} placeholder="derived from id"
              onChange={(e) => set('label', e.target.value)} />
          </div>
          <div>
            <label style={lbl} htmlFor="mb-cat">Category</label>
            <select id="mb-cat" style={field} value={form.category} onChange={(e) => set('category', e.target.value)}>
              {['tools', 'intelligence', 'operations', 'analytics', 'business', 'system'].map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={lbl} htmlFor="mb-desc">Description</label>
            <input id="mb-desc" style={field} value={form.description} placeholder="One line: what this block owns."
              onChange={(e) => set('description', e.target.value)} />
          </div>
        </div>

        <h4 style={{ margin: '18px 0 8px', fontSize: 13 }}>Capabilities</h4>
        <ul role="list" style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
          <Toggle label="Backend API (api/<id>.cjs)" checked={form.api} onChange={(v) => set('api', v)}
            note="Adds a router with GET /api/<id>/status." />
          <Toggle label="Dashboard widget" checked={form.widget && form.api} disabled={!form.api} onChange={(v) => set('widget', v)}
            note={form.api ? 'Adds GET /api/<id>/widget and the manifest widget section.' : 'Needs a backend API to serve it.'} />
          <Toggle label="AI access" checked={form.ai} onChange={(v) => set('ai', v)}
            note="permissions.ai — lets the block call the kernel LLM." />
          <Toggle label="Vault secrets" checked={form.secrets} onChange={(v) => set('secrets', v)}
            note="permissions.secrets — read credentials from the vault." />
        </ul>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: 12, marginTop: 14 }}>
          <div>
            <label style={lbl} htmlFor="mb-store">Local storage</label>
            <select id="mb-store" style={field} value={form.storage} onChange={(e) => set('storage', e.target.value)}>
              <option value="none">none</option>
              <option value="json">json</option>
            </select>
          </div>
          <div>
            <label style={lbl} htmlFor="mb-mem">Vault memory</label>
            <select id="mb-mem" style={field} value={form.memory} onChange={(e) => set('memory', e.target.value)}>
              <option value="none">none</option>
              <option value="summary">summary</option>
              <option value="document">document</option>
            </select>
          </div>
          <div>
            <label style={lbl} htmlFor="mb-net">Network</label>
            <select id="mb-net" style={field} value={form.network} onChange={(e) => set('network', e.target.value)}>
              <option value="none">none</option>
              <option value="internal">internal</option>
              <option value="external">external</option>
            </select>
          </div>
        </div>
        {(form.storage !== 'none' || form.memory !== 'none') && (
          <p style={{ fontSize: 12, color: 'var(--warn, #d29922)', marginTop: 10 }}>
            Storage or memory means the block writes to disk, so it will be scaffolded with
            <code> permissions.filesystem = write</code>. The validator rejects the combination without it.
          </p>
        )}
        <p style={{ fontSize: 12, color: 'var(--dim, #9aa3b2)', marginTop: 10 }}>
          Shell access is never scaffolded. It is Tier 3 — it requires IDE mode and a deliberate
          approval, by design.
        </p>

        <button onClick={runCheck} disabled={!form.id.trim() || busy === 'check'}
          style={{ marginTop: 16, padding: '9px 16px', borderRadius: 6, cursor: form.id.trim() ? 'pointer' : 'not-allowed',
            border: '1px solid var(--pu, #a78bfa)', background: 'transparent', color: 'var(--pu, #a78bfa)', fontSize: 13,
            display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          <ShieldCheck size={15} aria-hidden="true" /> {busy === 'check' ? 'Checking…' : '2 · Check'}
        </button>
      </Card>

      {error && (
        <Card><p style={{ color: 'var(--bad, #f85149)', margin: 0, fontSize: 13 }}>{error}</p></Card>
      )}

      {check && <CheckResult check={check} onSubmit={submit} busy={busy === 'submit'} />}
      {submitted && <SubmitResult result={submitted} />}
    </>
  );
}

/**
 * A titled group of findings, and one finding line.
 *
 * These were used four times each in CheckResult/SubmitResult and never
 * defined — the page rendered until the operator pressed Check, then died
 * with "Section is not defined". A bare identifier reference is resolved at
 * RUNTIME, so neither the bundler nor the test suite had anything to complain
 * about; only mounting the component does.
 */
function Section({ title, children }) {
  return (
    <div style={{ marginTop: 14 }}>
      <h4 style={{ margin: '0 0 6px', fontSize: 12, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--dim, #9aa3b2)' }}>
        {title}
      </h4>
      {children}
    </div>
  );
}

function Finding({ sev = 'HIGH', check, file, why }) {
  const color = SEV_COLOR[sev] || SEV_COLOR.HIGH;
  return (
    <div style={{ borderLeft: `2px solid ${color}`, padding: '5px 0 5px 10px', margin: '6px 0' }}>
      <div style={{ fontSize: 11, fontFamily: 'var(--mono, monospace)', color }}>
        {sev}{check ? ` · ${check}` : ''}{file ? ` · ${file}` : ''}
      </div>
      {/* The gate's own words. Rewording them here would create a second
          vocabulary for one verdict — the thing Master exists not to do. */}
      <div style={{ fontSize: 12.5, color: 'var(--ink, #e6e9ef)' }}>{why}</div>
    </div>
  );
}

function Toggle({ label, note, checked, onChange, disabled }) {
  return (
    <li>
      <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1 }}>
        <input type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} style={{ marginTop: 3 }} />
        <span>
          <span style={{ fontSize: 13 }}>{label}</span>
          {note && <span style={{ display: 'block', fontSize: 11.5, color: 'var(--dim, #9aa3b2)' }}>{note}</span>}
        </span>
      </label>
    </li>
  );
}

function CheckResult({ check, onSubmit, busy }) {
  const { wouldPass, score, errors, findings, collisions, verdict, notChecked } = check;
  return (
    <Card>
      <h3 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 9 }}>
        Check result
        <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, color: SEV_COLOR[score], border: `1px solid ${SEV_COLOR[score]}` }}>
          {score}
        </span>
      </h3>

      <p style={{ fontSize: 13, color: wouldPass ? 'var(--ok, #3fb950)' : 'var(--bad, #f85149)' }}>
        {wouldPass
          ? 'Passes every check that can run before files exist.'
          : 'Would be refused. Nothing has been written.'}
      </p>

      {collisions.length > 0 && (
        <Section title="Collisions">
          {collisions.map((c, i) => <Finding key={i} sev="HIGH" why={c} />)}
        </Section>
      )}
      {errors.length > 0 && (
        <Section title="Manifest errors">
          {errors.map((e, i) => <Finding key={i} sev="HIGH" why={e} />)}
        </Section>
      )}
      {findings.length > 0 && (
        <Section title="Code findings">
          {findings.map((f, i) => <Finding key={i} sev={f.sev} check={f.check} file={f.file} why={f.why} />)}
        </Section>
      )}

      <Section title="Complexity gate">
        <p style={{ fontSize: 12.5, margin: '4px 0' }}>
          <strong style={{ color: SEV_COLOR[verdict.score] }}>{verdict.score}</strong>
          {verdict.behavior?.length ? ` — ${verdict.behavior.join(', ')}` : ''}
        </p>
        {verdict.reasons?.length > 0 && (
          <ul role="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {verdict.reasons.map((r, i) => (
              <li key={i} style={{ fontSize: 12, color: 'var(--dim, #9aa3b2)' }}>· {r}</li>
            ))}
          </ul>
        )}
        <p style={{ fontSize: 12, color: 'var(--dim, #9aa3b2)', marginTop: 8 }}>
          LOW promotes automatically. MEDIUM and HIGH go to the approval queue.
        </p>
      </Section>

      {/* §08 — say what this check does NOT cover, rather than let a green
          badge imply more coverage than it has. */}
      <p style={{ fontSize: 11.5, color: 'var(--dim, #9aa3b2)', marginTop: 12 }}>
        Not covered until the block is staged: {notChecked.join(', ')}.
      </p>

      <button onClick={onSubmit} disabled={busy}
        style={{ marginTop: 14, padding: '9px 16px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
          border: `1px solid ${wouldPass ? 'var(--ok, #3fb950)' : 'var(--warn, #d29922)'}`,
          background: 'transparent', color: wouldPass ? 'var(--ok, #3fb950)' : 'var(--warn, #d29922)' }}>
        {busy ? 'Submitting…' : wouldPass ? '3 · Submit to the airlock' : '3 · Submit anyway (it will be refused)'}
      </button>
    </Card>
  );
}

function SubmitResult({ result }) {
  const stage = result.stage || (result.ok ? 'submitted' : 'failed');
  const good = result.ok;
  return (
    <Card>
      <h3 style={{ marginTop: 0 }}>Submit — {stage}</h3>
      <p style={{ fontSize: 13, color: good ? 'var(--ok, #3fb950)' : 'var(--bad, #f85149)' }}>
        {result.error || result.note || (stage === 'queued' ? 'Queued for approval.' : 'Done.')}
      </p>
      {stage === 'live' && (
        <p style={{ fontSize: 12.5, color: 'var(--dim, #9aa3b2)' }}>
          Promoted and mounted, deliberately <strong>stopped</strong>. Code you have not started
          never handles a request — start it from the Queue tab when you are ready.
        </p>
      )}
      {result.lint?.errors?.length > 0 && (
        <Section title="Lint">
          {result.lint.errors.map((e, i) => <Finding key={i} sev="HIGH" why={e} />)}
        </Section>
      )}

      {/* M3 — the only gate that runs the block. Show what actually answered,
          not that a check "passed": a status code is evidence, a green tick is
          a claim. */}
      {result.boot && (
        <Section title={`Boot proof — ${result.boot.ok ? 'booted' : 'did not boot'}`}>
          {result.boot.environmentError && (
            <Finding sev="MEDIUM" why={`${result.boot.environmentError}`} />
          )}
          <p style={{ fontSize: 12.5, margin: '4px 0', color: 'var(--dim, #9aa3b2)' }}>
            {result.boot.mounted} API module{result.boot.mounted === 1 ? '' : 's'} mounted
          </p>
          {result.boot.probes?.length > 0 && (
            <ul role="list" style={{ listStyle: 'none', padding: 0, margin: '6px 0 0' }}>
              {result.boot.probes.map((p, i) => (
                <li key={i} style={{ fontSize: 12, fontFamily: 'var(--mono, monospace)',
                  color: p.skipped ? 'var(--dim, #9aa3b2)' : p.ok ? 'var(--ok, #3fb950)' : 'var(--bad, #f85149)' }}>
                  {p.method} {p.path} — {p.skipped || p.status || p.error}
                </li>
              ))}
            </ul>
          )}
          {result.boot.skipped?.map((sk, i) => <Finding key={`s${i}`} sev="HIGH" file={sk.file} why={sk.why} />)}
          {result.boot.collisions?.map((c, i) => <Finding key={`c${i}`} sev="HIGH" why={c} />)}
          {result.boot.errors?.filter((e) => e !== result.boot.environmentError)
            .map((e, i) => <Finding key={`e${i}`} sev="HIGH" why={e} />)}
        </Section>
      )}
    </Card>
  );
}

/* ── M4 — the approval queue ─────────────────────────────────────────────── */

function QueuePanel({ onDecided }) {
  const [items, setItems] = useState(null);
  const [blocks, setBlocks] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(() => {
    fetch('/api/build/queue').then((r) => r.json())
      .then((d) => setItems(d.items || []))
      .catch((e) => setError(e.message));
    fetch('/api/build/blocks').then((r) => r.json())
      .then((d) => setBlocks(d.blocks || []))
      .catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);

  const decide = async (id, verb) => {
    setBusy(id); setError('');
    const r = await jpost(`/api/build/queue/${id}/${verb}`, {});
    if (!r.data?.ok) setError(r.data?.error || `${verb} failed`);
    setBusy(''); load(); onDecided?.();
  };

  const toggle = async (id, running) => {
    setBusy(id);
    await jpost(`/api/build/blocks/${id}/${running ? 'stop' : 'start'}`, {});
    setBusy(''); load();
  };

  return (
    <>
      <Card>
        <h3 style={{ marginTop: 0 }}>Approval queue</h3>
        {error && <p style={{ color: 'var(--bad, #f85149)', fontSize: 13 }}>{error}</p>}
        {items === null && <p style={{ fontSize: 13, color: 'var(--dim, #9aa3b2)' }}>Loading…</p>}
        {items?.length === 0 && <p style={{ fontSize: 13, color: 'var(--dim, #9aa3b2)' }}>Nothing waiting.</p>}
        <ul role="list" style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 10 }}>
          {(items || []).map((it) => (
            <li key={it.id} style={{ border: '1px solid var(--line, #272d39)', borderRadius: 8, padding: '12px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 13.5 }}>{it.blockId}</strong>
                <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 10, color: SEV_COLOR[it.score], border: `1px solid ${SEV_COLOR[it.score]}` }}>{it.score}</span>
                <span style={{ fontSize: 11.5, color: 'var(--dim, #9aa3b2)' }}>{it.status} · {it.source}</span>
              </div>
              {it.reasons?.length > 0 && (
                <ul role="list" style={{ listStyle: 'none', padding: 0, margin: '8px 0 0' }}>
                  {it.reasons.map((r, i) => <li key={i} style={{ fontSize: 12, color: 'var(--dim, #9aa3b2)' }}>· {r}</li>)}
                </ul>
              )}
              {it.status === 'pending' && (
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button onClick={() => decide(it.id, 'approve')} disabled={busy === it.id}
                    style={{ padding: '6px 12px', fontSize: 12, borderRadius: 5, cursor: 'pointer', border: '1px solid var(--ok, #3fb950)', background: 'transparent', color: 'var(--ok, #3fb950)' }}>
                    Approve
                  </button>
                  <button onClick={() => decide(it.id, 'reject')} disabled={busy === it.id}
                    style={{ padding: '6px 12px', fontSize: 12, borderRadius: 5, cursor: 'pointer', border: '1px solid var(--bad, #f85149)', background: 'transparent', color: 'var(--bad, #f85149)' }}>
                    Reject
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
        <p style={{ fontSize: 11.5, color: 'var(--dim, #9aa3b2)', marginTop: 12 }}>
          Approving re-runs lint and fails closed — a human decision does not override the gate.
          A build declaring shell access additionally requires IDE mode.
        </p>
      </Card>

      <Card>
        <h3 style={{ marginTop: 0 }}>Self-built blocks</h3>
        <p style={{ fontSize: 12.5, color: 'var(--dim, #9aa3b2)' }}>
          Promoted blocks land mounted but stopped. Nothing serves a request until you start it.
        </p>
        {blocks.length === 0 && <p style={{ fontSize: 13, color: 'var(--dim, #9aa3b2)' }}>None yet.</p>}
        <ul role="list" style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
          {blocks.map((b) => {
            const id = b.id || b.blockId;
            return (
              <li key={id} style={{ display: 'flex', alignItems: 'center', gap: 10, border: '1px solid var(--line, #272d39)', borderRadius: 6, padding: '9px 12px' }}>
                <strong style={{ fontSize: 13, flex: 1 }}>{id}</strong>
                <span style={{ fontSize: 11.5, color: b.running ? 'var(--ok, #3fb950)' : 'var(--dim, #9aa3b2)' }}>
                  {b.running ? 'running' : 'stopped'}
                </span>
                <button onClick={() => toggle(id, b.running)} disabled={busy === id}
                  style={{ padding: '5px 11px', fontSize: 12, borderRadius: 5, cursor: 'pointer', border: '1px solid var(--line, #272d39)', background: 'transparent', color: 'inherit' }}>
                  {b.running ? 'Stop' : 'Start'}
                </button>
              </li>
            );
          })}
        </ul>
      </Card>
    </>
  );
}

/* ── Reference ───────────────────────────────────────────────────────────── */

function ReferencePanel({ registry, onRefresh }) {
  return (
    <>
      <Card>
        <h3 style={{ marginTop: 0 }}>Anatomy of a block</h3>
        <ul role="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {ANATOMY.map(([file, what]) => (
            <li key={file} style={{ display: 'flex', gap: 14, padding: '8px 0', borderBottom: '1px solid var(--line, #272d39)' }}>
              <code style={{ minWidth: 168, fontSize: 12.5 }}>{file}</code>
              <span style={{ fontSize: 12.5, color: 'var(--dim, #9aa3b2)' }}>{what}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <h3 style={{ marginTop: 0 }}>The four rules</h3>
        <ol style={{ paddingLeft: 20, margin: 0 }}>
          {RULES.map(([rule, why]) => (
            <li key={rule} style={{ margin: '9px 0' }}>
              <strong style={{ fontSize: 13 }}>{rule}</strong>
              <span style={{ fontSize: 12.5, color: 'var(--dim, #9aa3b2)' }}> — {why}</span>
            </li>
          ))}
        </ol>
        <p style={{ fontSize: 12, color: 'var(--dim, #9aa3b2)', marginTop: 14 }}>
          The manifest schema the kernel enforces is <code>src/kernel/schema.json</code>, applied by
          <code> validateManifest()</code> in <code>src/kernel/staging.cjs</code>. It is the only one.
        </p>
      </Card>

      <Card>
        <h3 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 9 }}>
          Installed blocks
          <button onClick={onRefresh} aria-label="Refresh block registry"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--dim, #9aa3b2)', padding: 3 }}>
            <RefreshCw size={14} aria-hidden="true" />
          </button>
        </h3>
        <ul role="list" style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(160px,1fr))', gap: 8 }}>
          {(registry || []).map((b) => (
            <li key={b.id} style={{ border: '1px solid var(--line, #272d39)', borderRadius: 6, padding: '9px 11px', fontSize: 12.5 }}>
              {b.label || b.id}
              <span style={{ display: 'block', fontSize: 11, color: 'var(--dim, #9aa3b2)' }}>{b.route}</span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
