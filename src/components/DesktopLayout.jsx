import React, { useState, useEffect, useCallback, useMemo, useRef, Suspense } from "react";
import { Routes, Route, Navigate, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../kernel/hooks/useAuth";

// Core Layout Components
import NeuralTerminal from "./Terminal2"; // Terminal 2.0 — flip back to "./NeuralTerminal" to roll back
import GoogleSignIn from "./GoogleSignIn";

// ── Dynamic block registry (cartridge reader) ─────────────────────
// Blocks are auto-discovered from src/blocks/*/index.jsx + manifest. To add a
// block: drop its folder in src/blocks/ — it wires itself into nav + routes.
import { getNavGroups, getRoutes } from "../kernel/blockRegistry";

import { Terminal } from 'lucide-react';
import BlockShell from './BlockShell';
import AuroraField from './AuroraField';
import { BlockIcon, SectionIcon } from './BlockIcon';

// Everything is a block now — nav + routes come purely from the registry.
// Add non-block component routes here only if something can't be a cartridge.
const EXTRA_NAV = [];
const EXTRA_ROUTES = [];

// ── NAVIGATION SIDEBAR (LEFT COLUMN) — built from the registry ─────
// NAV_GROUPS/MENU_ITEMS are now computed inside DesktopLayout (see below):
// they depend on settings.blockLayout, which is fetched at runtime, so they
// can't be static module-level constants anymore.
const BLOCK_ROUTES = [...getRoutes(), ...EXTRA_ROUTES];

// The sidebar REFLECTS icon changes but never offers the edit affordance —
// customization lives on the Home dashboard only. `iconOverrides` is the live
// per-block icon map fetched from /api/blocks/nav, keyed by block id.
export function RolodexNav({ groups, currentPath, onNavigate, iconOverrides = {} }) {
  const [activeGroup, setActiveGroup] = useState(() => {
    const saved = localStorage.getItem('aeon_rolodex_group');
    if (saved && groups.some(g => g.id === saved)) return saved;
    const found = groups.find(g => g.items.some(i => i.path === currentPath));
    return found ? found.id : groups[0].id;
  });

  useEffect(() => {
    const found = groups.find(g => g.items.some(i => i.path === currentPath));
    if (found) setActiveGroup(found.id);
  }, [currentPath]);

  useEffect(() => { localStorage.setItem('aeon_rolodex_group', activeGroup); }, [activeGroup]);

  return (
    <nav aria-label="AEON blocks" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Group icon strip */}
      <div style={{ display: 'flex', justifyContent: 'center', gap: '2px', padding: '8px 6px', borderBottom: '1px solid rgba(255,255,255,0.04)', flexWrap: 'wrap' }}>
        {groups.map(g => {
          const isActive = g.id === activeGroup;
          const hasActive = g.items.some(i => i.path === currentPath);
          return (
            <button key={g.id} onClick={() => setActiveGroup(g.id)} title={g.label}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px',
                padding: '5px 6px', borderRadius: '6px', cursor: 'pointer',
                border: isActive ? '1px solid rgba(0,242,255,0.25)' : '1px solid transparent',
                background: isActive ? 'rgba(0,242,255,0.08)' : 'transparent',
                transition: 'all 0.15s', minWidth: '36px',
              }}>
              <SectionIcon id={g.id} size={14} />
              <span style={{ fontSize: '7px', fontWeight: 700, letterSpacing: '0.5px', color: isActive ? '#00f2ff' : 'rgba(255,255,255,0.3)', transition: 'color 0.15s' }}>
                {g.label.slice(0, 4)}
              </span>
              {hasActive && !isActive && <div style={{ width: 3, height: 3, borderRadius: '50%', background: '#00f2ff', marginTop: '-2px' }} />}
            </button>
          );
        })}
      </div>

      {/* Active group label */}
      <div style={{ padding: '6px 12px 2px', fontSize: '9px', fontWeight: 800, letterSpacing: '1.5px', color: 'rgba(0,242,255,0.5)' }}>
        {groups.find(g => g.id === activeGroup)?.label}
      </div>

      {/* Items */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '2px 8px 8px' }}>
        {groups.find(g => g.id === activeGroup)?.items.map(item => {
          const active = currentPath === item.path;
          const displayIconAsset = iconOverrides[item.id] || item.iconAsset;
          return (
            <div key={item.path} style={{ position: 'relative' }}>
              <button onClick={() => onNavigate(item.path)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '10px',
                  width: '100%', padding: '8px 10px', marginBottom: '2px',
                  background: active ? 'rgba(0,242,255,0.1)' : 'transparent',
                  border: active ? '1px solid rgba(0,242,255,0.2)' : '1px solid transparent',
                  borderRadius: '6px', cursor: 'pointer', textAlign: 'left',
                  color: active ? '#00f2ff' : 'rgba(229,226,225,0.6)',
                  fontSize: '12px', fontWeight: active ? 700 : 500,
                  transition: 'all 0.15s',
                }}
                onMouseOver={e => { if (!active) { e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; e.currentTarget.style.color = '#fff'; } }}
                onMouseOut={e => { if (!active) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(229,226,225,0.6)'; } }}>
                <span style={{ width: '20px', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
                  <BlockIcon
                    iconAsset={displayIconAsset}
                    iconAssetPng={item.iconAssetPng}
                    fallback={item.icon}
                    size={16}
                  />
                </span>
                {item.label}
                {active && <div style={{ marginLeft: 'auto', width: 5, height: 5, borderRadius: '50%', background: '#00f2ff', boxShadow: '0 0 6px #00f2ff', flexShrink: 0 }} />}
              </button>
            </div>
          );
        })}
      </div>
    </nav>
  );
}

function DesktopNav({ user, groups, iconOverrides }) {
  const nav = useNavigate();
  const loc = useLocation();
  const { logout } = useAuth();
  const [restarting, setRestarting] = useState(false);

  const handleRestart = async () => {
    if (!window.confirm('⚡ FULL SYSTEM RESTART\n\nThis will close all servers and relaunch the Command Center.\nContinue?')) return;
    setRestarting(true);
    try {
      await fetch('/api/system/restart', { method: 'POST' });
    } catch {} // Server dies before responding — expected
    // Wait for the server to come back online, then reload
    const waitForServer = () => {
      setTimeout(() => {
        fetch('/api/health').then(() => {
          window.location.reload();
        }).catch(() => waitForServer());
      }, 2000);
    };
    waitForServer();
  };

  return (
    <div className="module-panel" style={{ height: "100%" }}>
      <div className="panel-header" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <img src="/brand/aeon-mark/aeon-icon-64.png" alt="" width="16" height="16" style={{ borderRadius: '3px', flexShrink: 0 }} />
        AEON OS KERNEL
      </div>
      
      {/* User Profile */}
      <div style={{
        padding: "12px", borderBottom: "1px solid rgba(255,255,255,0.05)",
        display: "flex", alignItems: "center", gap: "10px",
        justifyContent: "space-between"
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {user?.photoURL
            ? <img src={user.photoURL} alt="avatar" style={{ width: 28, height: 28, borderRadius: "50%", border: "1px solid #00f2ff", boxShadow: "0 0 8px rgba(0,242,255,0.3)" }} />
            : <div style={{ width: 28, height: 28, borderRadius: "50%", background: "rgba(0,242,255,0.2)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>👤</div>
          }
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#e5e2e1" }}>{user?.displayName || "CEO"}</div>
            <div style={{ fontSize: 9, color: "rgba(0,242,255,0.7)", fontFamily: "monospace", marginTop: 2 }}>v5.0 · AUTH</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: "4px" }}>
          <button 
            onClick={() => window.location.href = window.location.origin + '?clean=true'}
            style={{
              background: "rgba(0,242,255,0.08)", border: "1px solid rgba(0,242,255,0.25)", color: "#00f2ff",
              borderRadius: "4px", padding: "4px", fontSize: "8px", fontWeight: "bold", cursor: "pointer", transition: "all 0.2s"
            }}
            onMouseOver={e => e.currentTarget.style.background = "rgba(0,242,255,0.2)"}
            onMouseOut={e => e.currentTarget.style.background = "rgba(0,242,255,0.08)"}
            title="Clean Cache"
          >
            CLN
          </button>
          <button 
            onClick={logout}
            style={{
              background: "rgba(255,68,102,0.08)", border: "1px solid rgba(255,68,102,0.25)", color: "#ff4466",
              borderRadius: "4px", padding: "4px", fontSize: "8px", fontWeight: "bold", cursor: "pointer", transition: "all 0.2s"
            }}
            onMouseOver={e => e.currentTarget.style.background = "rgba(255,68,102,0.2)"}
            onMouseOut={e => e.currentTarget.style.background = "rgba(255,68,102,0.08)"}
            title="Log Out"
          >
            OUT
          </button>
          <button 
            onClick={handleRestart}
            disabled={restarting}
            style={{
              background: restarting ? "rgba(255,170,0,0.2)" : "rgba(255,170,0,0.08)", border: "1px solid rgba(255,170,0,0.25)", color: "#ffaa00",
              borderRadius: "4px", padding: "4px", fontSize: "8px", fontWeight: "bold", cursor: restarting ? "wait" : "pointer", transition: "all 0.2s"
            }}
            onMouseOver={e => { if(!restarting) e.currentTarget.style.background = "rgba(255,170,0,0.2)"; }}
            onMouseOut={e => { if(!restarting) e.currentTarget.style.background = "rgba(255,170,0,0.08)"; }}
            title="Restart Server"
          >
            {restarting ? '...' : 'RST'}
          </button>
        </div>
      </div>

      {/* Rolodex Navigation */}
      <RolodexNav groups={groups} currentPath={loc.pathname} onNavigate={nav} iconOverrides={iconOverrides} />

      <div style={{ padding: "10px", borderTop: "1px solid rgba(255,255,255,0.05)", fontSize: "9px", color: "rgba(255,255,255,0.2)", textAlign: "center", fontFamily: "monospace", letterSpacing: "1px" }}>
        SYSTEM ONLINE · ALL SYNAPSES FIRE
      </div>
    </div>
  );
}

// ── DESKTOP LAYOUT ────────────────────────────────────────────────
export default function DesktopLayout({ chatHistory, auditLogs }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  const navigate = useNavigate();

  // Shared Data State
  const [brainData, setBrainData] = useState({ nodes: [] });
  const [selectedModel, setSelectedModel] = useState("gemini");
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  // ── Block layout (settings.blockLayout) — the operator's own section
  // reclassification/renames/custom sections. One fetch here, shared by the
  // sidebar AND every routed block (Dashboard's grid included) via props,
  // so dragging a block on the Dashboard updates the sidebar instantly
  // instead of only on next reload.
  const [blockLayout, setBlockLayout] = useState(null);
  useEffect(() => {
    fetch('/api/settings').then(r => r.json()).then(d => {
      setBlockLayout(d?.settings?.blockLayout || { overrides: {}, customGroups: {}, groupOverrides: {} });
    }).catch(() => setBlockLayout({ overrides: {}, customGroups: {}, groupOverrides: {} }));
  }, []);

  // ── Live block icons (/api/blocks/nav) ────────────────────────────────
  // The registry reads manifests through Vite's build-time glob, so a manifest
  // write is invisible to a running prod build until rebuild. This runtime map
  // is the bridge: ONE fetch here, shared by the sidebar AND every block via
  // props, so changing an icon on the Home dashboard updates the sidebar
  // immediately instead of only after a rebuild. Icon is global by construction
  // — there is no second store to drift.
  const [iconOverrides, setIconOverrides] = useState({});
  const refreshIcons = useCallback(() => {
    fetch('/api/blocks/nav')
      .then(r => r.json())
      .then(d => {
        const map = {};
        for (const [id, v] of Object.entries(d.blocks || {})) map[id] = v.iconAsset;
        setIconOverrides(map);
      })
      .catch(() => {});
  }, []);
  useEffect(() => { refreshIcons(); }, [refreshIcons]);

  const saveBlockLayout = useCallback((next) => {
    setBlockLayout(next);
    fetch('/api/settings/block-layout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    }).catch(() => {});
  }, []);

  const NAV_GROUPS = useMemo(() => getNavGroups(EXTRA_NAV, blockLayout), [blockLayout]);
  const MENU_ITEMS = useMemo(() => NAV_GROUPS.flatMap(g => g.items), [NAV_GROUPS]);

  const handleViewChange = useCallback((view) => {
    const viewMap = {
      chat:            "/fleet",
      staff:           "/staff",
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
      <span style={{ fontSize: "12px", color: "rgba(0,242,255,0.6)", fontFamily: "monospace", letterSpacing: "2px" }}>
        ESTABLISHING NEURAL LINK...
      </span>
    </div>
  );

  if (!user && !hasToken) return <GoogleSignIn />;

  // Header label derived from the block registry — no hardcoded map.
  const matchedItem = MENU_ITEMS.find(i => i.path === loc.pathname);
  const label = matchedItem ? matchedItem.label.toUpperCase() : "VIEWPORT";

  return (
    <div className={`command-center${menuOpen ? ' with-sidebar' : ''}`}>
      <a href="#aeon-main" className="skip-link">Skip to main content</a>

      {/* 1. TOP NAV (Span All) */}
      <div className="top-nav" style={{ gridColumn: "1 / -1" }}>
        <div className="nav-brand" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <img src="/brand/aeon-mark/aeon-icon-64.png" alt="" width="22" height="22" style={{ borderRadius: '5px', flexShrink: 0 }} />
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            aria-label={menuOpen ? 'Hide navigation menu' : 'Show navigation menu'}
            aria-expanded={menuOpen}
            style={{ background: 'transparent', border: 'none', color: '#00f2ff', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
          >
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/>
            </svg>
          </button>
          <div className="nav-title">AEON</div>
          <div style={{ fontSize: "10px", color: "rgba(0,242,255,0.7)", fontFamily: "monospace", border: "1px solid rgba(0,242,255,0.3)", padding: "2px 6px", borderRadius: "4px", background: "rgba(0,242,255,0.1)" }}>
            v5.0
          </div>
        </div>
        
        <div className="nav-center">
          <div style={{ fontSize: "12px", color: "#64748b", fontWeight: 700, letterSpacing: "2px" }}>
            ACTIVE PORTAL: <span style={{ color: "#fff" }}>{label}</span>
          </div>
        </div>
        
        <div className="nav-actions" style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button 
            className="reset-btn"
            onClick={async () => {
              if (!window.confirm('⚡ FULL SYSTEM RESTART?')) return;
              try { await fetch('/api/system/restart', { method: 'POST' }); } catch {}
              const wait = () => setTimeout(() => { fetch('/api/health').then(() => window.location.reload()).catch(() => wait()); }, 2000);
              wait();
            }}
            style={{ cursor: 'pointer', border: '1px solid rgba(255,170,0,0.3)', color: '#ffaa00' }}
          >
            🔄 RESTART
          </button>
          <button className="reset-btn">
            <span style={{ color: "#00ff40" }}>●</span> SYSTEM HEALTH
          </button>
        </div>
      </div>

      {/* 2. LEFT PANEL (Navigation) */}
      {menuOpen && <DesktopNav user={user} groups={NAV_GROUPS} iconOverrides={iconOverrides} />}

      {/* 3. MIDDLE PANEL (Main Viewport) */}
      <div className="main-viewport">
        <AuroraField />
        <div className="viewport-header">
          <div style={{ padding: "16px", borderBottom: "1px solid rgba(255,255,255,0.05)", display: "flex", justifyContent: "space-between", alignItems: "center", background: "rgba(0,0,0,0.5)" }}>
            <span style={{ fontSize: "12px", fontWeight: 800, color: "rgba(255,255,255,0.6)", letterSpacing: "1px" }}>{label}</span>
          </div>
        </div>
        
        <div id="aeon-main" role="main" style={{ height: "100%", width: "100%", overflowY: "auto", paddingTop: "52px" }}>
          <Suspense fallback={
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh', color: 'rgba(0,242,255,0.6)', fontFamily: 'monospace', fontSize: '12px', letterSpacing: '2px' }}>
              LOADING BLOCK...
            </div>
          }>
          <Routes>
            {/* Auto-generated from the block registry. Every block receives the
                same props bag — extra props are harmless, so blocks that need
                chatHistory/auditLogs/onViewChange/blockLayout get them and the
                rest ignore them. */}
            {BLOCK_ROUTES.map(({ path, Component, id, uiMode, manifest }) => (
              <Route
                key={id}
                path={path}
                element={
                  <BlockShell uiMode={uiMode} manifest={manifest}>
                    <Component
                      chatHistory={chatHistory} auditLogs={auditLogs} onViewChange={handleViewChange}
                      blockLayout={blockLayout} onBlockLayoutChange={saveBlockLayout}
                      iconOverrides={iconOverrides} onIconChanged={refreshIcons}
                    />
                  </BlockShell>
                }
              />
            ))}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          </Suspense>
        </div>
      </div>

      {/* 4. RIGHT PANEL (Neural Terminal Desktop View) */}
      <div className="module-panel desktop-terminal-panel" style={{ width: '100%', flexShrink: 0 }}>
        <div className="panel-header" style={{ justifyContent: 'space-between' }}>
          <span>🧠 NEURAL TERMINAL</span>
          <span style={{ fontSize: '10px', color: '#00f2ff' }}>ONLINE</span>
        </div>
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <NeuralTerminal 
            brainData={brainData}
            allData={brainData}
            selectedModel={selectedModel}
          />
        </div>
      </div>



      {/* FAB & MODAL FOR SMALLER SCREENS */}
      <button className="chat-fab" onClick={() => setIsChatOpen(true)}>
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
