import React, { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { getNavGroups, BLOCKS } from "../kernel/blockRegistry";
import { BlockIcon } from "./BlockIcon";

// Full menu derives from the live block registry — same source as the desktop sidebar.
// Adding a new block with a manifest automatically shows it here too.
function buildMenuFromRegistry() {
  const groups = getNavGroups();
  return groups.flatMap(g => g.items.map(item => ({
    path:  item.path,
    label: item.label,
    icon:  item.icon,
    iconAsset: item.iconAsset,
    iconAssetPng: item.iconAssetPng,
  })));
}

// Bottom tab bar — Home is pinned, the next 3 slots are whichever blocks the
// manifest ordering puts first (BLOCKS is already sorted by nav.order), and
// More opens the full menu. Was a hardcoded 4-tab list pointing at /scheduler
// and /clients — routes that don't exist in this block roster at all
// (legacy from the AEONv3x/aeon-213 lineage this build was assembled from).
// Manifest-as-truth means the tab bar can never point at a dead route again.
function buildQuickTabs() {
  const picks = BLOCKS
    .filter(b => b.route && b.route !== '/' && b.uiMode !== 'headless')
    .slice(0, 3)
    .map(b => ({
      path: b.route,
      label: b.label,
      icon: b.icon,
      iconAsset: b.iconAsset,
      iconAssetPng: b.iconAssetPng,
    }));
  return [
    {
      path: "/",
      label: "Home",
      icon: "CircleGauge",
      iconAsset: "/brand/block-icons/dashboard.svg",
      iconAssetPng: "/brand/block-icons/png/dashboard.png",
    },
    ...picks,
    { path: "/_menu", label: "More", icon: "Boxes" },
  ];
}

export default function MobileNav() {
  const nav = useNavigate();
  const loc = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  // Built once per render — registry is built at import time, this is just a re-shape
  const fullMenu = buildMenuFromRegistry();
  const TABS = buildQuickTabs();

  return (
    <>
      {/* Full app grid overlay */}
      {menuOpen && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 999,
            background: 'rgba(0,0,0,0.88)', backdropFilter: 'blur(14px)',
            display: 'flex', flexDirection: 'column',
            padding: '60px 20px 80px', overflow: 'auto',
          }}
          onClick={() => setMenuOpen(false)}
        >
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
            gap: '8px', maxWidth: '420px', margin: '0 auto', width: '100%',
          }}>
            {fullMenu.map(item => {
              const active = loc.pathname === item.path;
              return (
                <button
                  key={item.path + item.label}
                  onClick={() => { nav(item.path); setMenuOpen(false); }}
                  style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center',
                    gap: '4px', padding: '12px 4px', borderRadius: '12px',
                    border: active
                      ? '1px solid var(--accent, #00f2ff)'
                      : '1px solid rgba(255,255,255,0.08)',
                    background: active
                      ? 'rgba(0,242,255,0.08)'
                      : 'rgba(255,255,255,0.03)',
                    color: active ? 'var(--accent, #00f2ff)' : '#ccc',
                    fontSize: '10px', fontWeight: 600, cursor: 'pointer',
                  }}
                >
                  <BlockIcon
                    iconAsset={item.iconAsset}
                    iconAssetPng={item.iconAssetPng}
                    fallback={item.icon}
                    size={22}
                  />
                  {item.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Bottom tab bar */}
      <nav className="aeon-nav" role="navigation" aria-label="Main navigation">
        {TABS.map(t => {
          const isActive = t.path === '/_menu' ? menuOpen : loc.pathname === t.path;
          return (
            <button
              key={t.path}
              className={`nav-item${isActive ? ' active' : ''}`}
              onClick={() => {
                if (t.path === '/_menu') setMenuOpen(!menuOpen);
                else { nav(t.path); setMenuOpen(false); }
              }}
              aria-label={t.label}
            >
              <BlockIcon
                iconAsset={t.iconAsset}
                iconAssetPng={t.iconAssetPng}
                fallback={t.icon}
                size={20}
              />
              <span className="nav-label">{t.label}</span>
            </button>
          );
        })}
      </nav>
    </>
  );
}
