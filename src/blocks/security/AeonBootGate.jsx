/**
 * AeonBootGate — the animated sign-in experience shown at the gate once an
 * operator turns on "Use the AEON boot sequence" in Protection settings.
 *
 * The canvas draws the REAL mark: the geometry of
 * public/brand/aeon-mark/aeon-mark.svg, in its own 512-unit box, on the
 * animated README banner's loop. The drawing code below is ported from the
 * operator-approved design (aeon-boot-mark.html) frame for frame — the mark,
 * the twelve instrument layers, the outward data stream and the soft halo
 * under every line. What did NOT come across: the design's opaque ground and
 * its canvas aurora, because this gate already renders three .aeon-boot-orb
 * elements with pointer parallax behind the canvas and drawing the aurora
 * twice would double it. The canvas therefore clears to transparent and the
 * DOM owns the ground.
 *
 * Two things are computed differently from the design: the still half of the
 * mark is pre-rendered and blitted rather than re-blurred sixty times a
 * second, and the stream's per-particle constants and paints are built once
 * instead of per frame. Both are argued where they sit. Neither changes a
 * number, an order or a blend — what they cost is rounding, and it was
 * measured rather than asserted: against the design's own code, over both
 * themes, three viewports and four phases, composited on an opaque ground, no
 * channel moves by more than 4/255 and fewer than one subpixel in 4,000 moves
 * by more than 1/255. That is the price of an 8-bit buffer, and it buys a
 * third of the frame's blur budget back.
 *
 * The auth form calls the REAL kernel auth API, and theming reads AEON's live
 * CSS variables (aurora.css owns those) rather than a palette of its own —
 * live meaning live: the canvas re-reads them when they change, not only when
 * the window resizes.
 */
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { login as apiLogin, setToken } from '../../kernel/auth';
import RecoveryModal from './components/RecoveryModal.jsx';
import './AeonBootGate.css';

const TAU = Math.PI * 2;
const RAD = Math.PI / 180;

/**
 * The loop length of the animated README banner. Every layer completes whole
 * turns inside it — the outer ring +90 degrees, the three nodes -360 — so the
 * loop is seamless. Motion is driven from p = (elapsed % LOOP) / LOOP and
 * nothing else, which is why this gate and the banner stay in step.
 */
const LOOP = 12.67;

/** The mark, in its own 512-unit box (public/brand/aeon-mark/aeon-mark.svg). */
const MARK = {
  ringR: 205, ringW: 14, dash: [257.61, 64.40], ringRot: -36,
  nodeR: 218, nodeSize: 24, nodeW: 10, nodeAng: [315, 45, 180],
  innerR: 118, innerW: 9,
  chev: [[183, 328], [256, 192], [329, 328], [307, 328], [256, 233], [205, 328]],
};

/** The same six-vertex chevron as SVG, cropped to itself, for the lockup. */
const CHEVRON_D = 'M183 328 L256 192 L329 328 L307 328 L256 233 L205 328 Z';
const CHEVRON_BOX = '183 192 146 136';

/**
 * The mark keeps its own colours; only the instruments take the accent.
 * On a dark ground every line blooms in its OWN colour.
 */
const MARK_DARK = {
  ring: '#bcd8ff', node: '#eaf3ff', inner: '#7fb2ff', chev: '#ffffff',
  halo: null, haloK: 1, add: true,
  dust: ['255,255,255', '220,235,255', '170,205,255', '127,178,255'],
  mote: null, gridA: 0.05,
};
/**
 * On a light ground, the banner's substitutions and ONE soft blue halo at
 * three-quarter strength: a bloom has nothing to bloom against on white.
 */
const MARK_LIGHT = {
  ring: '#2f6fd6', node: '#2f6fd6', inner: '#5b8fe0', chev: '#0b1a3a',
  halo: 'rgba(47,111,214,.55)', haloK: .75, add: false,
  dust: ['0,140,255', '0,190,255', '31,79,168', '11,42,120'],
  mote: '#1f4fa8', gridA: 0.07,
};

