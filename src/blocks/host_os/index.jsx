/**
 * Host OS — this machine and this AEON, on one screen.
 *
 * host_os was backend-only: the kernel's NAV map has always listed it at /host,
 * but with no index.jsx the build-time registry skipped it, so there was no
 * place to see the machine's health, and the only Restart was a header button
 * that told the operator AEON was restarting whether or not anything would
 * bring it back (measured 2026-09-23 on macOS: nothing did).
 *
 * Everything here reads routes this block owns:
 *   GET  /api/system/health   machine, disk, AEON process, restart capability
 *   POST /api/system/restart  only offered when the server says it can work
 *   GET  /api/fs/lock         the File Manager's add-only lock
 *   GET  /api/host_os/audit   what the machine was asked to do, newest first
 *
 * Plain elements and CSS variables rather than the aurora library: a block
 * importing from src/components is flagged HIGH (path-traversal) by
 * `aeon lint` today, and this screen is small enough not to need it.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Monitor, Cpu, HardDrive, RefreshCw, Power, Activity } from 'lucide-react';

const DIM = { color: 'var(--dim, #9aa3b2)', fontSize: 12.5 };
const CARD = { background: 'var(--panel, rgba(255,255,255,0.03))', border: '1px solid var(--line, #272d39)', borderRadius: 10, padding: 16 };
const H3 = { margin: '0 0 10px', fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 };
const BTN = { border: '1px solid var(--line, #272d39)', background: 'transparent', color: 'var(--text, #e6edf3)', borderRadius: 6, padding: '6px 12px', fontSize: 12, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 };

function duration(sec) {
  if (sec == null) return '—';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${Math.floor(sec % 60)}s`;
}

function Row({ label, value, note }) {
  return (
    <li style={{ display: 'grid', gridTemplateColumns: 'minmax(110px, 150px) 1fr', gap: 12, padding: '6px 0', borderBottom: '1px solid var(--line, #272d39)' }}>
      <span style={DIM}>{label}</span>
      <span style={{ fontSize: 13, wordBreak: 'break-word' }}>{value}{note && <span style={{ display: 'block', ...DIM, fontSize: 11.5, marginTop: 2 }}>{note}</span>}</span>
    </li>
  );
}

async function readJson(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

export default function HostOS() {
  const [health, setHealth] = useState(null);
  const [error, setError] = useState('');
  const [lock, setLock] = useState(null);
  const [audit, setAudit] = useState([]);
  const [restart, setRestart] = useState({ phase: 'idle', message: '' });
  const pidBefore = useRef(null);

  const load = useCallback(async () => {
    try {
      const h = await readJson(await fetch('/api/system/health'));
      setHealth(h); setError('');
      return h;
    } catch (e) { setError(e.message); return null; }
    finally {
      fetch('/api/fs/lock').then(readJson).then((d) => setLock(d.locked !== false)).catch(() => setLock(null));
      fetch('/api/host_os/audit').then(readJson).then((d) => setAudit((d.entries || []).slice(0, 8))).catch(() => setAudit([]));
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => { if (restart.phase === 'idle') load(); }, 15000);
    return () => clearInterval(t);
  }, [load, restart.phase]);

  const doRestart = async () => {
    if (!window.confirm('Restart AEON now?\n\nOpen screens reconnect when it is back.')) return;
    pidBefore.current = health?.aeon?.pid ?? null;
    setRestart({ phase: 'asking', message: 'Asking AEON to restart…' });
    try {
      const res = await fetch('/api/system/restart', { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.restarting) {
        setRestart({ phase: 'idle', message: `${body.error || `Restart refused (HTTP ${res.status})`}${body.remedy ? ` ${body.remedy}` : ''}` });
        return;
      }
      setRestart({ phase: 'waiting', message: `Restarting (relaunched by ${body.via})… waiting for AEON to come back.` });
    } catch (e) {
      setRestart({ phase: 'idle', message: `Restart failed: ${e.message}` });
      return;
    }
    // Back means a NEW process answering — the old one can still answer for
    // the half second before it exits, which is not a restart.
    const started = Date.now();
    const poll = async () => {
      if (Date.now() - started > 90000) {
        setRestart({ phase: 'idle', message: 'AEON has not come back after 90 seconds. Start it with your launcher.' });
        return;
      }
      try {
        const h = await readJson(await fetch('/api/system/health'));
        if (h.aeon && h.aeon.pid !== pidBefore.current) {
          setHealth(h);
          setRestart({ phase: 'idle', message: `AEON is back (new process ${h.aeon.pid}).` });
          return;
        }
      } catch { /* down, or asking for a new sign-in — keep waiting */ }
      setTimeout(poll, 2000);
    };
    setTimeout(poll, 2000);
  };

  const m = health?.machine, a = health?.aeon, d = health?.disk, r = health?.restart;

  return (
    <div className="block-root" style={{ padding: 'clamp(14px, 4vw, 28px)', color: 'var(--text, #e6edf3)' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}><Monitor size={22} aria-hidden="true" /> Host OS</h2>
          <p style={{ ...DIM, fontSize: 13, margin: '6px 0 0' }}>This computer and the AEON running on it. Refreshes every 15 seconds.</p>
        </div>
        <button onClick={load} style={BTN} aria-label="Refresh host health"><RefreshCw size={13} aria-hidden="true" /> Refresh</button>
      </header>

      {error && <p role="alert" style={{ color: 'var(--danger, #ff4455)', fontSize: 13 }}>Could not read host health: {error}</p>}

      <div aria-live="polite" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }}>
        <section style={CARD} aria-labelledby="host-machine">
          <h3 id="host-machine" style={H3}><Cpu size={15} aria-hidden="true" /> This computer</h3>
          <ul role="list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            <Row label="Name" value={m?.hostname || '—'} />
            <Row label="System" value={m ? `${m.platform} ${m.osRelease} (${m.arch})` : '—'} />
            <Row label="Processor" value={m ? `${m.cpuModel || 'unknown'} · ${m.cpuThreads} threads` : '—'} />
            <Row label="Load (1/5/15 min)" value={m ? (m.loadAvg ? m.loadAvg.join(' / ') : 'not reported on Windows') : '—'} />
            <Row label="Memory" value={m ? `${m.freeMemGb} GB free of ${m.totalMemGb} GB` : '—'} note={m?.freeMemNote} />
            <Row label="Disk" value={d ? (d.error ? `unreadable: ${d.error}` : `${d.freeGb} GB free of ${d.totalGb} GB`) : '—'} note={d?.path ? `the drive holding ${d.path}` : undefined} />
            <Row label="Up for" value={m ? duration(m.uptimeSec) : '—'} />
          </ul>
        </section>

        <section style={CARD} aria-labelledby="host-aeon">
          <h3 id="host-aeon" style={H3}><Activity size={15} aria-hidden="true" /> AEON</h3>
          <ul role="list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            <Row label="Process" value={a ? `pid ${a.pid} · Node ${a.node}` : '—'} />
            <Row label="Running for" value={a ? duration(a.uptimeSec) : '—'} />
            <Row label="Memory" value={a ? `${a.rssMb} MB (heap ${a.heapUsedMb} MB)` : '—'} />
            <Row label="File Manager" value={lock == null ? '—' : lock ? 'Add-only (locked)' : 'Full edit (unlocked)'} note="Change it from Files (🔒/🔓)." />
          </ul>
          <div style={{ marginTop: 14 }}>
            <button onClick={doRestart} disabled={!r?.canRestart || restart.phase !== 'idle'}
              style={{ ...BTN, opacity: r?.canRestart ? 1 : 0.5, cursor: r?.canRestart && restart.phase === 'idle' ? 'pointer' : 'not-allowed', borderColor: r?.canRestart ? 'var(--amber, #f59e0b)' : undefined, color: r?.canRestart ? 'var(--amber, #f59e0b)' : undefined }}
              aria-describedby="host-restart-why">
              <Power size={13} aria-hidden="true" /> Restart AEON
            </button>
            <p id="host-restart-why" style={{ ...DIM, margin: '8px 0 0' }}>
              {!r ? 'Checking whether AEON can restart itself here…'
                : r.canRestart ? `Available — ${r.via === 'supervisor' ? 'a supervisor relaunches AEON when it exits' : 'restart.bat relaunches AEON'}.`
                : `${r.reason} ${r.remedy || ''}`}
            </p>
            {restart.message && <p role="status" style={{ fontSize: 13, margin: '8px 0 0' }}>{restart.message}</p>}
          </div>
        </section>
      </div>

      <section style={{ ...CARD, marginTop: 14 }} aria-labelledby="host-audit">
        <h3 id="host-audit" style={H3}><HardDrive size={15} aria-hidden="true" /> What this machine was asked to do</h3>
        {audit.length === 0
          ? <p style={{ ...DIM, margin: 0 }}>Nothing recorded yet. File deletes and renames, lock changes, OS actions and refused uploads are recorded here.</p>
          : (
            <ul role="list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {audit.map((e, i) => (
                <Row key={i} label={e.timestamp ? new Date(e.timestamp).toLocaleString() : '—'}
                  value={`${e.action || '?'} · ${String(e.details || '').slice(0, 140)}`} />
              ))}
            </ul>
          )}
      </section>
    </div>
  );
}
