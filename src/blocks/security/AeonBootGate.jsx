/**
 * AeonBootGate — the animated sign-in experience shown at the gate once an
 * operator turns on "Use the AEON boot sequence" in Protection settings.
 * Ported from a standalone visual prototype (AEON-Intro/index.html); the
 * canvas/motion code is unchanged, but the auth form now calls the REAL
 * kernel auth API instead of the prototype's placeholder handlers, and
 * theming reads AEON's actual live CSS variables instead of a separate
 * prefs-sync system (aurora.css already owns that).
 */
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { login as apiLogin, setToken } from '../../kernel/auth';
import RecoveryModal from './components/RecoveryModal.jsx';
import './AeonBootGate.css';

export default function AeonBootGate({ onAuthed }) {
  const canvasRef = useRef(null);
  const orbRefs = useRef([]);
  const [ready, setReady] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [form, setForm] = useState({ username: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [recoveryOpen, setRecoveryOpen] = useState(false);

  // ── Canvas motion — the orbital "boot" animation ──────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const root = document.documentElement;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const TAU = Math.PI * 2;

    let dpr = 1, w = 0, h = 0;
    let pointer = { x: 0, y: 0 };
    let palette = {};
    let start = performance.now();
    let revealed = false;
    let raf = 0;
    let parallaxRaf = 0;

    const css = (name, fallback) => getComputedStyle(root).getPropertyValue(name).trim() || fallback;
    const refreshPalette = () => {
      palette = {
        bg: css('--bg', '#07080d'),
        accent: css('--accent', '#00f2ff'),
        text: css('--text', '#dce8f5'),
      };
    };
    const alphaColor = (color, alpha) => {
      const hex = color.match(/^#([0-9a-f]{6})$/i);
      if (hex) {
        const n = parseInt(hex[1], 16);
        return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`;
      }
      const rgb = color.match(/rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)/i);
      return rgb ? `rgba(${rgb[1]},${rgb[2]},${rgb[3]},${alpha})` : color;
    };

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth; h = window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const ease = x => 1 - Math.pow(1 - Math.max(0, Math.min(1, x)), 3);
    const polar = (r, a) => ({ x: Math.cos(a) * r, y: Math.sin(a) * r });

    function strokePath(draw, width = 1, color = palette.accent, alpha = 1, glow = 0) {
      ctx.save(); ctx.beginPath(); draw();
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.globalAlpha = alpha;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      if (glow) { ctx.shadowColor = color; ctx.shadowBlur = glow; }
      ctx.stroke(); ctx.restore();
    }
    function arc(r, a0, a1, width, alpha = 1, glow = 0) {
      strokePath(() => ctx.arc(0, 0, r, a0, a1), width, palette.text, alpha, glow);
    }
    function node(r, a, size = 12, alpha = 1) {
      const p = polar(r, a);
      ctx.save(); ctx.globalAlpha = alpha; ctx.fillStyle = palette.bg;
      ctx.strokeStyle = palette.text; ctx.lineWidth = Math.max(1.5, size * .13);
      ctx.shadowColor = palette.accent; ctx.shadowBlur = size * .7;
      ctx.beginPath(); ctx.arc(p.x, p.y, size, 0, TAU); ctx.fill(); ctx.stroke(); ctx.restore();
    }
    function ringTicks(r, count, rot, alpha) {
      ctx.save(); ctx.rotate(rot);
      for (let i = 0; i < count; i++) {
        const a = i / count * TAU;
        const p1 = polar(r - 3, a), p2 = polar(r + 3, a);
        strokePath(() => { ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); }, 1, palette.accent, alpha);
      }
      ctx.restore();
    }
    function drawGrid() {
      ctx.save();
      const gx = pointer.x * 12, gy = pointer.y * 8, horizon = h * .045;
      ctx.translate(gx, gy); ctx.lineWidth = 1;
      const gap = 44;
      ctx.strokeStyle = alphaColor(palette.accent, .10);
      for (let x = -gap; x < w + gap; x += gap) {
        ctx.beginPath(); ctx.moveTo(x, horizon); ctx.lineTo(w / 2 + (x - w / 2) * 2.05, h); ctx.stroke();
      }
      const rows = 24;
      for (let i = 0; i <= rows; i++) {
        const depth = i / rows;
        const y = horizon + (h - horizon) * Math.pow(depth, 1.72);
        ctx.strokeStyle = alphaColor(palette.accent, .045 + depth * .075);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }
      ctx.restore();
      ctx.save();
      ctx.fillStyle = alphaColor(palette.accent, .23);
      for (let i = 0; i < 42; i++) {
        const x = (i * 173.3) % w, y = (i * 97.7) % h;
        ctx.fillRect(x + pointer.x * 5, y + pointer.y * 4, 1.2, 1.2);
      }
      ctx.restore();
    }
    function drawAxes(S, progress) {
      const R = S * .43;
      strokePath(() => {
        ctx.moveTo(-R, 0); ctx.lineTo(R, 0); ctx.moveTo(0, -R); ctx.lineTo(0, R);
      }, 1, palette.accent, .62 * progress, 5);
      for (let i = -12; i <= 12; i++) {
        const v = i * R / 12, l = i % 3 === 0 ? 6 : 3;
        strokePath(() => {
          ctx.moveTo(v, -l); ctx.lineTo(v, l); ctx.moveTo(-l, v); ctx.lineTo(l, v);
        }, 1, palette.text, .48 * progress);
      }
      for (const a of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
        const q = polar(R, a);
        ctx.save(); ctx.fillStyle = palette.text; ctx.shadowColor = palette.accent; ctx.shadowBlur = 9;
        ctx.globalAlpha = progress; ctx.beginPath(); ctx.arc(q.x, q.y, 2.2, 0, TAU); ctx.fill(); ctx.restore();
      }
    }
    function drawAeonMark(S, progress) {
      const outerApexY = -S * .120, innerApexY = -S * .041, baseY = S * .121;
      const outerBaseX = S * .119, innerBaseX = S * .081;
      strokePath(() => {
        ctx.moveTo(0, outerApexY);
        ctx.lineTo(outerBaseX, baseY); ctx.lineTo(innerBaseX, baseY);
        ctx.lineTo(0, innerApexY);
        ctx.lineTo(-innerBaseX, baseY); ctx.lineTo(-outerBaseX, baseY);
        ctx.closePath();
      }, 2.25, palette.accent, .74 * progress, 7);
    }
    function outerSystem(S, railAngle, planetAngle, progress) {
      const r = S * .335;
      ctx.save(); ctx.rotate(railAngle);
      const spans = [[-2.95, -1.63], [-1.50, -1.12], [-.78, -.12], [.08, .72], [.90, 1.48], [1.63, 2.93]];
      for (const [a, b] of spans) arc(r, a, a + (b - a) * progress, S * .017, .94, 14);
      ctx.restore();
      ctx.save(); ctx.rotate(planetAngle);
      node(r, Math.PI, S * .034, progress); node(r, -.82, S * .031, progress); node(r, .90, S * .031, progress);
      ctx.restore();
    }
    function middleSystem(S, angle, progress) {
      ctx.save(); ctx.rotate(angle);
      const r = S * .245;
      strokePath(() => ctx.arc(0, 0, r, 0, TAU), 1.2, palette.accent, .42 * progress, 2);
      ctx.setLineDash([3, 7]);
      strokePath(() => ctx.arc(0, 0, r * .9, 0, TAU), 1, palette.text, .42 * progress);
      ctx.setLineDash([]);
      for (const [a, b] of [[-2.85, -1.8], [-1.52, -.35], [.05, 1.25], [1.58, 2.75]]) arc(r * .73, a, a + (b - a) * progress, 2, .78, 6);
      node(r * .73, Math.PI, S * .017, progress); node(r * .73, -.64, S * .022, progress); node(r * .73, .92, S * .022, progress);
      ringTicks(r, 24, -angle, .2 * progress);
      ctx.restore();
    }
    function innerSystem(S, angle, progress) {
      ctx.save(); ctx.rotate(angle);
      const r = S * .142;
      for (const [a, b] of [[-2.9, -1.72], [-1.43, -.18], [.12, 1.30], [1.62, 2.78]]) arc(r, a, a + (b - a) * progress, 1.7, .86, 5);
      arc(r * .78, -2.8, -2.8 + 4.7 * progress, 1.2, .55, 3);
      ctx.save(); ctx.rotate(-angle); drawAeonMark(S, progress); ctx.restore();
      ctx.restore();
    }
    function satellites(S, t, progress) {
      for (const [r, speed, phase, size] of [[S * .39, .18, .5, 3.8], [S * .29, -.26, 2.2, 3], [S * .20, .34, 4.5, 2.4], [S * .34, -.13, 5.2, 2.5]]) {
        const q = polar(r, t * speed + phase);
        ctx.save(); ctx.globalAlpha = progress; ctx.fillStyle = palette.text;
        ctx.shadowColor = palette.accent; ctx.shadowBlur = 13;
        ctx.beginPath(); ctx.arc(q.x, q.y, size, 0, TAU); ctx.fill(); ctx.restore();
      }
    }
    function pulse(S, t, progress) {
      const cycle = (t % 3.8) / 3.8;
      const r = S * (.05 + cycle * .20);
      ctx.save(); ctx.globalAlpha = (1 - cycle) * .34 * progress; ctx.strokeStyle = palette.accent;
      ctx.lineWidth = 1; ctx.shadowColor = palette.accent; ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.stroke(); ctx.restore();
      ctx.save(); ctx.fillStyle = palette.text; ctx.shadowColor = palette.accent; ctx.shadowBlur = 18;
      ctx.globalAlpha = .95 * progress;
      ctx.beginPath(); ctx.arc(0, 0, 3.5 + Math.sin(t * 2) * .6, 0, TAU); ctx.fill(); ctx.restore();
    }

    function frame(now) {
      const t = (now - start) / 1000;
      const build = reduced ? 1 : ease(t / 3.9);
      const S = Math.min(w, h) * .78;
      const cx = w / 2 + pointer.x * 6, cy = h * .46 + pointer.y * 5;
      ctx.clearRect(0, 0, w, h);
      const aura = ctx.createRadialGradient(cx, cy, 0, cx, cy, S * .68);
      aura.addColorStop(0, alphaColor(palette.accent, .09));
      aura.addColorStop(.50, alphaColor(palette.accent, .025));
      aura.addColorStop(1, alphaColor(palette.bg, 0));
      ctx.fillStyle = aura; ctx.fillRect(0, 0, w, h);
      drawGrid();
      ctx.save(); ctx.translate(cx, cy);
      drawAxes(S, ease(t / 2.3));
      outerSystem(S, reduced ? 0 : t * .032, reduced ? 0 : t * .055, ease((t - .75) / 2.6));
      middleSystem(S, reduced ? 0 : -t * .12, ease((t - .45) / 2.3));
      innerSystem(S, reduced ? 0 : t * .18, ease((t - .22) / 2.0));
      satellites(S, t, ease((t - 1.45) / 1.45));
      pulse(S, t, build);
      ctx.restore();
      if (!revealed && t > 3.75) { revealed = true; setReady(true); }
      raf = requestAnimationFrame(frame);
    }

    const onResize = () => resize();
    const onMove = (e) => {
      pointer.x = e.clientX / Math.max(w, 1) - .5;
      pointer.y = e.clientY / Math.max(h, 1) - .5;
      if (!parallaxRaf) {
        parallaxRaf = requestAnimationFrame(() => {
          parallaxRaf = 0;
          if (reduced) return;
          for (const orb of orbRefs.current) {
            if (!orb) continue;
            const depth = Number(orb.dataset.depth) || 14;
            orb.style.transform = `translate3d(${pointer.x * depth}px, ${pointer.y * depth}px, 0)`;
          }
        });
      }
    };

    resize();
    refreshPalette();
    window.addEventListener('resize', onResize);
    window.addEventListener('pointermove', onMove);
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      if (parallaxRaf) cancelAnimationFrame(parallaxRaf);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pointermove', onMove);
    };
  }, []);

  const openAuth = useCallback(() => {
    setAuthOpen(true);
    setTimeout(() => document.getElementById('aeon-boot-identity')?.focus(), 450);
  }, []);
  const closeAuth = useCallback(() => setAuthOpen(false), []);

  const handleSubmit = useCallback(async (e) => {
    e.preventDefault();
    setBusy(true); setMessage('');
    try {
      const result = await apiLogin(form.username.trim(), form.password);
      if (!result.ok) throw new Error(result.error || 'Username or password was not accepted.');
      onAuthed && onAuthed();
    } catch (err) {
      setMessage(err?.message || 'Sign-in failed.');
      setBusy(false);
    }
  }, [form, onAuthed]);

  const completeRecovery = useCallback((token) => {
    setToken(token);
    setRecoveryOpen(false);
    onAuthed && onAuthed();
  }, [onAuthed]);

  const emergencyLogin = useCallback(async (username, passphrase) => {
    const result = await apiLogin(username, passphrase);
    if (!result.ok) throw new Error(result.error || 'Temporary passphrase was not accepted.');
    setRecoveryOpen(false);
    onAuthed && onAuthed();
  }, [onAuthed]);

  return (
    <div className="aeon-boot">
      <div className="aeon-boot-aurora" aria-hidden="true">
        <div ref={el => (orbRefs.current[0] = el)} className="aeon-boot-orb aeon-boot-orb--cyan" data-depth="14" />
        <div ref={el => (orbRefs.current[1] = el)} className="aeon-boot-orb aeon-boot-orb--violet" data-depth="26" />
        <div ref={el => (orbRefs.current[2] = el)} className="aeon-boot-orb aeon-boot-orb--emerald" data-depth="40" />
      </div>
      <canvas
        ref={canvasRef} className="aeon-boot-canvas" tabIndex={0} role="button"
        aria-label="Animated AEON orbital system. Activate to sign in."
        onClick={() => ready && openAuth()}
        onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && ready) { e.preventDefault(); openAuth(); } }}
      />
      <div className={`aeon-boot-copy${ready ? ' ready' : ''}`}>
        <img src="/brand/aeon-mark/aeon-icon-64.png" alt="" width="48" height="48" />
        <div className="aeon-boot-brand">AEON</div>
        <div className="aeon-boot-tag">Modular. Local. Yours.</div>
        <button type="button" className="aeon-boot-enter" onClick={openAuth}>Initialize connection</button>
      </div>

      <div className={`aeon-boot-auth${authOpen ? ' open' : ''}`} aria-hidden={!authOpen}>
        <form className="aeon-boot-panel" onSubmit={handleSubmit}>
          <button type="button" className="aeon-boot-close" aria-label="Close" onClick={closeAuth}>&times;</button>
          <h1>Connect to AEON</h1>
          <p className="aeon-boot-sub">Your second brain is ready.</p>
          <label className="aeon-boot-field-label" htmlFor="aeon-boot-identity">Username</label>
          <input id="aeon-boot-identity" className="aeon-boot-field" autoComplete="username" required
            value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} />
          <label className="aeon-boot-field-label" htmlFor="aeon-boot-password">Password</label>
          <input id="aeon-boot-password" className="aeon-boot-field" type="password" autoComplete="current-password" required
            value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} />
          <button className="aeon-boot-submit" type="submit" disabled={busy || !form.username || !form.password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          {message && <div className="aeon-boot-message" role="alert">{message}</div>}
          <p className="aeon-boot-fine">
            <button type="button" className="aeon-boot-link" onClick={() => setRecoveryOpen(true)}>
              Forgot password?
            </button>
          </p>
        </form>
      </div>
      <RecoveryModal
        open={recoveryOpen}
        initialUsername={form.username}
        onClose={() => setRecoveryOpen(false)}
        onRecovered={completeRecovery}
        onEmergencyLogin={emergencyLogin}
      />
    </div>
  );
}
