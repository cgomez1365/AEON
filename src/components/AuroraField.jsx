/**
 * AuroraField — living glow layer behind every block.
 * Three GPU-composited orbs (transform-only animation):
 *   · every navigation re-rolls position, hue, scale, and opacity, so the
 *     light never settles into the same corner twice
 *   · pointer parallax at three depths gives the glass real dimension
 * Mount as the first child of .main-viewport. Pointer-events: none.
 */
import React, { useEffect, useMemo, useRef } from 'react';
import { useLocation } from 'react-router-dom';

// Base hues per orb: cyan, violet, emerald — each roll wanders ±45°
const ORBS = [
  { hue: 187, depth: 14, size: '58vmax' },
  { hue: 265, depth: 26, size: '52vmax' },
  { hue: 152, depth: 40, size: '44vmax' },
];

const rnd = (min, max) => min + Math.random() * (max - min);

// One position roll: each orb lands in a different screen third so the
// light spreads instead of pooling in one corner.
function rollField() {
  const lanes = [0, 1, 2].sort(() => Math.random() - 0.5);
  return ORBS.map((orb, i) => ({
    x: lanes[i] * 33 + rnd(-8, 24),        // % of viewport width
    y: rnd(-15, 75),                        // % of viewport height
    hue: orb.hue + rnd(-45, 45),
    scale: rnd(0.75, 1.3),
    alpha: rnd(0.10, 0.20),
  }));
}

export default function AuroraField() {
  const location = useLocation();
  const field = useMemo(rollField, [location.pathname]);
  const parallaxRefs = useRef([]);
  const reduceMotion = useMemo(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches, []
  );

  // Pointer parallax — rAF-throttled, transform-only, skipped for reduced motion
  useEffect(() => {
    if (reduceMotion) return;
    let raf = 0;
    const onMove = (e) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const nx = e.clientX / window.innerWidth - 0.5;   // -0.5 … 0.5
        const ny = e.clientY / window.innerHeight - 0.5;
        parallaxRefs.current.forEach((el, i) => {
          if (!el) return;
          const d = ORBS[i].depth;
          el.style.transform = `translate3d(${(-nx * d).toFixed(1)}px, ${(-ny * d).toFixed(1)}px, 0)`;
        });
      });
    };
    window.addEventListener('pointermove', onMove);
    return () => { window.removeEventListener('pointermove', onMove); if (raf) cancelAnimationFrame(raf); };
  }, [reduceMotion]);

  return (
    <div aria-hidden style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', zIndex: 0 }}>
      {field.map((o, i) => (
        /* outer = parallax (no transition) · inner = nav drift (slow transition) */
        <div key={i} ref={el => { parallaxRefs.current[i] = el; }} style={{ position: 'absolute', inset: 0, willChange: 'transform' }}>
          <div style={{
            position: 'absolute',
            width: ORBS[i].size, height: ORBS[i].size,
            left: `${o.x}%`, top: `${o.y}%`,
            transform: `translate(-50%, -50%) scale(${o.scale})`,
            background: `radial-gradient(circle, hsla(${o.hue}, 100%, 58%, ${o.alpha}) 0%, transparent 65%)`,
            transition: reduceMotion ? 'none' : 'left 1.6s cubic-bezier(0.22,1,0.36,1), top 1.6s cubic-bezier(0.22,1,0.36,1), transform 1.6s cubic-bezier(0.22,1,0.36,1), background 1.6s ease',
            willChange: 'left, top, transform',
          }} />
        </div>
      ))}
    </div>
  );
}
