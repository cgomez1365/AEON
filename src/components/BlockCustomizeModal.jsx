import React, { useState, useEffect, useCallback } from 'react';

const ACCENT  = '#00f2ff';
const BG      = 'rgba(10,14,20,0.98)';
const BORDER  = 'rgba(0,242,255,0.15)';
const MUTED   = 'rgba(229,226,225,0.5)';

export default function BlockCustomizeModal({ blockId, currentLabel, currentIconAsset, onSave, onClose }) {
  const [label, setLabel]         = useState(currentLabel || '');
  const [iconAsset, setIconAsset] = useState(currentIconAsset || '');
  const [icons, setIcons]         = useState([]);
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState('');

  useEffect(() => {
    fetch('/api/blocks/icons')
      .then(r => r.json())
      .then(d => setIcons(d.icons || []))
      .catch(() => {});
  }, []);

  const handleSave = useCallback(async () => {
    if (!label.trim()) { setError('Name cannot be empty.'); return; }
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`/api/blocks/${blockId}/customize`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: label.trim(), iconAsset: iconAsset || undefined }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error || 'Save failed.');
        return;
      }
      onSave({ label: label.trim(), iconAsset });
    } catch { setError('Network error.'); }
    finally { setSaving(false); }
  }, [blockId, label, iconAsset, onSave]);

  const handleReset = useCallback(async () => {
    setSaving(true);
    setError('');
    try {
      await fetch(`/api/blocks/${blockId}/customize`, { method: 'DELETE' });
      onSave(null); // null = reset to defaults
    } catch { setError('Reset failed.'); }
    finally { setSaving(false); }
  }, [blockId, onSave]);

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onKeyDown={e => e.key === 'Escape' && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Customize block"
        style={{ background: BG, border: `1px solid ${BORDER}`, borderRadius: 10, padding: '24px', width: 360, maxWidth: '90vw', boxShadow: `0 0 40px rgba(0,242,255,0.1)` }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <span style={{ fontSize: 13, fontWeight: 800, color: ACCENT, letterSpacing: '1px' }}>CUSTOMIZE BLOCK</span>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: MUTED, cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 2px' }} aria-label="Close">✕</button>
        </div>

        {/* Name */}
        <label style={{ display: 'block', marginBottom: 16 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: MUTED, letterSpacing: '1px', marginBottom: 6 }}>NAME</div>
          <input
            type="text"
            value={label}
            onChange={e => setLabel(e.target.value)}
            maxLength={40}
            autoFocus
            style={{
              width: '100%', boxSizing: 'border-box',
              background: 'rgba(255,255,255,0.04)', border: `1px solid ${BORDER}`,
              borderRadius: 6, padding: '8px 10px', color: '#e5e2e1',
              fontSize: 13, fontFamily: 'inherit', outline: 'none',
            }}
            onFocus={e => e.target.style.borderColor = ACCENT}
            onBlur={e => e.target.style.borderColor = BORDER}
          />
        </label>

        {/* Icon picker */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: MUTED, letterSpacing: '1px', marginBottom: 8 }}>ICON</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 6, maxHeight: 180, overflowY: 'auto', paddingRight: 2 }}>
            {icons.map(ic => {
              const active = iconAsset === ic.path;
              return (
                <button
                  key={ic.id}
                  title={ic.label}
                  onClick={() => setIconAsset(active ? '' : ic.path)}
                  style={{
                    background: active ? `rgba(0,242,255,0.12)` : 'rgba(255,255,255,0.03)',
                    border: active ? `1px solid ${ACCENT}` : `1px solid ${BORDER}`,
                    borderRadius: 6, padding: 6, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    transition: 'all 0.12s',
                    boxShadow: active ? `0 0 8px rgba(0,242,255,0.2)` : 'none',
                  }}
                  aria-pressed={active}
                >
                  <img src={ic.path} alt={ic.label} width={20} height={20}
                    style={{ filter: 'brightness(0.85) saturate(0.6)', display: 'block' }} />
                </button>
              );
            })}
          </div>
        </div>

        {error && (
          <div style={{ fontSize: 11, color: '#ff4466', marginBottom: 12, padding: '6px 10px', background: 'rgba(255,68,102,0.08)', borderRadius: 6, border: '1px solid rgba(255,68,102,0.2)' }}>
            {error}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <button
            onClick={handleReset}
            disabled={saving}
            style={{
              background: 'transparent', border: `1px solid rgba(255,255,255,0.1)`,
              color: MUTED, borderRadius: 6, padding: '7px 12px', fontSize: 11,
              cursor: saving ? 'wait' : 'pointer', fontFamily: 'inherit',
            }}
          >
            Reset to default
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              background: saving ? 'rgba(0,242,255,0.05)' : 'rgba(0,242,255,0.1)',
              border: `1px solid ${saving ? 'rgba(0,242,255,0.1)' : ACCENT}`,
              color: saving ? MUTED : ACCENT,
              borderRadius: 6, padding: '7px 20px', fontSize: 12, fontWeight: 700,
              cursor: saving ? 'wait' : 'pointer', fontFamily: 'inherit', letterSpacing: '0.5px',
              transition: 'all 0.15s',
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
