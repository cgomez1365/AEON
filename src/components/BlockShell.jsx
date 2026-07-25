/**
 * BlockShell — wraps a block's content based on its manifest ui mode.
 *
 * full (default): block manages its own chrome — render children unwrapped.
 * minimal: thin sticky header (icon + label) + scrollable content below.
 * headless: no UI; safety guard (blockRegistry already excludes these from routes).
 */
import React from 'react';
import { BlockIcon } from './BlockIcon';

export default function BlockShell({ uiMode = 'full', manifest, children }) {
  if (uiMode === 'headless') return null;

  if (uiMode === 'minimal') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '10px 20px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-elevated)',
          backdropFilter: 'var(--glass)',
          WebkitBackdropFilter: 'var(--glass)',
          flexShrink: 0,
          position: 'sticky',
          top: 0,
          zIndex: 10,
        }}>
          <BlockIcon
            iconAsset={manifest?.nav?.iconAsset}
            iconAssetPng={manifest?.nav?.iconAssetPng}
            fallback={manifest?.nav?.icon || manifest?.icon || 'Boxes'}
            size={16}
          />
          <span style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '11px',
            fontWeight: 700,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'var(--text-dim)',
          }}>
            {manifest?.label || manifest?.id || ''}
          </span>
          <span style={{
            marginLeft: 'auto',
            fontFamily: 'var(--font-mono)',
            fontSize: '9px',
            padding: '2px 8px',
            borderRadius: 'var(--radius-full)',
            background: 'rgba(0,200,216,0.08)',
            border: '1px solid rgba(0,200,216,0.2)',
            color: 'var(--accent)',
          }}>
            MINIMAL
          </span>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {children}
        </div>
      </div>
    );
  }

  // full — block manages its own chrome
  return children;
}
