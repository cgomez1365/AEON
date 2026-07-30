import React, { useState, useEffect, useRef, useCallback } from "react";
import { useAuth } from '../kernel/hooks/useAuth';
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";

// ─── API HELPER ────────────────────────────────────────────────────────────
const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...opts.headers },
    ...opts,
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
};

// ─── SUPABASE RELAY CONFIG ─────────────────────────────────────────────────
const _isVercel = typeof window !== 'undefined' && window.location.hostname.includes('vercel.app');
const SB_URL = import.meta.env.VITE_SUPABASE_URL;
const SB_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const sbHeaders = () => ({
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
});

// ─── QUICK ACTION BUTTON ───────────────────────────────────────────────────
function QuickBtn({ icon, label, color, onClick, badge }) {
  return (
    <motion.button
      whileTap={{ scale: 0.93 }}
      onClick={onClick}
      style={{
        display: "flex", flexDirection: "column", alignItems: "center",
        gap: 6, padding: "14px 8px", borderRadius: 14, position: "relative",
        background: `rgba(${color},0.06)`,
        border: `1px solid rgba(${color},0.25)`,
        color: `rgb(${color})`, fontWeight: 700, fontSize: 11,
        letterSpacing: "0.04em", cursor: "pointer", minWidth: 0, flex: 1,
        transition: "background 0.18s",
      }}
    >
      <span style={{ fontSize: 22 }}>{icon}</span>
      {label}
      {badge != null && (
        <span style={{
          position: "absolute", top: 6, right: 6, minWidth: 16, height: 16,
          background: `rgb(${color})`, color: "#000", borderRadius: 99,
          fontSize: 9, fontWeight: 900, display: "flex", alignItems: "center",
          justifyContent: "center", padding: "0 4px",
        }}>{badge}</span>
      )}
    </motion.button>
  );
}

// ─── STATUS PILL ───────────────────────────────────────────────────────────
function StatusPill({ label, ok }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      padding: "3px 10px", borderRadius: 99, fontSize: 9, fontWeight: 700,
      letterSpacing: "0.1em", textTransform: "uppercase",
      background: ok ? "rgba(0,255,64,0.1)" : "rgba(255,68,102,0.1)",
      color: ok ? "#00ff40" : "#ff4466",
      border: `1px solid ${ok ? "rgba(0,255,64,0.3)" : "rgba(255,68,102,0.3)"}`,
    }}>
      <span style={{ width: 5, height: 5, borderRadius: "50%", background: "currentColor", display: "inline-block" }} />
      {label}
    </span>
  );
}

