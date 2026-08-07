import React, { useState, useEffect, useCallback, useMemo, Suspense } from "react";
import { Routes, Route, Navigate, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../kernel/hooks/useAuth";
import MobileNav from "./MobileNav";
import GoogleSignIn from "./GoogleSignIn";
import { Terminal } from 'lucide-react';
import { getNavGroups, getRoutes, BLOCKS } from "../kernel/blockRegistry";
import { RolodexNav } from "./DesktopLayout";
import NeuralTerminal from "./Terminal2"; // Terminal 2.0. NOTE (2026-08-07): the old
// ./NeuralTerminal is still in the tree but is NO LONGER a working rollback — Terminal2
// has since gained real stream cancellation (D1c), the challenge/outcome state machine
// (D2c), honest empty output (D2d) and the argument contract (D2e). It also still calls
// /api/memory/tidy and /api/orion-scrape, which no longer exist. Treat it as reference,
// not as a switch.
import { BlockIcon } from "./BlockIcon";

// Everything is a block now — nav + routes come purely from the registry.
// NAV_GROUPS is computed inside MobileLayout (depends on runtime-fetched
// settings.blockLayout — see DesktopLayout for why it can't be static here).
const BLOCK_ROUTES = getRoutes();

// ── MinimalBlockCard — auto-rendered for uiMode === 'minimal' blocks ──────────
function MinimalBlockCard({ manifest }) {
  return (
    <div style={{ padding: '24px 16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <BlockIcon
          iconAsset={manifest.nav?.iconAsset}
          iconAssetPng={manifest.nav?.iconAssetPng}
          fallback={manifest.nav?.icon || manifest.icon || 'Settings'}
          size={32}
        />
        <div>
          <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text)' }}>{manifest.label}</div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>{manifest.description || 'Running in background'}</div>
        </div>
        <div style={{ marginLeft: 'auto' }}>
          {/* health dot */}
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--emerald)', boxShadow: 'var(--glow-emerald)' }} />
        </div>
      </div>
      <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', padding: '10px 12px', background: 'var(--surface-1)', borderRadius: '8px', border: '1px solid var(--border)' }}>
        This block runs in minimal mode. Configure it in Settings or switch to full mode via manifest.
      </div>
    </div>
  );
}

// Build a uiMode lookup keyed by route path for fast access in Routes below.
const UI_MODE_BY_PATH = Object.fromEntries(BLOCKS.map(b => [b.route, { uiMode: b.uiMode, manifest: b.manifest }]));

// ── HEADER ───────────────────────────────────────────────────────
function TopBar({ view, onMenuToggle, menuOpen, groups }) {
  const loc = useLocation();
  const allItems = groups.flatMap(g => g.items);
  const match = allItems.find(i => i.path === loc.pathname);
  const label = match ? match.label : "AEON";

  return (
    <header style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "0 16px", height: "52px", flexShrink: 0,
      background: "rgba(14,14,14,0.95)",
      backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)",
      borderBottom: "1px solid rgba(255,255,255,0.07)",
      position: "sticky", top: 0, zIndex: 90,
    }}>
      <img
        src="/brand/aeon-mark/aeon-icon-64.png"
        alt="AEON"
        width="28"
        height="28"
        style={{ borderRadius: "5px", flexShrink: 0 }}
      />
      <span style={{ fontSize: "13px", fontWeight: 600, color: "rgba(229,226,225,0.7)", letterSpacing: "0.01em" }}>
        {label}
      </span>
      <button
        onClick={onMenuToggle}
        style={{
          background: "transparent", border: "none", cursor: "pointer",
          color: "rgba(229,226,225,0.6)", padding: "8px", borderRadius: "8px",
          display: "flex", alignItems: "center", justifyContent: "center",
          minWidth: "44px", minHeight: "44px",
          transition: "color 0.2s, background 0.2s",
        }}
        aria-label="Toggle menu"
      >
        {menuOpen ? (
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
          </svg>
        )}
      </button>
    </header>
  );
}