// ── Colour plumbing — the gate reads live CSS variables ─────────────────────
function rgbParts(color, fallback) {
  const hex = String(color).match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const s = hex[1].length === 3 ? hex[1].split('').map(c => c + c).join('') : hex[1];
    const n = parseInt(s, 16);
    return [n >> 16, (n >> 8) & 255, n & 255];
  }
  const rgb = String(color).match(/rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)/i);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : fallback;
}
const rgbTriplet = (color, fallback) => rgbParts(color, null)?.join(',') || fallback;
const alphaColor = (color, alpha) => {
  const p = rgbParts(color, null);
  return p ? `rgba(${p[0]},${p[1]},${p[2]},${alpha})` : color;
};
/** 0 (black) .. 1 (white). Decides which treatment the mark gets. */
const luminance = (color) => {
  const [r, g, b] = rgbParts(color, [7, 8, 13]);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};

// ── The approved drawing code ───────────────────────────────────────────────
function hash(i) { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }
function halo(ctx, T, colour, blur) { ctx.shadowColor = T.halo || colour; ctx.shadowBlur = blur * T.haloK; }
function clearGlow(ctx) { ctx.shadowBlur = 0; }
function hud(T, a) { return 'rgba(' + T.hud + ',' + a + ')'; }

/** The design's ground(), minus the opaque fill and the aurora — see the header. */
function grid(ctx, w, h, k, T) {
  ctx.strokeStyle = T.grid; ctx.lineWidth = 1;
  const step = 52 * k;
  let x, y;
  for (x = -Math.ceil(w / 2 / step) * step; x < w / 2; x += step) {
    ctx.beginPath(); ctx.moveTo(x, -h / 2); ctx.lineTo(x, h / 2); ctx.stroke();
  }
  for (y = -Math.ceil(h / 2 / step) * step; y < h / 2; y += step) {
    ctx.beginPath(); ctx.moveTo(-w / 2, y); ctx.lineTo(w / 2, y); ctx.stroke();
  }
}

/**
 * Every constant a stream particle has is a pure function of its index, so the
 * table is built once. Recomputing it inside the loop cost 1,219 hash() calls
 * (a Math.sin and a Math.floor each) and 460 trig calls per frame — 100,740 a
 * second — for numbers that never changed. Only the phase does.
 */
const STREAM_N = 230;
const DUST = (() => {
  const ca = new Float64Array(STREAM_N), sa = new Float64Array(STREAM_N);
  const size = new Float64Array(STREAM_N), alpha = new Float64Array(STREAM_N);
  const pick = new Float64Array(STREAM_N), streak = new Float64Array(STREAM_N);
  const isStreak = new Uint8Array(STREAM_N);
  for (let i = 0; i < STREAM_N; i++) {
    const ang = hash(i) * TAU;
    ca[i] = Math.cos(ang); sa[i] = Math.sin(ang);
    size[i] = 0.6 + hash(i + 51) * 1.7;
    alpha[i] = 0.20 + hash(i + 7) * 0.55;
    pick[i] = hash(i + 333);
    isStreak[i] = hash(i + 17) < 0.30 ? 1 : 0;
    streak[i] = 4 + hash(i + 5) * 16;
  }
  return { ca, sa, size, alpha, pick, streak, isStreak };
})();

/**
 * The particle paints, built once per theme instead of 230 gradients and 690
 * colour strings per frame. The halo was a positional gradient only because
 * position, radius and alpha were baked into it; a unit-radius gradient placed
 * by the transform and faded by globalAlpha is the same premultiplied source,
 * under 'lighter' as well as source-over. Dropping the old toFixed(3) on the
 * alpha makes it slightly more exact, not less; measured against the design's
 * own code the whole substitution moves no channel by more than 2/255.
 */
function dustPaints(ctx, T) {
  T.dustGrad = T.dust.map((col) => {
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, 'rgba(' + col + ',1)');
    g.addColorStop(1, 'rgba(' + col + ',0)');
    return g;
  });
  T.dustSolid = T.dust.map((col) => 'rgb(' + col + ')');
}

