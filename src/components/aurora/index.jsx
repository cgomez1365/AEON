/**
 * Aurora Component Library
 * Single import for all shared AEON UI primitives.
 * All styling via CSS custom properties from aurora.css — no external deps.
 *
 * import { Card, StatCard, Button, Badge, AgentOrb, Section, EmptyState, Spinner, useToast, ToastContainer } from '../../components/aurora'
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';

// ── Accent maps ──────────────────────────────────────────────────────────────
const ACCENT_COLOR = {
  cyan:    'var(--accent)',
  violet:  'var(--violet)',
  emerald: 'var(--emerald)',
  amber:   'var(--amber)',
  coral:   'var(--coral)',
};

const ACCENT_DIM = {
  cyan:    'var(--accent-dim)',
  violet:  'var(--accent2-dim)',
  emerald: 'var(--emerald-dim)',
  amber:   'var(--amber-dim)',
  coral:   'var(--coral-dim)',
};

const ACCENT_GLOW = {
  cyan:    'var(--glow-primary)',
  violet:  'var(--glow-secondary)',
  emerald: 'var(--glow-emerald)',
  amber:   'var(--glow-amber)',
  coral:   'var(--glow-coral)',
};

const ACCENT_BORDER = {
  cyan:    'rgba(0,200,216,0.3)',
  violet:  'rgba(124,58,237,0.3)',
  emerald: 'rgba(16,185,129,0.3)',
  amber:   'rgba(245,158,11,0.3)',
  coral:   'rgba(244,63,94,0.3)',
};

// ── Card ─────────────────────────────────────────────────────────────────────
/**
 * Glass surface container. The foundation card for all block UIs.
 * @param {{ children, className, hover, accent, onClick }} props
 */
export function Card({ children, className = '', hover = true, accent = null, onClick, style: extraStyle }) {
  const [hovered, setHovered] = useState(false);

  const base = {
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-lg)',
    padding: 'var(--sp-4)',
    boxShadow: 'var(--shadow-card), var(--shadow-inset)',
    transition: 'border-color 0.22s var(--ease-smooth), transform 0.22s var(--ease-smooth), box-shadow 0.22s var(--ease-smooth)',
    position: 'relative',
    backdropFilter: 'var(--glass)',
    WebkitBackdropFilter: 'var(--glass)',
    cursor: onClick ? 'pointer' : 'default',
  };

  const accentLeft = accent ? {
    borderLeft: `2px solid ${ACCENT_COLOR[accent] || 'var(--accent)'}`,
    boxShadow: `var(--shadow-card), var(--shadow-inset), -2px 0 12px ${ACCENT_DIM[accent] || 'var(--accent-dim)'}`,
  } : {};

  const hoverStyle = hover && hovered ? {
    transform: 'translateY(-1px)',
    borderColor: accent ? (ACCENT_BORDER[accent] || 'var(--border-hi)') : 'var(--border-hi)',
    boxShadow: accent
      ? `var(--shadow-panel), var(--shadow-inset), ${ACCENT_GLOW[accent] || ''}`
      : 'var(--shadow-panel), var(--shadow-inset)',
  } : {};

  return (
    <div
      className={className}
      style={{ ...base, ...accentLeft, ...(extraStyle || {}), ...hoverStyle }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
    >
      {children}
    </div>
  );
}

// ── StatCard ─────────────────────────────────────────────────────────────────
/**
 * Metric display card with value, label, trend pill, and optional icon.
 * @param {{ label, value, sub, accent, icon, trend }} props
 */
export function StatCard({ label, value, sub, accent = 'cyan', icon, trend }) {
  const color = ACCENT_COLOR[accent] || 'var(--accent)';
  const glow  = ACCENT_GLOW[accent]  || 'var(--glow-primary)';

  const trendPositive = trend > 0;
  const trendColor    = trendPositive ? 'var(--emerald)' : 'var(--coral)';
  const trendBg       = trendPositive ? 'var(--emerald-dim)' : 'var(--coral-dim)';
  const trendBorder   = trendPositive ? 'rgba(16,185,129,0.25)' : 'rgba(244,63,94,0.25)';
  const trendLabel    = trend != null ? `${trend > 0 ? '+' : ''}${trend}%` : null;

  return (
    <Card accent={accent} hover>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 'var(--sp-2)' }}>
        <span style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '10px',
          fontWeight: 700,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: 'var(--text-dim)',
        }}>
          {label}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {icon && <span style={{ color, opacity: 0.7 }}>{icon}</span>}
          {trendLabel && (
            <span style={{
              fontSize: '10px',
              fontWeight: 700,
              padding: '2px 7px',
              borderRadius: 'var(--radius-full)',
              background: trendBg,
              color: trendColor,
              border: `1px solid ${trendBorder}`,
              fontFamily: 'var(--font-mono)',
            }}>
              {trendLabel}
            </span>
          )}
        </div>
      </div>

      <div style={{
        fontSize: '28px',
        fontWeight: 700,
        letterSpacing: '-0.03em',
        color,
        filter: `drop-shadow(0 0 8px ${color})`,
        lineHeight: 1.1,
        marginBottom: sub ? 'var(--sp-1)' : 0,
      }}>
        {value}
      </div>

      {sub && (
        <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginTop: 'var(--sp-1)' }}>
          {sub}
        </div>
      )}
    </Card>
  );
}