// ── SLIDE-OUT DRAWER MENU — built from the block registry ───────
// No hardcoded list. Nav items come from manifests via blockRegistry.

function DrawerMenu({ open, onClose, groups }) {
  const nav = useNavigate();
  const loc = useLocation();
  const { user, logout } = useAuth();

  return (
    <>
      {/* Backdrop */}
      {open && (
        <div
          onClick={onClose}
          style={{
            position: "fixed", inset: 0, zIndex: 200,
            background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)",
          }}
        />
      )}
      {/* Drawer */}
      <aside style={{
        position: "fixed", top: 0, right: 0, bottom: 0,
        width: "min(260px, 75vw)", zIndex: 210,
        background: "rgba(20,20,20,0.97)",
        backdropFilter: "blur(32px)", WebkitBackdropFilter: "blur(32px)",
        borderLeft: "1px solid rgba(255,255,255,0.08)",
        transform: open ? "translateX(0)" : "translateX(100%)",
        transition: "transform 0.28s cubic-bezier(0.4,0,0.2,1)",
        display: "flex", flexDirection: "column",
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}>
        {/* User */}
        <div style={{
          padding: "20px 16px", borderBottom: "1px solid rgba(255,255,255,0.07)",
          display: "flex", alignItems: "center", gap: "12px",
          justifyContent: "space-between"
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            {user?.photoURL
              ? <img src={user.photoURL} alt="avatar" style={{ width: 32, height: 32, borderRadius: "50%", border: "2px solid #00f2ff" }} />
              : <div style={{ width: 32, height: 32, borderRadius: "50%", background: "rgba(0,242,255,0.2)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>👤</div>
            }
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#e5e2e1" }}>{user?.displayName || "You"}</div>
              <div style={{ fontSize: 10, color: "rgba(229,226,225,0.4)", fontFamily: "monospace" }}>v5.0</div>
            </div>
          </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <button 
            onClick={() => { onClose(); window.location.href = window.location.origin + '?clean=true'; }}
            style={{
              background: "rgba(0,242,255,0.08)",
              border: "1px solid rgba(0,242,255,0.25)",
              color: "#00f2ff",
              borderRadius: "6px",
              padding: "4px 8px",
              fontSize: "9px",
              fontWeight: "bold",
              cursor: "pointer",
              textAlign: "center"
            }}
          >
            CLEAN CACHE
          </button>
          <button 
            onClick={() => { logout(); onClose(); }}
            style={{
              background: "rgba(255,68,102,0.08)",
              border: "1px solid rgba(255,68,102,0.25)",
              color: "#ff4466",
              borderRadius: "6px",
              padding: "4px 8px",
              fontSize: "9px",
              fontWeight: "bold",
              cursor: "pointer",
              textAlign: "center"
            }}
          >
            LOG OUT
          </button>
        </div>
      </div>

        {/* Nav links */}
        <div style={{ flex: 1, padding: "8px", display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <RolodexNav groups={groups} currentPath={loc.pathname} onNavigate={(p) => { nav(p); onClose(); }} />
        </div>

        {/* Version footer */}
        <div style={{ padding: "12px 16px", borderTop: "1px solid rgba(255,255,255,0.06)", fontSize: "10px", color: "rgba(229,226,225,0.25)", fontFamily: "monospace" }}>
          AEON OS v5.0 · Hive Mind Active
        </div>
      </aside>
    </>
  );
}

// ── MAIN LAYOUT ──────────────────────────────────────────────────
export default function MobileLayout({ chatHistory, auditLogs }) {
  const { user, loading } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const navigate = useNavigate();
  const loc = useLocation();

  // Mock brainData for mobile until global state is fully passed down
  const brainData = { nodes: [] };
  const [selectedModel, setSelectedModel] = useState(() => localStorage.getItem("aeon_active_agent") || "gemini-2.5-flash");

  // See DesktopLayout for why this can't be a static module constant: the
  // operator's section reclassification/renames live in settings.blockLayout.
  const [blockLayout, setBlockLayout] = useState(null);
  useEffect(() => {
    fetch('/api/settings').then(r => r.json()).then(d => {
      setBlockLayout(d?.settings?.blockLayout || { overrides: {}, customGroups: {}, groupOverrides: {} });
    }).catch(() => setBlockLayout({ overrides: {}, customGroups: {}, groupOverrides: {} }));
  }, []);

  const saveBlockLayout = useCallback((next) => {
    setBlockLayout(next);
    fetch('/api/settings/block-layout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    }).catch(() => {});
  }, []);

  const NAV_GROUPS = useMemo(() => getNavGroups([], blockLayout), [blockLayout]);

  const handleViewChange = useCallback((view) => {
    const viewMap = {
      chat:            "/fleet",
      training:        "/fleet",
      client_roster:   "/clients",
      outreach:        "/outreach",
      arsenal:         "/arsenal",
      email_campaigns: "/outreach",
      inventory_logs:  "/inventory",
    };
    navigate(viewMap[view] || "/");
  }, [navigate]);

  const params = new URLSearchParams(window.location.search);
  const hasToken = params.has('token');

  useEffect(() => {
    if (!user && hasToken && loc.pathname !== "/signflow") {
      navigate(`/signflow${window.location.search}`, { replace: true });
    }
  }, [user, hasToken, loc.pathname, navigate]);

  if (loading) return (
    <div className="aeon-splash">
      <div className="aeon-pulse" />
      <span style={{ fontSize: "11px", color: "rgba(229,226,225,0.4)", fontFamily: "monospace", letterSpacing: "0.1em" }}>
        INITIALIZING...
      </span>
    </div>
  );

  if (!user && !hasToken) return <GoogleSignIn />;

  return (
    <div className="aeon-shell">
      <TopBar menuOpen={menuOpen} onMenuToggle={() => setMenuOpen(v => !v)} groups={NAV_GROUPS} />
      <DrawerMenu open={menuOpen} onClose={() => setMenuOpen(false)} groups={NAV_GROUPS} />

      <main className="aeon-content">
        <Suspense fallback={
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh', color: 'rgba(0,242,255,0.6)', fontFamily: 'monospace', fontSize: '12px', letterSpacing: '2px' }}>
            LOADING BLOCK...
          </div>
        }>
        <Routes>
          {BLOCK_ROUTES
            .filter(({ path }) => (UI_MODE_BY_PATH[path]?.uiMode ?? 'full') !== 'headless')
            .map(({ path, Component, id }) => {
              const { uiMode, manifest } = UI_MODE_BY_PATH[path] || {};
              const element = uiMode === 'minimal'
                ? <MinimalBlockCard manifest={manifest} />
                : <Component blockLayout={blockLayout} onBlockLayoutChange={saveBlockLayout} />;
              return <Route key={id} path={path} element={element} />;
            })}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Suspense>
      </main>

      <MobileNav />

      {/* FAB & MODAL FOR MOBILE CHAT */}
      <button className="chat-fab" style={{ display: 'flex', bottom: '80px' }} onClick={() => setIsChatOpen(true)}>
        <Terminal size={24} />
      </button>

      {isChatOpen && (
        <div className="modal-overlay" onClick={() => setIsChatOpen(false)} style={{ zIndex: 1099, paddingTop: 0 }}>
          <div className="chat-modal" onClick={e => e.stopPropagation()}>
            <div className="chat-modal-header">
              <span style={{ fontSize: "12px", fontWeight: 800, color: "#00f2ff", letterSpacing: "2px" }}>💬 NEURAL TERMINAL</span>
              <button onClick={() => setIsChatOpen(false)} style={{ background: "transparent", border: "none", color: "#64748b", cursor: "pointer", fontSize: "18px" }}>✕</button>
            </div>
            <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
              <NeuralTerminal 
                brainData={brainData}
                allData={brainData}
                selectedModel={selectedModel}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