/** The data stream: OUT of the core, three crossings per loop. */
function stream(ctx, w, h, k, p, T) {
  const N = STREAM_N, rStart = 22 * k, rEnd = Math.max(w, h) * 0.64;
  if (!T.dustGrad) dustPaints(ctx, T);
  ctx.save();
  if (T.add) ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < N; i++) {
    const ph = ((i / N) + p * 3) % 1;
    const r = rStart + Math.pow(ph, 0.78) * (rEnd - rStart);
    const ca = DUST.ca[i], sa = DUST.sa[i];
    const x = ca * r, y = sa * r * 0.82;
    const size = DUST.size[i] * k;
    const a = Math.sin(ph * Math.PI) * DUST.alpha[i] * (T.add ? 0.95 : 0.72);
    const c = (DUST.pick[i] * T.dust.length) | 0;

    const wide = size * 3;
    ctx.globalAlpha = a * 0.30;
    ctx.fillStyle = T.dustGrad[c];
    ctx.save();
    ctx.translate(x, y); ctx.scale(wide, wide);
    ctx.beginPath(); ctx.arc(0, 0, 1, 0, TAU); ctx.fill();
    ctx.restore();

    ctx.globalAlpha = a;
    if (DUST.isStreak[i]) {
      const len = size * DUST.streak[i] * (0.3 + ph);
      ctx.strokeStyle = T.dustSolid[c]; ctx.lineWidth = size * 0.9;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - ca * len, y - sa * len * 0.82);
      ctx.stroke();
    } else {
      ctx.fillStyle = T.dustSolid[c];
      ctx.beginPath(); ctx.arc(x, y, size, 0, TAU); ctx.fill();
    }
  }
  ctx.restore();
}

