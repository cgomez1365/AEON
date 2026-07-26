import React, { useState, useEffect } from "react";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "./kernel/contexts/AuthContext";
import { AeonProvider } from "./kernel/contexts/AeonContext";
import DesktopLayout from "./components/DesktopLayout";
import MobileLayout from "./components/MobileLayout";
import AuthGate from "./components/AuthGate";
import CloudSetupGate from "./components/CloudSetupGate";
import { TelemetryProvider } from "./kernel/contexts/TelemetryContext";

// ── Load persisted appearance on boot (theme, accent, font) ──────────
// Order matters: theme_builder sets the base palette first, then
// appearance overlays accent + font on top so the user's simple color
// pick always wins over whatever the theme builder last saved.
async function applyPersistedAppearance() {
  const set = (k, v) => document.documentElement.style.setProperty(k, v);
  try {
    const tb = await fetch('/api/prefs/theme_builder').then(r => r.json()).catch(() => ({}));
    const t = tb.value;
    if (t?.colors) {
      if (t.colors.background) set('--bg', t.colors.background);
      if (t.colors.text) set('--text', t.colors.text);
      if (t.colors.panel) set('--bg-card', t.colors.panel);
      if (t.colors.border) set('--border', t.colors.border + '40');
      if (t.colors.accent) { set('--accent', t.colors.accent); set('--accent-dim', t.colors.accent + '1a'); }
    }
  } catch {}
  // appearance always applies last — its accent + font override theme_builder
  try {
    const ap = await fetch('/api/prefs/appearance').then(r => r.json()).catch(() => ({}));
    const a = ap.value;
    if (!a) return;
    if (a.accent) { set('--accent', a.accent); set('--accent-dim', a.accent + '1a'); }
    if (a.fontSize) set('font-size', `${a.fontSize}px`);
  } catch {}
}

