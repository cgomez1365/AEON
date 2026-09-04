/**
 * Appearance — the single place that turns a saved preference into a visible
 * change.
 *
 * Settings → Appearance offered four controls and only two of them did
 * anything: accent and font size were live-applied inline in the panel's
 * save(), while theme and sidebar width were written to prefs and read by
 * nothing at all. Choosing "amoled" saved "amoled" and showed a success
 * toast, and the app looked exactly the same.
 *
 * The root cause is structural rather than a missing branch. Applying lived
 * in two places — App.jsx's boot path and the settings panel's save handler —
 * and neither was the authority, so a control added to the panel had to be
 * remembered in a file the panel's author was not editing. Whichever half was
 * forgotten failed silently, because a preference that is saved but never
 * read looks identical to one that is working until you restart.
 *
 * So there is one applier, it is exhaustive over the preference object, and
 * both callers use it. Adding a control means adding it here once.
 */

/** Sidebar widths are named, not numeric — the CSS owns the actual values. */
const SIDEBAR_WIDTHS = ['compact', 'normal', 'wide'];
const THEMES = ['dark', 'midnight', 'amoled'];

const root = () => document.documentElement;

/**
 * Apply an appearance preference object to the live DOM.
 *
 * Every field is optional; anything absent is left alone rather than reset to
 * a default, so a partial save (the panel writes one key at a time) never
 * clears the others.
 *
 * @param {{theme?: string, accent?: string, fontSize?: number, sidebarWidth?: string}} a
 */
export function applyAppearance(a) {
  if (!a || typeof a !== 'object') return;
  const el = root();

  // Theme drives a data attribute, not a set of inline custom properties.
  // The palette then lives in CSS where the rest of the design system is,
  // and switching themes cannot leave half the old one behind — which is
  // what setting tokens individually from JS would risk every time the
  // palette gains a token.
  if (a.theme && THEMES.includes(a.theme)) {
    // "dark" is the base :root palette, so it is the ABSENCE of an override
    // rather than an override of its own.
    if (a.theme === 'dark') el.removeAttribute('data-theme');
    else el.setAttribute('data-theme', a.theme);
  }

  if (a.accent) {
    el.style.setProperty('--accent', a.accent);
    el.style.setProperty('--accent-dim', hexWithAlpha(a.accent, 0.1));
    el.style.setProperty('--accent-glow', hexWithAlpha(a.accent, 0.32));
    el.style.setProperty('--border-hi', hexWithAlpha(a.accent, 0.28));
  }

  if (a.fontSize) el.style.setProperty('font-size', `${a.fontSize}px`);

  if (a.sidebarWidth && SIDEBAR_WIDTHS.includes(a.sidebarWidth)) {
    // "normal" is the default width in :root, same reasoning as "dark".
    if (a.sidebarWidth === 'normal') el.removeAttribute('data-sidebar');
    else el.setAttribute('data-sidebar', a.sidebarWidth);
  }
}

/**
 * Theme Builder's deep palette. Applied BEFORE appearance so the simple
 * accent pick in Appearance always wins over whatever the builder last saved
 * — the ordering the previous boot path established and callers rely on.
 */
export function applyThemeBuilder(t) {
  if (!t || typeof t !== 'object') return;
  const el = root();
  const set = (k, v) => el.style.setProperty(k, v);

  if (t.colors) {
    if (t.colors.background) set('--bg', t.colors.background);
    if (t.colors.text) set('--text', t.colors.text);
    if (t.colors.panel) set('--bg-card', t.colors.panel);
    if (t.colors.border) set('--border', hexWithAlpha(t.colors.border, 0.25));
    if (t.colors.accent) {
      set('--accent', t.colors.accent);
      set('--accent-dim', hexWithAlpha(t.colors.accent, 0.1));
    }
  }

  // Font and density were saved by the Theme Builder and never applied —
  // the same defect as theme and sidebar width, in the same panel.
  if (t.font && FONT_STACKS[t.font]) set('--font-body', FONT_STACKS[t.font]);
  if (t.density && DENSITY_SCALE[t.density] != null) {
    set('--density-scale', String(DENSITY_SCALE[t.density]));
  }
  if (typeof t.frosted === 'boolean') {
    // Frosted off means no backdrop blur anywhere. The blur is expensive on
    // low-end GPUs, which is the reason the toggle exists — and the inline
    // version this replaces only ever acted in the "on" direction, so
    // turning frosting OFF saved the preference and left the blur running
    // until the next restart.
    set('--glass', t.frosted ? 'blur(18px) saturate(160%)' : 'none');
  }
}

const SYSTEM_SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`;

/**
 * The panel's four font options, resolved to stacks that actually exist.
 *
 * The value was previously interpolated straight into the CSS, so "inter"
 * became `inter, <fallback>` — a family nobody had loaded — and the choice
 * silently did nothing. Inter is now imported alongside the other webfonts
 * in aurora.css; the remaining three resolve to real generic families.
 */
const FONT_STACKS = {
  inter: `'Inter', ${SYSTEM_SANS}`,
  'sans-serif': SYSTEM_SANS,
  serif: `Georgia, Cambria, 'Times New Roman', Times, serif`,
  monospace: `'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Courier New', monospace`,
};

/**
 * Multiplies the spacing scale. Comfortable is the shipped default.
 *
 * Kept deliberately gentle. The scale reaches the design-system tokens but
 * not the inline pixel values most blocks still use, so a large multiplier
 * would pull token-based surfaces away from their neighbours and read as a
 * layout bug rather than a density setting.
 */
const DENSITY_SCALE = { compact: 0.85, comfortable: 1, spacious: 1.15 };

/**
 * Append an alpha channel to a color the operator picked.
 *
 * The old inline code did `accent + '1a'`, which is only correct for a
 * 6-digit hex: given `#fff` it produced `#fff1a` — not a color, so the
 * browser dropped the declaration and the dim accent silently kept its
 * previous value. Any non-hex input (a named color, an rgb() string) had the
 * same problem.
 */
export function hexWithAlpha(color, alpha) {
  const c = String(color).trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(c);
  const full = /^#([0-9a-f]{6})$/i.exec(c);
  let hex = null;
  if (full) hex = full[1];
  else if (short) hex = `${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;

  if (!hex) return c; // not a hex color — hand it back untouched rather than corrupt it
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Boot path: read both prefs and apply them in the order that makes
 * Appearance win over Theme Builder.
 */
export async function loadAndApplyAppearance() {
  const get = async (key) => {
    try {
      const r = await fetch(`/api/prefs/${key}`);
      return (await r.json())?.value;
    } catch { return null; }
  };
  applyThemeBuilder(await get('theme_builder'));
  applyAppearance(await get('appearance'));
}