/** Twelve instrument layers, in the accent only. */
function instruments(ctx, k, p, T, level) {
  let a, i, r0, r1;

  ctx.save(); ctx.rotate(p * Math.PI);
  ctx.strokeStyle = hud(T, .24); ctx.lineWidth = 1;
  for (i = 0; i < 48; i++) {
    a = i * 7.5 * RAD; r0 = 250 * k; r1 = r0 + (i % 4 === 0 ? 10 * k : 5 * k);
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
    ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
    ctx.stroke();
  }
  ctx.restore();

  ctx.save(); ctx.rotate(-p * TAU);
  ctx.strokeStyle = hud(T, .34); ctx.lineWidth = 1;
  ctx.setLineDash([3, 8]);
  ctx.beginPath(); ctx.arc(0, 0, 152 * k, 0, TAU); ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  const turns = [1, -2, 3, -1], radii = [316, 268, 196, 244], sizes = [3.2, 2.6, 2.1, 2.4];

  if (level >= 2) {
    ctx.strokeStyle = hud(T, .13); ctx.lineWidth = 1;
    ctx.setLineDash([1, 9]);
    for (i = 0; i < radii.length; i++) {
      ctx.beginPath(); ctx.arc(0, 0, radii[i] * k, 0, TAU); ctx.stroke();
    }
    ctx.setLineDash([]);

    const d = (330 + Math.sin(p * TAU) * 6) * k, arm = 34 * k;
    ctx.strokeStyle = hud(T, .42); ctx.lineWidth = 1.5;
    for (i = 0; i < 4; i++) {
      const sx = (i === 0 || i === 3) ? -1 : 1;
      const sy = (i < 2) ? -1 : 1;
      ctx.beginPath();
      ctx.moveTo(sx * d, sy * d - sy * arm);
      ctx.lineTo(sx * d, sy * d);
      ctx.lineTo(sx * d - sx * arm, sy * d);
      ctx.stroke();
    }

    ctx.strokeStyle = hud(T, .5); ctx.lineWidth = 1.6;
    for (i = 0; i < 4; i++) {
      a = i * 90 * RAD;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 262 * k, Math.sin(a) * 262 * k);
      ctx.lineTo(Math.cos(a) * 278 * k, Math.sin(a) * 278 * k);
      ctx.stroke();
    }

    ctx.save(); ctx.rotate(-p * TAU / 4);
    halo(ctx, T, hud(T, 1), 8 * k);
    ctx.strokeStyle = hud(T, .58); ctx.lineWidth = 1.4;
    for (i = 0; i < 4; i++) {
      a = (45 + i * 90) * RAD;
      const cx = Math.cos(a) * 292 * k, cy = Math.sin(a) * 292 * k, s = 7 * k;
      ctx.beginPath(); ctx.arc(cx, cy, s, 0, TAU); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - s * .8, cy + s * .8); ctx.lineTo(cx + s * .8, cy - s * .8); ctx.stroke();
    }
    clearGlow(ctx); ctx.restore();

    ctx.save(); ctx.rotate(p * TAU);
    for (i = 0; i < 26; i++) {
      ctx.strokeStyle = hud(T, (0.17 * (1 - i / 26)).toFixed(3));
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, 232 * k, -i * .018 - .02, -i * .018, true); ctx.stroke();
    }
    ctx.restore();
  }

  if (level >= 3) {
    for (i = 0; i < MARK.nodeAng.length; i++) {
      const deg = ((MARK.nodeAng[i] - p * 360 + 90) % 360 + 360) % 360;
      const frac = deg / 360;
      if (frac < .18) {
        const g2 = frac / .18;
        a = (MARK.nodeAng[i] - p * 360) * RAD;
        ctx.strokeStyle = hud(T, ((1 - g2) * .45).toFixed(3));
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(Math.cos(a) * MARK.nodeR * k, Math.sin(a) * MARK.nodeR * k,
                MARK.nodeSize * k + g2 * 36 * k, 0, TAU);
        ctx.stroke();
      }
    }

    ctx.strokeStyle = hud(T, .45); ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.arc(0, 0, 176 * k, -Math.PI / 2, -Math.PI / 2 + p * TAU); ctx.stroke();
    a = -Math.PI / 2 + p * TAU;
    halo(ctx, T, hud(T, 1), 10 * k);
    ctx.fillStyle = hud(T, .9);
    ctx.beginPath(); ctx.arc(Math.cos(a) * 176 * k, Math.sin(a) * 176 * k, 2.6 * k, 0, TAU); ctx.fill();
    clearGlow(ctx);

    ctx.strokeStyle = hud(T, .2); ctx.lineWidth = 1;
    for (i = 0; i < 72; i++) {
      a = i * 5 * RAD; r0 = 104 * k; r1 = r0 + (i % 6 === 0 ? 7 * k : 3.5 * k);
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
      ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
      ctx.stroke();
    }
  }

  halo(ctx, T, hud(T, 1), 12 * k);
  for (i = 0; i < 4; i++) {
    a = (p * turns[i] * TAU) + i * 1.7;
    ctx.fillStyle = T.mote; ctx.globalAlpha = .9;
    ctx.beginPath();
    ctx.arc(Math.cos(a) * radii[i] * k, Math.sin(a) * radii[i] * k, sizes[i] * k, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1; clearGlow(ctx);

  const cyc = (p * 4) % 1;
  ctx.strokeStyle = hud(T, ((1 - cyc) * .30).toFixed(3));
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(0, 0, (60 + cyc * 250) * k, 0, TAU); ctx.stroke();
}

// ── The mark, with a soft halo under every line ─────────────────────────────
function chevronPath(ctx, k) {
  ctx.beginPath();
  for (let i = 0; i < MARK.chev.length; i++) {
    const x = (MARK.chev[i][0] - 256) * k, y = (MARK.chev[i][1] - 256) * k;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/** A wide half-strength pass under a crisp pass. */
function softStroke(ctx, T, k, colour, width, draw) {
  ctx.strokeStyle = colour; ctx.lineWidth = width;
  ctx.globalAlpha = .55; halo(ctx, T, colour, 34 * k);
  draw(); ctx.stroke();
  ctx.globalAlpha = 1; halo(ctx, T, colour, 9 * k);
  draw(); ctx.stroke();
  clearGlow(ctx);
}

/**
 * The still half of the mark: the inner ring and the chevron, which take no
 * clock and read none. Kept apart from theMark() for one reason — four of the
 * frame's twenty-five shadow-blurred passes live here, the two widest among
 * them, and every frame redrew them to a byte-identical result.
 */
function markStill(ctx, k, T) {
  softStroke(ctx, T, k, T.inner, MARK.innerW * k, function () {
    ctx.beginPath(); ctx.arc(0, 0, MARK.innerR * k, 0, TAU);
  });

  // Solid, as the logo draws it: white on dark, ink on light.
  ctx.globalAlpha = .5; halo(ctx, T, T.chev, 30 * k);
  ctx.fillStyle = T.chev; chevronPath(ctx, k); ctx.fill();
  ctx.globalAlpha = 1; halo(ctx, T, T.chev, 10 * k);
  chevronPath(ctx, k); ctx.fill();
  clearGlow(ctx);
}

/**
 * markStill(), pre-rendered into its own buffer.
 *
 * This is safe to cache and nothing else on the canvas is, because the still
 * half is drawn LAST: no reordering is involved, and source-over is
 * associative, so a group composited into a transparent buffer and then laid
 * down lands exactly where the same draws in the same order would have. The
 * buffer is pinned to a whole device pixel and carries the centre's sub-pixel
 * remainder inside itself, so nothing is resampled and no edge shifts; what
 * the round trip does cost is one extra premultiplied 8-bit rounding, measured
 * at no more than 4/255 on any channel and mostly at 1.
 *
 * STILL_R is in the mark's own 512-units: the inner ring's outer edge
 * (118 + 9/2) plus the wide pass's halo, a Gaussian of sigma 34/2 that is
 * spent by three sigma = 51. 210 leaves another one and a half sigma of margin
 * so nothing of the bloom is clipped.
 */
const STILL_R = 210;

function buildStill(w, h, dpr, k, cyFrac, T) {
  const cxDev = w / 2 * dpr, cyDev = h * cyFrac * dpr;
  const half = Math.ceil(STILL_R * k * dpr) + 1;
  if (!(half > 0) || !Number.isFinite(cxDev) || !Number.isFinite(cyDev)) return null;
  const buf = document.createElement('canvas');
  buf.width = half * 2; buf.height = half * 2;
  const g = buf.getContext('2d');
  if (!g) return null;
  const ox = Math.round(cxDev) - half, oy = Math.round(cyDev) - half;
  g.translate(cxDev - ox, cyDev - oy);
  g.scale(dpr, dpr);
  markStill(g, k, T);
  return { buf, ox, oy };
}

function blitStill(ctx, still) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(still.buf, still.ox, still.oy);
  ctx.restore();
}

function theMark(ctx, k, p, T, still) {
  let a, i;
  // Outer segmented ring: +90 degrees per loop.
  ctx.save();
  ctx.rotate((MARK.ringRot + p * 90) * RAD);
  ctx.setLineDash([MARK.dash[0] * k, MARK.dash[1] * k]);
  softStroke(ctx, T, k, T.ring, MARK.ringW * k, function () {
    ctx.beginPath(); ctx.arc(0, 0, MARK.ringR * k, 0, TAU);
  });
  ctx.setLineDash([]);
  ctx.restore();

  // The three nodes: -360 degrees per loop, one whole turn the other way.
  for (i = 0; i < MARK.nodeAng.length; i++) {
    a = (MARK.nodeAng[i] - p * 360) * RAD;
    ((ang) => {
      softStroke(ctx, T, k, T.node, MARK.nodeW * k, function () {
        ctx.beginPath();
        ctx.arc(Math.cos(ang) * MARK.nodeR * k, Math.sin(ang) * MARK.nodeR * k, MARK.nodeSize * k, 0, TAU);
      });
    })(a);
  }

  // Inner ring and chevron: STILL, so a prepared layer may stand in for them.
  if (still) blitStill(ctx, still); else markStill(ctx, k, T);
}

/**
 * `fill` and `cy` are composition, not geometry: k scales the mark's own
 * 512-unit box and every number above is expressed in it, so the proportions
 * are the file's whichever value k takes. The design draws into a 16:9 figure
 * with nothing else in it and fills it (0.86, centred). This gate's canvas is
 * the whole viewport with a copy block along the bottom edge, and at 0.86 the
 * outer ring's lower node lands under the lockup. So the mark is sized to the
 * room above the copy and sits a little high in the frame, which is where the
 * gate has always put it.
 */
const GATE_FILL = 0.62, GATE_CY = 0.44;
const markScale = (w, h, fill) => Math.min(w, h) / 512 * (fill ?? 0.86);

function drawFinal(ctx, w, h, t, opts) {
  const T = opts.theme;
  const k = markScale(w, h, opts.fill);
  const p = (t % LOOP) / LOOP;
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.translate(w / 2, h * (opts.cy ?? 0.5));
  grid(ctx, w, h, k, T);
  if (opts.stream) stream(ctx, w, h, k, p, T);
  if (opts.level > 0) instruments(ctx, k, p, T, opts.level);
  theMark(ctx, k, p, T, opts.still);
  ctx.restore();
}

/**
 * The banner's lockup: the mark's own chevron standing in for the A, then EON.
 * The SVG is aria-hidden and the wrapper carries the name, so a screen reader
 * hears one word — "AEON" — and not a graphic followed by three letters.
 */
function AeonLockup({ className = '' }) {
  return (
    <span className={`aeon-lockup${className ? ` ${className}` : ''}`} role="img" aria-label="AEON">
      <svg className="aeon-lockup-chevron" viewBox={CHEVRON_BOX} aria-hidden="true" focusable="false">
        <path d={CHEVRON_D} fill="currentColor" />
      </svg>
      <span className="aeon-lockup-word">EON</span>
    </span>
  );
}

export default function AeonBootGate({ onAuthed }) {
  const canvasRef = useRef(null);
  const orbRefs = useRef([]);
  const [ready, setReady] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [form, setForm] = useState({ username: '', password: '', code: '' });
  const [requires2FA, setRequires2FA] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [recoveryOpen, setRecoveryOpen] = useState(false);

  // ── Canvas motion — the mark on the banner's loop ─────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const root = document.documentElement;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

    let w = 0, h = 0, dpr = 1;
    let theme = null, themeSig = '';
    let still = null, stillDirty = true;
    const pointer = { x: 0, y: 0 };
    const start = performance.now();
    let revealed = false;
    let lastT = 0;
    let raf = 0;
    let parallaxRaf = 0;

    /**
     * True when the palette actually moved. documentElement is watched for any
     * attribute change below and most of those are not theme changes, so the
     * still layer is only thrown away when a colour really did shift.
     */
    const readTheme = () => {
      const style = getComputedStyle(root);
      const css = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
      const bg = css('--bg', '#07080d');
      const accent = css('--accent', '#00f2ff');
      const text = css('--text', '#dce8f5');
      const sig = `${bg}|${accent}|${text}`;
      if (theme && sig === themeSig) return false;
      themeSig = sig;
      const base = luminance(bg) > .5 ? MARK_LIGHT : MARK_DARK;
      theme = {
        ...base,
        hud: rgbTriplet(accent, '0,242,255'),
        mote: base.mote || text,
        grid: alphaColor(accent, base.gridA),
      };
      stillDirty = true;
      return true;
    };

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth; h = window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      stillDirty = true;
    };

    const paint = (t) => {
      lastT = t;
      if (stillDirty) {
        stillDirty = false;
        still = theme ? buildStill(w, h, dpr, markScale(w, h, GATE_FILL), GATE_CY, theme) : null;
      }
      drawFinal(ctx, w, h, t, { level: 3, stream: true, fill: GATE_FILL, cy: GATE_CY, theme, still });
    };

    function frame(now) {
      const t = (now - start) / 1000;
      paint(t);
      if (!revealed && t > 3.75) { revealed = true; setReady(true); }
      raf = requestAnimationFrame(frame);
    }

    const onResize = () => {
      resize(); readTheme();
      if (reduced) paint(lastT);
    };
    /**
     * The gate is precisely the screen a theme change lands on, and none of the
     * ways it lands involve a resize: the operator picks a new accent in
     * Settings > Appearance, aurora.css swaps its tokens, or the OS flips
     * light/dark. Re-reading only on resize left the canvas drawing the old
     * palette indefinitely while the CSS orbs behind it recoloured at once —
     * and in the reduced-motion branch there is no rAF loop to repaint it, so
     * the still frame is redrawn here by hand.
     */
    const onThemeChange = () => {
      if (readTheme() && reduced) paint(lastT);
    };
    const scheme = matchMedia('(prefers-color-scheme: dark)');
    const themeWatch = new MutationObserver(onThemeChange);
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
    readTheme();
    window.addEventListener('resize', onResize);
    window.addEventListener('pointermove', onMove);
    scheme.addEventListener('change', onThemeChange);
    themeWatch.observe(root, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });

    if (reduced) {
      // One static frame, no rAF loop. At p = 0 every layer is where the SVG
      // draws it, so the still IS the mark.
      paint(0);
      setReady(true);
    } else {
      raf = requestAnimationFrame(frame);
    }

    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (parallaxRaf) cancelAnimationFrame(parallaxRaf);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pointermove', onMove);
      scheme.removeEventListener('change', onThemeChange);
      themeWatch.disconnect();
      still = null; // the pre-rendered buffer is the largest thing here; drop it
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
      const result = await apiLogin(form.username.trim(), form.password, form.code);
      if (result.requires2FA) {
        setRequires2FA(true);
        setMessage('Enter the 6-digit code from your authenticator app.');
        setBusy(false);
        return;
      }
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
        aria-label="Animated AEON mark. Activate to sign in."
        onClick={() => ready && openAuth()}
        onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && ready) { e.preventDefault(); openAuth(); } }}
      />
      <div className={`aeon-boot-copy${ready ? ' ready' : ''}`}>
        <AeonLockup className="aeon-boot-brand" />
        <div className="aeon-boot-tag">Modular. Local. Yours.</div>
        <button type="button" className="aeon-boot-enter" onClick={openAuth}>Initialize connection</button>
      </div>

      <div className={`aeon-boot-auth${authOpen ? ' open' : ''}`} aria-hidden={!authOpen}>
        <form className="aeon-boot-panel" onSubmit={handleSubmit}>
          <button type="button" className="aeon-boot-close" aria-label="Close" onClick={closeAuth}>&times;</button>
          <AeonLockup className="aeon-boot-panel-lockup" />
          <h1>Connect to AEON</h1>
          <p className="aeon-boot-sub">Your second brain is ready.</p>
          <label className="aeon-boot-field-label" htmlFor="aeon-boot-identity">Username</label>
          <input id="aeon-boot-identity" className="aeon-boot-field" autoComplete="username" required
            value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} />
          <label className="aeon-boot-field-label" htmlFor="aeon-boot-password">Password</label>
          <input id="aeon-boot-password" className="aeon-boot-field" type="password" autoComplete="current-password" required
            value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} />
          {requires2FA && (
            <>
              <label className="aeon-boot-field-label" htmlFor="aeon-boot-code">Two-factor code</label>
              <input id="aeon-boot-code" className="aeon-boot-field" inputMode="numeric" maxLength={8}
                placeholder="6-digit code (or a backup code)" autoFocus
                value={form.code} onChange={e => setForm(f => ({ ...f, code: e.target.value }))} />
            </>
          )}
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