// ─── NOTES PANEL ──────────────────────────────────────────────────────────
function NotesPanel({ onClose }) {
  const [notes, setNotes] = useState([]);
  const [newNote, setNewNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api("/api/notes")
      .then(d => setNotes(d.notes || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    if (!newNote.trim()) return;
    setSaving(true);
    try {
      const d = await api("/api/notes", {
        method: "POST",
        body: JSON.stringify({ body: newNote.trim() }),
      });
      setNotes(n => [d.note, ...n]);
      setNewNote("");
    } catch (e) {
      console.error("Note save failed:", e.message);
    } finally { setSaving(false); }
  };

  const del = async (id) => {
    try {
      await api("/api/notes", { method: "DELETE", body: JSON.stringify({ id }) });
      setNotes(n => n.filter(x => x.id !== id));
    } catch {}
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", flex: 1, overflow: "hidden" }}>
      <div style={{ padding: "12px 16px", borderBottom: "1px solid rgba(255,255,255,0.07)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontWeight: 800, color: "#00f2ff", fontSize: 13, letterSpacing: "1px" }}>📝 NOTES</span>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: 18 }}>✕</button>
      </div>
      <div style={{ padding: 12, display: "flex", gap: 8 }}>
        <textarea
          value={newNote}
          onChange={e => setNewNote(e.target.value)}
          placeholder="Capture a thought, task, or intel..."
          rows={2}
          style={{
            flex: 1, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 10, color: "#e5e2e1", padding: "8px 12px", fontSize: 13, resize: "none", outline: "none",
          }}
        />
        <button
          onClick={save}
          disabled={saving || !newNote.trim()}
          style={{
            padding: "8px 14px", background: saving ? "rgba(0,242,255,0.1)" : "rgba(0,242,255,0.2)",
            border: "1px solid rgba(0,242,255,0.4)", borderRadius: 10, color: "#00f2ff",
            fontWeight: 800, cursor: saving ? "not-allowed" : "pointer", fontSize: 13,
          }}
        >{saving ? "…" : "↑"}</button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "0 12px 12px" }}>
        {loading && <div style={{ textAlign: "center", color: "rgba(255,255,255,0.3)", padding: 20 }}>Loading...</div>}
        {!loading && notes.length === 0 && <div style={{ textAlign: "center", color: "rgba(255,255,255,0.2)", padding: 20, fontSize: 12 }}>No notes yet.</div>}
        {notes.map(n => (
          <div key={n.id} style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 10, padding: "10px 12px", marginBottom: 8 }}>
            <div style={{ fontSize: 13, color: "#e5e2e1", lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 200, overflowY: "auto" }}>{n.body}</div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
              <span style={{ fontSize: 10, color: "rgba(255,255,255,0.25)" }}>{new Date(n.created_at).toLocaleDateString()}</span>
              <button onClick={() => del(n.id)} style={{ background: "none", border: "none", color: "#ff4466", cursor: "pointer", fontSize: 10 }}>Delete</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── EMAIL DRAFT PANEL ─────────────────────────────────────────────────────
function EmailPanel({ onClose }) {
  const [to, setTo] = useState("");
  const [context, setContext] = useState("");
  const [type, setType] = useState("outreach");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  const draft = async () => {
    if (!to && !context) return;
    setLoading(true);
    setResult(null);
    try {
      const d = await api("/api/email-draft", {
        method: "POST",
        body: JSON.stringify({ to, context, type }),
      });
      setResult(d);
    } catch (e) {
      setResult({ error: e.message });
    } finally { setLoading(false); }
  };

  const copy = () => {
    if (!result) return;
    navigator.clipboard.writeText(`Subject: ${result.subject}\n\n${result.body}`);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: "12px 16px", borderBottom: "1px solid rgba(255,255,255,0.07)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontWeight: 800, color: "#f59e0b", fontSize: 13, letterSpacing: "1px" }}>✉️ EMAIL DRAFT</span>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: 18 }}>✕</button>
      </div>
      <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8, overflowY: "auto", flex: 1 }}>
        <input
          value={to}
          onChange={e => setTo(e.target.value)}
          placeholder="To: (name or company)"
          style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10, color: "#e5e2e1", padding: "10px 12px", fontSize: 13, outline: "none" }}
        />
        <select
          value={type}
          onChange={e => setType(e.target.value)}
          style={{ background: "rgba(0,0,0,0.5)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10, color: "#e5e2e1", padding: "10px 12px", fontSize: 13, outline: "none" }}
        >
          <option value="outreach">Cold Outreach</option>
          <option value="followup">Follow-Up</option>
          <option value="proposal">Proposal</option>
          <option value="checkin">Check-In</option>
          <option value="invoice">Invoice Reminder</option>
        </select>
        <textarea
          value={context}
          onChange={e => setContext(e.target.value)}
          placeholder="Context: what do you want to say? (e.g. met at the hardware store, need HR help)"
          rows={3}
          style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10, color: "#e5e2e1", padding: "10px 12px", fontSize: 13, resize: "none", outline: "none" }}
        />
        <motion.button
          whileTap={{ scale: 0.97 }}
          onClick={draft}
          disabled={loading}
          style={{ padding: "12px", background: loading ? "rgba(245,158,11,0.1)" : "rgba(245,158,11,0.2)", border: "1px solid rgba(245,158,11,0.4)", borderRadius: 10, color: "#f59e0b", fontWeight: 800, cursor: loading ? "not-allowed" : "pointer", fontSize: 13 }}
        >{loading ? "Drafting with AI…" : "⚡ Generate Draft"}</motion.button>

        {result && !result.error && (
          <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, padding: 14 }}>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", marginBottom: 4 }}>SUBJECT</div>
            <div style={{ fontWeight: 700, color: "#f59e0b", fontSize: 13, marginBottom: 12 }}>{result.subject}</div>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", marginBottom: 4 }}>BODY</div>
            <div style={{ fontSize: 13, color: "#e5e2e1", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{result.body}</div>
            <button onClick={copy} style={{ marginTop: 12, padding: "8px 16px", background: "rgba(0,242,255,0.1)", border: "1px solid rgba(0,242,255,0.3)", borderRadius: 8, color: "#00f2ff", fontWeight: 700, fontSize: 11, cursor: "pointer" }}>
              📋 Copy to Clipboard
            </button>
          </div>
        )}
        {result?.error && (
          <div style={{ background: "rgba(255,68,102,0.1)", border: "1px solid rgba(255,68,102,0.3)", borderRadius: 10, padding: 12, color: "#ff4466", fontSize: 12 }}>
            ❌ {result.error}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── GAS SYNC PANEL ────────────────────────────────────────────────────────
function GasSyncPanel({ onClose }) {
  const [gasStatus, setGasStatus] = useState(null);
  const [syncing, setSyncing]     = useState(null);
  const [results, setResults]     = useState([]);
  const [sheetUrl, setSheetUrl]   = useState(null); // populated after bootstrap or ping

  useEffect(() => {
    api("/api/gas/status")
      .then(d => setGasStatus(d))
      .catch(() => setGasStatus({ configured: false }));
  }, []);

  const addResult = (msg, ok = true) =>
    setResults(r => [{ msg, ok, ts: new Date().toLocaleTimeString() }, ...r].slice(0, 8));

  // ── Bootstrap: tells GAS to create the spreadsheet right now ──
  const bootstrapSheet = async () => {
    setSyncing('bootstrap');
    try {
      const d = await api("/api/gas/sync", {
        method: "POST",
        body: JSON.stringify({ action: 'bootstrap' }),
      });
      const res = d.result || {};
      if (res.spreadsheetUrl) setSheetUrl(res.spreadsheetUrl);
      addResult(`✅ Spreadsheet built! ${(res.sheetsBuilt || []).length} tabs created.`);
    } catch (e) { addResult(`❌ Bootstrap failed: ${e.message}`, false); }
    finally { setSyncing(null); }
  };

  // ── Push Notes → Google Sheets ──
  const syncNotes = async () => {
    setSyncing('notes');
    try {
      const d = await api("/api/gas/notes-push", { method: "POST", body: "{}" });
      addResult(`✅ Synced ${d.count} notes to Google Sheets`);
    } catch (e) { addResult(`❌ Notes sync failed: ${e.message}`, false); }
    finally { setSyncing(null); }
  };

  // ── Push Clients → CRM Sheet ──
  const syncClients = async () => {
    setSyncing('clients');
    try {
      const raw     = localStorage.getItem("aeon_clients");
      const clients = raw ? JSON.parse(raw) : [];
      let pushed    = 0;
      for (const c of clients.slice(0, 20)) {
        await api("/api/gas/crm", {
          method: "POST",
          body: JSON.stringify({
            name: c.name, company: c.company || '',
            email: c.email || '', status: c.status || 'Active', industry: c.industry || ''
          }),
        });
        pushed++;
      }
      addResult(`✅ Pushed ${pushed} clients to GAS CRM`);
    } catch (e) { addResult(`❌ CRM sync failed: ${e.message}`, false); }
    finally { setSyncing(null); }
  };

  // ── Ping Hub (getStatus) ──
  const testPing = async () => {
    setSyncing('ping');
    try {
      const d   = await api("/api/gas/sync", {
        method: "POST",
        body: JSON.stringify({ action: 'getStatus' }),
      });
      const res = d.result || {};
      if (res.spreadsheetUrl) setSheetUrl(res.spreadsheetUrl);
      const counts = res.sheetRowCounts || {};
      const summary = Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' | ');
      addResult(`✅ Hub online — ${summary || 'OK'}`);
    } catch (e) { addResult(`❌ Ping failed: ${e.message}`, false); }
    finally { setSyncing(null); }
  };

  const isBusy = !!syncing;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header */}
      <div style={{ padding: "12px 16px", borderBottom: "1px solid rgba(255,255,255,0.07)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontWeight: 800, color: "#10b981", fontSize: 13, letterSpacing: "1px" }}>🔗 GAS HUB SYNC</span>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: 18 }}>✕</button>
      </div>

      <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12, overflowY: "auto", flex: 1 }}>

        {/* GAS config status */}
        <div style={{
          background: gasStatus?.configured ? "rgba(16,185,129,0.06)" : "rgba(255,68,102,0.06)",
          border: `1px solid ${gasStatus?.configured ? "rgba(16,185,129,0.25)" : "rgba(255,68,102,0.25)"}`,
          borderRadius: 10, padding: "10px 12px", fontSize: 11,
        }}>
          <div style={{ fontWeight: 700, color: gasStatus?.configured ? "#10b981" : "#ff4466", marginBottom: 4 }}>
            {gasStatus === null ? "⏳ Checking GAS Hub…"
              : gasStatus.configured ? "✅ GAS Hub Configured"
              : "⚠️ GAS Hub Not Configured"}
          </div>
          {gasStatus?.url && (
            <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 10, wordBreak: "break-all" }}>{gasStatus.url}</div>
          )}
          {!gasStatus?.configured && (
            <div style={{ color: "rgba(255,255,255,0.3)", fontSize: 10, marginTop: 4 }}>Set VITE_GAS_URL in .env and restart server</div>
          )}
        </div>

        {/* Spreadsheet link (populated after bootstrap or ping) */}
        {sheetUrl && (
          <div style={{ background: "rgba(0,242,255,0.06)", border: "1px solid rgba(0,242,255,0.2)", borderRadius: 10, padding: "10px 12px" }}>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", marginBottom: 4 }}>GOOGLE SPREADSHEET</div>
            <a href={sheetUrl} target="_blank" rel="noreferrer"
              style={{ color: "#00f2ff", fontSize: 11, wordBreak: "break-all", textDecoration: "underline" }}>
              Open AEON Command Center →
            </a>
          </div>
        )}

        {/* Action buttons */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>

          {/* BOOTSTRAP — primary CTA */}
          <motion.button whileTap={{ scale: 0.97 }} onClick={bootstrapSheet} disabled={isBusy}
            style={{
              padding: "14px", borderRadius: 12, fontWeight: 800, fontSize: 13, cursor: isBusy ? "not-allowed" : "pointer",
              background: syncing === 'bootstrap' ? "rgba(16,185,129,0.05)" : "linear-gradient(135deg, rgba(16,185,129,0.2), rgba(0,242,255,0.1))",
              border: "1px solid rgba(16,185,129,0.4)", color: "#10b981",
              letterSpacing: "0.05em",
            }}>
            {syncing === 'bootstrap' ? "⏳ Building Spreadsheet…" : "📄 Bootstrap GAS Spreadsheet"}
          </motion.button>

          {/* Divider */}
          <div style={{ fontSize: 9, color: "rgba(255,255,255,0.2)", textAlign: "center", letterSpacing: "1px", padding: "2px 0" }}>SYNC DATA</div>

          <motion.button whileTap={{ scale: 0.97 }} onClick={syncNotes} disabled={isBusy}
            style={{ padding: "12px", background: syncing === 'notes' ? "rgba(0,242,255,0.04)" : "rgba(0,242,255,0.08)", border: "1px solid rgba(0,242,255,0.25)", borderRadius: 10, color: "#00f2ff", fontWeight: 700, fontSize: 13, cursor: isBusy ? "not-allowed" : "pointer" }}>
            {syncing === 'notes' ? "Syncing Notes…" : "📝 Push Notes → Sheets"}
          </motion.button>

          <motion.button whileTap={{ scale: 0.97 }} onClick={syncClients} disabled={isBusy}
            style={{ padding: "12px", background: syncing === 'clients' ? "rgba(255,94,0,0.04)" : "rgba(255,94,0,0.08)", border: "1px solid rgba(255,94,0,0.25)", borderRadius: 10, color: "#ff5e00", fontWeight: 700, fontSize: 13, cursor: isBusy ? "not-allowed" : "pointer" }}>
            {syncing === 'clients' ? "Pushing CRM…" : "👤 Push Clients → CRM Sheet"}
          </motion.button>

          <motion.button whileTap={{ scale: 0.97 }} onClick={testPing} disabled={isBusy}
            style={{ padding: "12px", background: syncing === 'ping' ? "rgba(129,140,248,0.04)" : "rgba(129,140,248,0.08)", border: "1px solid rgba(129,140,248,0.25)", borderRadius: 10, color: "#818cf8", fontWeight: 700, fontSize: 13, cursor: isBusy ? "not-allowed" : "pointer" }}>
            {syncing === 'ping' ? "Pinging Hub…" : "⚡ Ping GAS Hub"}
          </motion.button>
        </div>

        {/* Sync results log */}
        {results.length > 0 && (
          <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 10, padding: "10px 12px" }}>
            <div style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", letterSpacing: "1px", marginBottom: 8 }}>SYNC LOG</div>
            {results.map((r, i) => (
              <div key={i} style={{ fontSize: 11, color: r.ok ? "#10b981" : "#ff4466", padding: "3px 0", borderBottom: i < results.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none" }}>
                <span style={{ color: "rgba(255,255,255,0.25)", marginRight: 6 }}>{r.ts}</span>{r.msg}
              </div>
            ))}
          </div>
        )}

        {/* Available actions reference */}
        <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 10, padding: "10px 12px" }}>
          <div style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", letterSpacing: "1px", marginBottom: 6 }}>GAS ACTIONS AVAILABLE</div>
          {['bootstrap', 'upsertCRMRecord', 'addCalendarEvent', 'syncNotes', 'logOutreach', 'sendEmailAlert', 'getSheetData', 'addHRRecord', 'getStatus'].map(a => (
            <div key={a} style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", padding: "1px 0", fontFamily: "monospace" }}>• {a}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── CALENDAR MINI ─────────────────────────────────────────────────────────
function CalendarPanel({ onClose, onNavigate }) {
  const today = new Date();
  const [events, setEvents] = useState([]);
  const [aiSummary, setAiSummary] = useState("");
  const [loading, setLoading] = useState(false);

  // Load events from Scheduler (localStorage bridge)
  useEffect(() => {
    try {
      const raw = localStorage.getItem("aeon_events") || localStorage.getItem("aeon_scheduler_events");
      if (raw) setEvents(JSON.parse(raw).slice(0, 6));
    } catch {}
  }, []);

  const askAI = async () => {
    setLoading(true);
    try {
      const d = await api("/api/chat", {
        method: "POST",
        body: JSON.stringify({
          prompt: `I'm the CEO. Today is ${today.toDateString()}. My upcoming events: ${JSON.stringify(events.slice(0,5))}. Give me a 3-sentence day brief: priorities, any conflicts, and one recommendation. Be direct.`,
          model: "gemini-2.5-flash",
        }),
      });
      setAiSummary(d.response);
    } catch (e) { setAiSummary("Could not reach AI: " + e.message); }
    finally { setLoading(false); }
  };

  const days = ["S","M","T","W","T","F","S"];
  const firstDay = new Date(today.getFullYear(), today.getMonth(), 1).getDay();
  const daysInMonth = new Date(today.getFullYear(), today.getMonth()+1, 0).getDate();

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: "12px 16px", borderBottom: "1px solid rgba(255,255,255,0.07)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontWeight: 800, color: "#818cf8", fontSize: 13, letterSpacing: "1px" }}>📅 CALENDAR</span>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: 18 }}>✕</button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
        {/* Month Grid */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: "#818cf8", fontWeight: 700, marginBottom: 10, textTransform: "uppercase", letterSpacing: "1px" }}>
            {today.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2, textAlign: "center" }}>
            {days.map(d => <div key={d} style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", padding: "2px 0", fontWeight: 700 }}>{d}</div>)}
            {Array.from({ length: firstDay }).map((_, i) => <div key={`e${i}`} />)}
            {Array.from({ length: daysInMonth }).map((_, i) => {
              const d = i + 1;
              const isToday = d === today.getDate();
              return (
                <div key={d} style={{
                  padding: "5px 0", borderRadius: 6, fontSize: 11, fontWeight: isToday ? 900 : 400,
                  background: isToday ? "rgba(129,140,248,0.3)" : "transparent",
                  color: isToday ? "#818cf8" : "rgba(255,255,255,0.5)",
                  border: isToday ? "1px solid rgba(129,140,248,0.5)" : "1px solid transparent",
                }}>{d}</div>
              );
            })}
          </div>
        </div>

        {/* Upcoming Events */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "1px", marginBottom: 8 }}>Upcoming</div>
          {events.length === 0 && (
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.2)", textAlign: "center", padding: "12px 0" }}>
              No events loaded.{" "}
              <button onClick={() => onNavigate("/scheduler")} style={{ background: "none", border: "none", color: "#818cf8", cursor: "pointer", fontSize: 12, textDecoration: "underline" }}>
                Open Scheduler →
              </button>
            </div>
          )}
          {events.map((ev, i) => (
            <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
              <div style={{ width: 3, height: "100%", minHeight: 32, background: "#818cf8", borderRadius: 2, flexShrink: 0, marginTop: 2 }} />
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#e5e2e1" }}>{ev.title || ev.name || "Event"}</div>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)" }}>{ev.date || ev.start || ""}</div>
              </div>
            </div>
          ))}
        </div>

        {/* AI Day Brief */}
        <motion.button
          whileTap={{ scale: 0.97 }}
          onClick={askAI}
          disabled={loading}
          style={{ width: "100%", padding: "10px", background: "rgba(129,140,248,0.1)", border: "1px solid rgba(129,140,248,0.3)", borderRadius: 10, color: "#818cf8", fontWeight: 700, fontSize: 12, cursor: "pointer" }}
        >{loading ? "Asking AI…" : "⚡ AI Day Brief"}</motion.button>

        {aiSummary && (
          <div style={{ marginTop: 10, background: "rgba(129,140,248,0.05)", border: "1px solid rgba(129,140,248,0.2)", borderRadius: 10, padding: 12, fontSize: 12, color: "#e5e2e1", lineHeight: 1.6 }}>
            {aiSummary}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── MODAL SHELL ───────────────────────────────────────────────────────────
function Modal({ open, onClose, children }) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          onClick={onClose}
          style={{ position: "fixed", inset: 0, zIndex: 1100, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(8px)", display: "flex", alignItems: "flex-end" }}
        >
          <motion.div
            initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 28, stiffness: 300 }}
            onClick={e => e.stopPropagation()}
            style={{
              width: "100%", maxHeight: "88vh", minHeight: "60vh",
              background: "rgba(12,12,18,0.98)",
              borderTop: "1px solid rgba(255,255,255,0.1)",
              borderRadius: "20px 20px 0 0",
              overflow: "hidden", display: "flex", flexDirection: "column",
              paddingBottom: "env(safe-area-inset-bottom)",
            }}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ─── MAIN DASHBOARD ────────────────────────────────────────────────────────
export default function MobileCommandDashboard({ chatHistory = [], auditLogs = [], activeAgent, setActiveAgent }) {
  const { user } = useAuth();
  const nav = useNavigate();
  const [panel, setPanel] = useState(null); // "notes" | "email" | "calendar" | "gas" | null
  const [localOnline, setLocalOnline] = useState(false);
  const [geminiOnline, setGeminiOnline] = useState(true);
  const [gasOnline, setGasOnline] = useState(null); // null=unknown, true, false
  const [clientCount, setClientCount] = useState(null);
  const [botStatus, setBotStatus] = useState(null);
  const [toggling, setToggling] = useState(false);

  const agentActivity = auditLogs.filter(l => l.agent && l.agent !== "SYSTEM").length;
  const isNominal = agentActivity > 0;

  // Check local runtime status on load
  useEffect(() => {
    fetch("/api/local-status").then(r => r.json()).then(d => setLocalOnline(d.online)).catch(() => {});
    fetch("/api/gas/status").then(r => r.json()).then(d => setGasOnline(d.configured)).catch(() => setGasOnline(false));
  }, []);

  // Get client count from localStorage
  useEffect(() => {
    try {
      const raw = localStorage.getItem("aeon_clients");
      if (raw) setClientCount(JSON.parse(raw).length);
    } catch {}
  }, []);

  // Poll trading bot status (Vercel reads from Supabase bot_status, local reads localhost)
  useEffect(() => {
    const poll = () => {
      if (_isVercel) {
        fetch(`${SB_URL}/rest/v1/bot_status?id=eq.1&select=*`, {
          headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
        })
          .then(r => r.json())
          .then(rows => { if (rows[0]) setBotStatus(rows[0]); })
          .catch(() => setBotStatus(null));
      } else {
        // Trading engine block was removed — no local /api/trading/* routes.
        setBotStatus(null);
      }
    };
    poll();
    const iv = setInterval(poll, _isVercel ? 6000 : 4000);
    return () => clearInterval(iv);
  }, []);

  const toggleBot = async () => {
    setToggling(true);
    try {
      const isRunning = botStatus?.is_running;
      if (_isVercel) {
        const cmd = isRunning ? "/stop" : "/start aggressive";
        const ins = await fetch(`${SB_URL}/rest/v1/desktop_commands`, {
          method: "POST", headers: sbHeaders(),
          body: JSON.stringify({ command: cmd }),
        });
        const rows = await ins.json();
        const cmdId = Array.isArray(rows) ? rows[0].id : rows.id;
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 1000));
          const poll = await fetch(
            `${SB_URL}/rest/v1/desktop_commands?id=eq.${cmdId}&select=status`,
            { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
          );
          const [r] = await poll.json();
          if (r && (r.status === 'completed' || r.status === 'failed')) break;
        }
        await new Promise(r => setTimeout(r, 2000));
        const statusRows = await fetch(
          `${SB_URL}/rest/v1/bot_status?id=eq.1&select=*`,
          { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
        ).then(r => r.json());
        if (statusRows[0]) setBotStatus(statusRows[0]);
      } else {
        // Trading engine block was removed — no local /api/trading/* routes.
        console.warn("Trading engine not installed; toggle is a no-op locally.");
      }
    } catch (e) {
      console.error("Bot toggle failed:", e.message);
    } finally { setToggling(false); }
  };

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
      style={{ display: "flex", flexDirection: "column", gap: 14, paddingBottom: 16 }}
    >
      {/* ── HERO HEADER ── */}
      <div style={{
        background: "linear-gradient(145deg, rgba(14,14,14,0.9), rgba(2,5,8,0.95))",
        borderRadius: 18, padding: "18px 16px",
        border: "1px solid rgba(0,242,255,0.12)",
        boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontSize: 10, color: "rgba(0,242,255,0.6)", fontFamily: "monospace", letterSpacing: "2px" }}>{greeting.toUpperCase()}</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: "#fff", marginTop: 2 }}>
              {user?.displayName?.split(" ")[0] || "CEO"} <span style={{ color: "#00f2ff" }}>↗</span>
            </div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)", marginTop: 4 }}>
              {new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 5, alignItems: "flex-end" }}>
            <StatusPill label={isNominal ? "Nominal" : "Standby"} ok={isNominal} />
            <StatusPill label={geminiOnline ? "Gemini ✓" : "Gemini ✗"} ok={geminiOnline} />
            <StatusPill label={localOnline ? "Local ✓" : "Local ✗"} ok={localOnline} />
            {gasOnline !== null && <StatusPill label={gasOnline ? "GAS ✓" : "GAS ✗"} ok={gasOnline} />}
          </div>
        </div>

        {/* Agent selector */}
        <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", textTransform: "uppercase", letterSpacing: "1px", flexShrink: 0 }}>Active Agent</span>
          <select
            value={activeAgent}
            onChange={e => setActiveAgent(e.target.value)}
            style={{
              flex: 1, background: "rgba(0,0,0,0.5)", color: "#00f2ff",
              border: "1px solid rgba(0,242,255,0.3)", borderRadius: 8,
              padding: "6px 10px", fontSize: 12, fontWeight: 700, outline: "none", fontFamily: "monospace",
            }}
          >
            <option value="gemini-2.5-flash">⚡ Leo — Gemini Flash</option>
            <option value="gemini-2.5-pro">🔥 Gemini Pro</option>
            <option value="llama-3.3-70b-versatile">🦙 Groq Llama 70B</option>
            <option value="mixtral-8x7b-32768">🌀 Atlas — Mixtral</option>
            <option value="local">🖥️ Local Runtime</option>
          </select>
        </div>
      </div>

      {/* ── QUICK ACTIONS ROW 1 ── */}
      <div>
        <div style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", letterSpacing: "1.5px", textTransform: "uppercase", marginBottom: 8, paddingLeft: 2 }}>Quick Actions</div>
        <div style={{ display: "flex", gap: 8 }}>
          <QuickBtn icon="📝" label="Notes" color="0,242,255" onClick={() => setPanel("notes")} />
          <QuickBtn icon="✉️" label="Draft Email" color="245,158,11" onClick={() => setPanel("email")} />
          <QuickBtn icon="📅" label="Calendar" color="129,140,248" onClick={() => setPanel("calendar")} />
          <QuickBtn icon="🔗" label="GAS Sync" color="16,185,129" onClick={() => setPanel("gas")} />
          <QuickBtn icon="📁" label="Files" color="100,116,139" onClick={() => nav("/memory")} />
        </div>
      </div>

      {/* ── QUICK ACTIONS ROW 2 ── */}
      <div style={{ display: "flex", gap: 8 }}>
        <QuickBtn icon="👤" label="Clients" color="255,94,0" onClick={() => nav("/clients")} badge={clientCount} />
        <QuickBtn icon="🔍" label="Find Leads" color="255,94,0" onClick={() => nav("/clients")} />
        <QuickBtn icon="📤" label="Outreach" color="239,68,68" onClick={() => nav("/outreach")} />
      </div>

      {/* ── TRADING BOT ── */}
      <div style={{
        background: "rgba(255,255,255,0.02)",
        border: `1px solid ${botStatus?.is_running ? "rgba(0,255,64,0.18)" : "rgba(255,255,255,0.06)"}`,
        borderRadius: 14, padding: "14px 14px 12px",
        transition: "border-color 0.3s",
      }}>
        {/* Header row */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16 }}>⚡</span>
            <span style={{ fontSize: 11, fontWeight: 800, color: "#e5e2e1", letterSpacing: "1.5px", textTransform: "uppercase" }}>Trading Bot</span>
          </div>
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 5,
            padding: "3px 10px", borderRadius: 99, fontSize: 9, fontWeight: 700,
            letterSpacing: "0.1em", textTransform: "uppercase",
            background: botStatus?.is_running ? "rgba(0,255,64,0.1)" : "rgba(255,68,102,0.1)",
            color: botStatus?.is_running ? "#00ff40" : "#ff4466",
            border: `1px solid ${botStatus?.is_running ? "rgba(0,255,64,0.3)" : "rgba(255,68,102,0.3)"}`,
          }}>
            <span style={{ width: 5, height: 5, borderRadius: "50%", background: "currentColor", display: "inline-block",
              boxShadow: botStatus?.is_running ? "0 0 6px #00ff40" : "none",
            }} />
            {botStatus?.is_running ? "ONLINE" : "OFFLINE"}
          </span>
        </div>

        {/* Wallet + Mode row */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
          <div>
            <div style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", letterSpacing: "1px", marginBottom: 2 }}>WALLET</div>
            <div style={{ fontSize: 22, fontWeight: 900, color: "#fff", fontFamily: "monospace", letterSpacing: "-0.5px" }}>
              ${botStatus?.usd_balance != null ? botStatus.usd_balance.toFixed(2) : "—"}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            {botStatus?.mode && (
              <div style={{ fontSize: 9, color: "rgba(245,158,11,0.8)", fontWeight: 700, letterSpacing: "1px", textTransform: "uppercase" }}>
                {botStatus.mode}
              </div>
            )}
            {botStatus?.pid && (
              <div style={{ fontSize: 9, color: "rgba(255,255,255,0.2)", fontFamily: "monospace", marginTop: 2 }}>
                PID {botStatus.pid}
              </div>
            )}
          </div>
        </div>

        {/* Start / Stop controls */}
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <motion.button
            whileTap={{ scale: 0.95 }}
            onClick={toggleBot}
            disabled={toggling}
            style={{
              flex: 1, padding: "10px 0", borderRadius: 10, fontWeight: 800, fontSize: 12,
              cursor: toggling ? "not-allowed" : "pointer",
              letterSpacing: "0.06em",
              background: toggling
                ? "rgba(255,255,255,0.04)"
                : botStatus?.is_running
                  ? "rgba(255,68,102,0.12)"
                  : "rgba(0,255,64,0.12)",
              border: `1px solid ${botStatus?.is_running ? "rgba(255,68,102,0.35)" : "rgba(0,255,64,0.35)"}`,
              color: botStatus?.is_running ? "#ff4466" : "#00ff40",
            }}
          >
            {toggling ? "⏳ …" : botStatus?.is_running ? "■ STOP" : "▶ START"}
          </motion.button>
        </div>

        {/* Mini log terminal */}
        {botStatus?.log?.length > 0 && (
          <div style={{
            background: "rgba(0,0,0,0.4)",
            borderRadius: 8, padding: "8px 10px",
            maxHeight: 96, overflowY: "auto",
          }}>
            {botStatus.log.slice(-4).map((line, i) => (
              <div key={i} style={{
                fontSize: 10, fontFamily: "monospace", color: "rgba(0,242,255,0.7)",
                lineHeight: 1.55, wordBreak: "break-word",
              }}>{line}</div>
            ))}
          </div>
        )}
      </div>

      {/* ── SYSTEM MODULES GRID ── */}
      <div>
        <div style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", letterSpacing: "1.5px", textTransform: "uppercase", marginBottom: 8, paddingLeft: 2 }}>Modules</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          {[
            { icon: "⚔️", label: "HR Arsenal",  sub: "Audit & recruit",  path: "/arsenal",   color: "255,68,102" },
            { icon: "🤖", label: "Fleet",        sub: "Agent control",    path: "/fleet",     color: "0,242,255" },
            { icon: "📦", label: "Inventory",    sub: "Live tracking",    path: "/inventory", color: "245,158,11" },
            { icon: "✍️", label: "Sign Flow",    sub: "Contracts",        path: "/signflow",  color: "129,140,248" },
            { icon: "👥", label: "Staff",        sub: "Team mgmt",        path: "/staff",     color: "16,185,129" },
            { icon: "🔗", label: "Quick Links",  sub: "Saved links",      path: "/links",     color: "99,102,241" },
            { icon: "🛡️", label: "Sandbox",      sub: "Honeypot",         path: "/sandbox",   color: "139,92,246" },
          ].map(m => (
            <motion.button
              key={m.path}
              whileTap={{ scale: 0.95 }}
              onClick={() => nav(m.path)}
              style={{
                padding: "14px 12px", borderRadius: 14,
                background: `rgba(${m.color},0.04)`,
                border: `1px solid rgba(${m.color},0.18)`,
                display: "flex", alignItems: "center", gap: 10, cursor: "pointer",
              }}
            >
              <span style={{ fontSize: 20, flexShrink: 0 }}>{m.icon}</span>
              <div style={{ textAlign: "left" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: `rgb(${m.color})` }}>{m.label}</div>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)" }}>{m.sub}</div>
              </div>
            </motion.button>
          ))}
        </div>
      </div>

      {/* ── RECENT AUDIT LOG ── */}
      {auditLogs.length > 0 && (
        <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 14, padding: "12px 14px" }}>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "1px", marginBottom: 10 }}>Recent Activity</div>
          {auditLogs.slice(-3).reverse().map((log, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 0", borderBottom: i < 2 ? "1px solid rgba(255,255,255,0.04)" : "none" }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#00f2ff", flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: "#e5e2e1", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{log.action}</div>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.25)" }}>{log.agent} · {log.timestamp}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── MODALS ── */}
      <Modal open={panel === "notes"} onClose={() => setPanel(null)}>
        <NotesPanel onClose={() => setPanel(null)} />
      </Modal>

      <Modal open={panel === "email"} onClose={() => setPanel(null)}>
        <EmailPanel onClose={() => setPanel(null)} />
      </Modal>

      <Modal open={panel === "calendar"} onClose={() => setPanel(null)}>
        <CalendarPanel onClose={() => setPanel(null)} onNavigate={p => { setPanel(null); nav(p); }} />
      </Modal>

      <Modal open={panel === "gas"} onClose={() => setPanel(null)}>
        <GasSyncPanel onClose={() => setPanel(null)} />
      </Modal>
    </motion.div>
  );
}