export default function App() {
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);
  const [chatHistory, setChatHistory] = useState([]);
  const [auditLogs, setAuditLogs] = useState([]);

  useEffect(() => { applyPersistedAppearance(); }, []);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const [toastMessage, setToastMessage] = useState('');

  // B7 — IDE mode banner: "kernel is now editable" must be visible, not subtle.
  const [ideMode, setIdeMode] = useState({ active: false, banner: null });
  useEffect(() => {
    const poll = () => fetch('/api/build/ide-mode').then(r => r.json()).then(setIdeMode).catch(() => {});
    poll();
    const id = setInterval(poll, 15000);
    return () => clearInterval(id);
  }, []);

  // Clean cache interceptor
  useEffect(() => {
    if (window.location.search.includes('clean=true')) {
      const runClean = async () => {
        try {
          if ('serviceWorker' in navigator) {
            const registrations = await navigator.serviceWorker.getRegistrations();
            for (let reg of registrations) {
              await reg.unregister();
            }
          }
          if ('caches' in window) {
            const keys = await caches.keys();
            for (let key of keys) {
              await caches.delete(key);
            }
          }
          // Clear only AEON local storage keys
          Object.keys(localStorage).forEach(k => {
            if (k.startsWith('aeon_')) localStorage.removeItem(k);
          });
        } catch (e) {
          console.error('[AEON] Clean cache error:', e);
        }
        window.location.href = window.location.origin + '?cleaned=true';
      };
      runClean();
    }
  }, []);

  // Show confirmation toast
  useEffect(() => {
    if (window.location.search.includes('cleaned=true')) {
      setToastMessage('✅ Cache & Service Workers wiped clean! Running latest production build.');
      window.history.replaceState({}, document.title, window.location.pathname);
      setTimeout(() => setToastMessage(''), 6000);
    }
  }, []);

  // Force clear stale service workers and caches on every load
  useEffect(() => {
    const CURRENT_BUILD = '__BUILD_' + Date.now() + '__';
    const lastBuild = sessionStorage.getItem('aeon_build');
    
    // Always attempt SW update check
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then(registrations => {
        registrations.forEach(reg => {
          reg.update().catch(() => {});
          // Listen for new SW and force activate
          if (reg.waiting) {
            reg.waiting.postMessage({ type: 'SKIP_WAITING' });
          }
          reg.addEventListener('updatefound', () => {
            const newWorker = reg.installing;
            if (newWorker) {
              newWorker.addEventListener('statechange', () => {
                if (newWorker.state === 'activated') {
                  console.log('[AEON] New service worker activated — refreshing...');
                  window.location.reload();
                }
              });
            }
          });
        });
      });
    }
    
    // Clear old caches on first session load
    if (!lastBuild && 'caches' in window) {
      caches.keys().then(names => {
        names.forEach(name => caches.delete(name));
        console.log('[AEON] Cleared', names.length, 'stale caches');
      });
      sessionStorage.setItem('aeon_build', CURRENT_BUILD);
    }
  }, []);

  // Global Fetch Interceptor for Trace IDs (Forensics)
  useEffect(() => {
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
      const isApi = url.startsWith('/api');
      const _isVercel = window.location.hostname.includes('vercel.app');

      try {
        const response = await originalFetch.apply(this, args);
        // /api/kernel/llm is excluded — components handle their own 409 (needsLocalConfirm) gracefully
        // /api/auth/status 404s by design when no auth block is installed — settings handles it.
        const ignoredEndpoints = ['/api/chat', '/api/audit', '/api/search', '/api/health', '/api/canva/status', '/api/telemetry', '/api/llm-telemetry', '/api/ollama/status', '/api/ollama-status', '/api/gas/status', '/api/transcribe', '/api/shell/exec', '/api/kernel/llm', '/api/auth/status'];
        // 401 on auth/security routes is EXPECTED when locked or signed out —
        // the AuthGate handles it, so it must never raise the forensics banner.
        const isExpectedAuth401 = response.status === 401 && (url.startsWith('/api/auth/') || url.startsWith('/api/security/'));
        // 428 = intentional confirmation gate (dangerous commands) — not an error
        if (isApi && !response.ok && response.status !== 428 && !isExpectedAuth401 && !ignoredEndpoints.includes(url) && !_isVercel) {
          // Ignore silent background checks
          const clone = response.clone();
          try {
            const data = await clone.json();
            const traceId = data.correlation_id || 'PENDING_OR_UNREACHABLE';
            setToastMessage(<span>⚠️ [API FAILED] {url} <span style={{ fontFamily: 'monospace', color: '#ffb4ab', marginLeft: '8px' }}>Trace ID: {traceId}</span></span>);
            setTimeout(() => setToastMessage(''), 10000);
          } catch (e) {
            setToastMessage(<span>⚠️ [API FAILED] {url} <span style={{ fontFamily: 'monospace', color: '#ffb4ab', marginLeft: '8px' }}>Trace ID: PENDING_OR_UNREACHABLE</span></span>);
            setTimeout(() => setToastMessage(''), 10000);
          }
        }
        return response;
      } catch (err) {
        if (isApi && !_isVercel) {
          setToastMessage(<span>⚠️ [NETWORK DEAD] {url} <span style={{ fontFamily: 'monospace', color: '#ffb4ab', marginLeft: '8px' }}>Trace ID: PENDING_OR_UNREACHABLE</span></span>);
          setTimeout(() => setToastMessage(''), 10000);
        }
        throw err;
      }
    };
    return () => {
      window.fetch = originalFetch;
    };
  }, []);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [chatRes, auditRes] = await Promise.all([
          fetch("/api/chat").catch(() => null),
          fetch("/api/audit").catch(() => null),
        ]);
        if (chatRes?.ok) {
          const data = await chatRes.json();
          setChatHistory(Array.isArray(data) ? data : data.messages || []);
        }
        if (auditRes?.ok) {
          const data = await auditRes.json();
          setAuditLogs(Array.isArray(data) ? data : data.logs || []);
        }
      } catch { /* ignore offline errors */ }
    };
    fetchData();
    const id = setInterval(async () => {
      try {
        const r = await fetch("/api/audit").catch(() => null);
        if (r?.ok) { const d = await r.json(); setAuditLogs(Array.isArray(d) ? d : d.logs || []); }
      } catch {}
    }, 5000);
    return () => clearInterval(id);
  }, []);

  return (
    <BrowserRouter>
      <AuthProvider>
        <AeonProvider>
          <TelemetryProvider>
            {ideMode.active && (
              <div style={{
                position: 'sticky', top: 0, width: '100%', zIndex: 10000,
                background: 'repeating-linear-gradient(45deg, #3a1010, #3a1010 12px, #2a0a0a 12px, #2a0a0a 24px)',
                borderBottom: '2px solid #ff5252', color: '#ff8a80',
                padding: '8px 16px', textAlign: 'center', fontFamily: 'monospace',
                fontSize: '13px', fontWeight: 'bold', letterSpacing: '1px',
              }}>
                ⚠ {ideMode.banner || 'KERNEL IS NOW EDITABLE — IDE MODE (Tier 3) ACTIVE'} ⚠
              </div>
            )}
            {toastMessage && (
              <div style={{
                position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)',
                background: '#090d16', border: '1px solid #00f2ff', color: '#00f2ff',
                boxShadow: '0 0 20px rgba(0,242,255,0.25)', borderRadius: '8px',
                padding: '12px 24px', fontSize: '13px', fontWeight: 'bold', zIndex: 9999,
                fontFamily: 'sans-serif', pointerEvents: 'none', textAlign: 'center'
              }}>
                {toastMessage}
              </div>
            )}
            <CloudSetupGate>
              <AuthGate>
                {isMobile ? (
                  <MobileLayout chatHistory={chatHistory} auditLogs={auditLogs} />
                ) : (
                  <DesktopLayout chatHistory={chatHistory} auditLogs={auditLogs} />
                )}
              </AuthGate>
            </CloudSetupGate>
          </TelemetryProvider>
        </AeonProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