// ── Button ────────────────────────────────────────────────────────────────────
/**
 * Unified button — wraps .btn CSS classes from aurora.css.
 * @param {{ children, variant, size, loading, disabled, onClick, className, icon }} props
 */
export function Button({
  children,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  onClick,
  className = '',
  icon,
}) {
  const variantClass = {
    primary: 'btn btn-primary',
    ghost:   'btn btn-ghost',
    violet:  'btn btn-violet',
    emerald: 'btn btn-emerald',
    danger:  'btn btn-danger',
    coral:   'btn btn-danger',
  }[variant] || 'btn btn-primary';

  const sizeClass = size === 'sm' ? 'btn-sm' : size === 'lg' ? '' : '';

  const classes = [variantClass, sizeClass, className, loading || disabled ? 'disabled' : '']
    .filter(Boolean).join(' ');

  return (
    <button
      className={classes}
      onClick={onClick}
      disabled={disabled || loading}
      aria-disabled={disabled || loading}
      style={{ minHeight: size === 'sm' ? '34px' : '44px' }}
    >
      {loading ? (
        <Spinner size="sm" color={variant === 'ghost' ? 'cyan' : 'cyan'} />
      ) : (
        <>
          {icon && <span>{icon}</span>}
          {children}
        </>
      )}
    </button>
  );
}

// ── Badge ─────────────────────────────────────────────────────────────────────
/**
 * Status/label chip. Wraps aurora.css .badge-* classes.
 * @param {{ children, variant, dot, size }} props
 */
export function Badge({ children, variant = 'cyan', dot = false, size = 'md' }) {
  const variantClass = {
    cyan:    'badge badge-primary',
    violet:  'badge badge-violet',
    emerald: 'badge badge-emerald',
    amber:   'badge badge-amber',
    coral:   'badge badge-coral',
    mute:    'badge',
  }[variant] || 'badge badge-primary';

  const muteStyle = variant === 'mute' ? {
    background: 'rgba(255,255,255,0.04)',
    color: 'var(--text-dim)',
    border: '1px solid var(--border-mute)',
  } : {};

  const sizeStyle = size === 'sm' ? { fontSize: '9px', padding: '2px 7px' } : {};

  return (
    <span className={variantClass} style={{ ...muteStyle, ...sizeStyle }}>
      {dot && <StatusDot variant={variant} />}
      {children}
    </span>
  );
}

/** Internal pulsing status dot used by Badge */
function StatusDot({ variant }) {
  const color = ACCENT_COLOR[variant] || 'var(--text-dim)';
  return (
    <span style={{
      display: 'inline-block',
      width: '6px',
      height: '6px',
      borderRadius: '50%',
      background: color,
      flexShrink: 0,
      animation: 'pulse 2.2s ease-in-out infinite',
    }} />
  );
}

// ── AgentOrb ──────────────────────────────────────────────────────────────────
/**
 * Pulsing circular agent identity orb with optional label.
 * @param {{ name, color, active, size, label }} props
 */
export function AgentOrb({ name = '?', color = 'cyan', active = false, size = 'md', label }) {
  const dim = { sm: 28, md: 36, lg: 52 }[size] || 36;
  const fs  = { sm: 11, md: 13, lg: 20 }[size] || 13;

  const orbClass = ['agent-orb', `orb-${color}`, active ? 'orb-active' : ''].filter(Boolean).join(' ');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px' }}>
      <div
        className={orbClass}
        style={{ width: dim, height: dim, fontSize: fs }}
        aria-label={label || name}
      >
        {name[0]?.toUpperCase()}
      </div>
      {label && (
        <span style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '9px',
          fontWeight: 600,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--text-dim)',
        }}>
          {label}
        </span>
      )}
    </div>
  );
}

// ── Section ───────────────────────────────────────────────────────────────────
/**
 * Labeled section wrapper with uppercase mono header + optional action.
 * @param {{ title, children, action, className }} props
 */
export function Section({ title, children, action, className = '' }) {
  return (
    <div className={className} style={{ marginBottom: 'var(--sp-6)' }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-3)',
        marginBottom: 'var(--sp-3)',
      }}>
        <span style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '10px',
          fontWeight: 700,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: 'var(--text-dim)',
          whiteSpace: 'nowrap',
        }}>
          {title}
        </span>
        <div style={{ flex: 1, height: '1px', background: 'var(--border)' }} />
        {action && <div>{action}</div>}
      </div>
      {children}
    </div>
  );
}

// ── EmptyState ────────────────────────────────────────────────────────────────
/**
 * Centered placeholder for zero-data states.
 * @param {{ icon, title, sub, action }} props
 */
export function EmptyState({ icon, title, sub, action }) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 'var(--sp-3)',
      padding: 'var(--sp-10)',
      textAlign: 'center',
      color: 'var(--text-dim)',
    }}>
      {icon && (
        <div style={{ fontSize: '36px', opacity: 0.3, lineHeight: 1 }}>
          {icon}
        </div>
      )}
      {title && (
        <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-dim)' }}>
          {title}
        </div>
      )}
      {sub && (
        <div style={{ fontSize: '12px', color: 'var(--text-faint)', maxWidth: '280px', lineHeight: 1.5 }}>
          {sub}
        </div>
      )}
      {action && <div style={{ marginTop: 'var(--sp-2)' }}>{action}</div>}
    </div>
  );
}

// ── Spinner ───────────────────────────────────────────────────────────────────
/**
 * Loading spinner using aurora.css keyframes.
 * @param {{ size, color }} props
 */
export function Spinner({ size = 'md', color = 'cyan' }) {
  const dim = { sm: 16, md: 26, lg: 40 }[size] || 26;
  const bw  = { sm: 2,  md: 2.5, lg: 3.5 }[size] || 2.5;
  const c   = ACCENT_COLOR[color] || 'var(--accent)';

  return (
    <div
      role="status"
      aria-label="Loading"
      style={{
        width: dim,
        height: dim,
        border: `${bw}px solid rgba(255,255,255,0.08)`,
        borderTopColor: c,
        borderRadius: '50%',
        animation: 'spin 0.7s linear infinite',
        flexShrink: 0,
      }}
    />
  );
}

// ── Toast / useToast ──────────────────────────────────────────────────────────
const TOAST_TYPE = {
  success: { color: 'var(--emerald)', bg: 'var(--emerald-dim)', border: 'rgba(16,185,129,0.3)',  icon: '✓' },
  error:   { color: 'var(--coral)',   bg: 'var(--coral-dim)',   border: 'rgba(244,63,94,0.3)',   icon: '✕' },
  warning: { color: 'var(--amber)',   bg: 'var(--amber-dim)',   border: 'rgba(245,158,11,0.3)',  icon: '⚠' },
  info:    { color: 'var(--accent)',  bg: 'var(--accent-dim)',  border: 'rgba(0,200,216,0.3)',   icon: 'i' },
};

// Global toast state — one store shared across all useToast callers
const _listeners = new Set();
let _nextId = 1;
let _toasts = [];

function _emit(toasts) {
  _toasts = toasts;
  _listeners.forEach(fn => fn(toasts));
}

/**
 * Hook that returns { showToast }. Pair with <ToastContainer /> somewhere in the tree.
 * showToast(message, type) — type: 'success'|'error'|'info'|'warning'
 */
export function useToast() {
  const showToast = useCallback((message, type = 'info') => {
    const id = _nextId++;
    _emit([..._toasts, { id, message, type }]);
    setTimeout(() => _emit(_toasts.filter(t => t.id !== id)), 3000);
  }, []);

  return { showToast };
}

/**
 * Render this once near the root. Displays active toasts fixed bottom-right.
 */
export function ToastContainer() {
  const [toasts, setToasts] = useState(_toasts);

  useEffect(() => {
    _listeners.add(setToasts);
    return () => _listeners.delete(setToasts);
  }, []);

  if (!toasts.length) return null;

  return (
    <div style={{
      position: 'fixed',
      bottom: '24px',
      right: '24px',
      zIndex: 9999,
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      pointerEvents: 'none',
    }}>
      {toasts.map(t => {
        const s = TOAST_TYPE[t.type] || TOAST_TYPE.info;
        return (
          <div
            key={t.id}
            role="alert"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              padding: '10px 16px',
              borderRadius: 'var(--radius-md)',
              background: 'var(--bg-elevated)',
              border: `1px solid ${s.border}`,
              boxShadow: 'var(--shadow-panel)',
              backdropFilter: 'var(--glass)',
              WebkitBackdropFilter: 'var(--glass)',
              color: 'var(--text)',
              fontSize: '13px',
              fontWeight: 500,
              minWidth: '240px',
              maxWidth: '360px',
              animation: 'content-enter 0.22s ease both',
              pointerEvents: 'auto',
            }}
          >
            <span style={{
              width: '20px',
              height: '20px',
              borderRadius: '50%',
              background: s.bg,
              border: `1px solid ${s.border}`,
              color: s.color,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '10px',
              fontWeight: 800,
              flexShrink: 0,
            }}>
              {s.icon}
            </span>
            {t.message}
          </div>
        );
      })}
    </div>
  );
}
