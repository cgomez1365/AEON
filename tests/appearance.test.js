/**
 * Appearance — the gate for "a setting that saves must also apply".
 *
 * Settings → Appearance shipped four controls of which two worked. Theme and
 * sidebar width were written to prefs and read by nothing, so choosing
 * "amoled" saved "amoled", showed a success toast, and changed no pixel —
 * before OR after a restart, because the boot path was missing them too.
 *
 * The defect was structural: applying lived in two hand-written copies (the
 * panel's save handler and App.jsx's boot path) and neither was authoritative,
 * so a control added to one had to be remembered in the other. This suite
 * pins the survivor, not merely the absence — per the deletion protocol's
 * step 4, it asserts each control DOES something, which is the assertion that
 * would have failed on the shipped code.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The applier touches exactly three DOM methods. Stubbing them tests the real
// module rather than a reimplementation of it, and needs no jsdom dependency.
function installFakeDom() {
  const props = new Map();
  const attrs = new Map();
  globalThis.document = {
    documentElement: {
      style: { setProperty: (k, v) => props.set(k, v) },
      setAttribute: (k, v) => attrs.set(k, v),
      removeAttribute: (k) => attrs.delete(k),
    },
  };
  return { props, attrs };
}

let dom;
beforeEach(() => { dom = installFakeDom(); });

const load = () => import('../src/kernel/appearance.js');

describe('appearance — every control changes something', () => {
  it('theme writes data-theme, and "dark" is the absence of an override', async () => {
    const { applyAppearance } = await load();

    applyAppearance({ theme: 'amoled' });
    expect(dom.attrs.get('data-theme')).toBe('amoled');

    applyAppearance({ theme: 'midnight' });
    expect(dom.attrs.get('data-theme')).toBe('midnight');

    // "dark" is the base :root palette. Stamping [data-theme="dark"] would
    // require restating every token and become a second copy to keep in sync.
    applyAppearance({ theme: 'dark' });
    expect(dom.attrs.has('data-theme')).toBe(false);
  });

  it('sidebar width writes data-sidebar, and "normal" is the absence of one', async () => {
    const { applyAppearance } = await load();

    applyAppearance({ sidebarWidth: 'wide' });
    expect(dom.attrs.get('data-sidebar')).toBe('wide');

    applyAppearance({ sidebarWidth: 'compact' });
    expect(dom.attrs.get('data-sidebar')).toBe('compact');

    applyAppearance({ sidebarWidth: 'normal' });
    expect(dom.attrs.has('data-sidebar')).toBe(false);
  });

  it('accent sets the accent token and its derived shades', async () => {
    const { applyAppearance } = await load();
    applyAppearance({ accent: '#00f2ff' });
    expect(dom.props.get('--accent')).toBe('#00f2ff');
    expect(dom.props.get('--accent-dim')).toBe('rgba(0, 242, 255, 0.1)');
    expect(dom.props.get('--accent-glow')).toBe('rgba(0, 242, 255, 0.32)');
  });

  it('font size sets a root font-size', async () => {
    const { applyAppearance } = await load();
    applyAppearance({ fontSize: 15 });
    expect(dom.props.get('font-size')).toBe('15px');
  });

  it('a partial save leaves the other settings alone', async () => {
    // The panel writes one key at a time. An applier that reset absent fields
    // to defaults would clear the operator's theme every time they nudged the
    // font-size slider.
    const { applyAppearance } = await load();
    applyAppearance({ theme: 'amoled' });
    applyAppearance({ fontSize: 14 });
    expect(dom.attrs.get('data-theme')).toBe('amoled');
  });

  it('rejects a theme or width it does not define, rather than stamping it', async () => {
    const { applyAppearance } = await load();
    applyAppearance({ theme: 'solarized', sidebarWidth: 'enormous' });
    expect(dom.attrs.has('data-theme')).toBe(false);
    expect(dom.attrs.has('data-sidebar')).toBe(false);
  });
});

describe('theme builder — font, density and frosted apply', () => {
  it('maps the font choice to a stack that actually resolves', async () => {
    const { applyThemeBuilder } = await load();

    // "inter" was interpolated raw into the CSS value, producing
    // `inter, <fallback>` — a family nobody had loaded.
    applyThemeBuilder({ font: 'inter' });
    expect(dom.props.get('--font-body')).toMatch(/'Inter'/);

    applyThemeBuilder({ font: 'monospace' });
    expect(dom.props.get('--font-body')).toMatch(/JetBrains Mono|monospace/);

    applyThemeBuilder({ font: 'serif' });
    expect(dom.props.get('--font-body')).toMatch(/Georgia|serif/);
  });

  it('density sets the spacing multiplier', async () => {
    const { applyThemeBuilder } = await load();
    applyThemeBuilder({ density: 'compact' });
    expect(Number(dom.props.get('--density-scale'))).toBeLessThan(1);
    applyThemeBuilder({ density: 'spacious' });
    expect(Number(dom.props.get('--density-scale'))).toBeGreaterThan(1);
    applyThemeBuilder({ density: 'comfortable' });
    expect(Number(dom.props.get('--density-scale'))).toBe(1);
  });

  it('frosted applies in BOTH directions', async () => {
    // The original inline version only handled the "on" branch, so turning
    // frosting off saved the preference and left the blur running.
    const { applyThemeBuilder } = await load();
    applyThemeBuilder({ frosted: false });
    expect(dom.attrs.get('data-frosted')).toBe('off');
    applyThemeBuilder({ frosted: true });
    expect(dom.attrs.has('data-frosted')).toBe(false);
  });

  it('frosting never sets --glass inline, which would outrank every theme', async () => {
    // Found by the settings tracer. An inline custom property beats EVERY
    // stylesheet rule regardless of specificity or source order, so setting
    // --glass here permanently overrode the amoled theme's own blur value:
    // once the operator touched this toggle in either direction, switching to
    // amoled silently kept the old blur forever. An attribute participates in
    // the normal cascade instead.
    const { applyThemeBuilder } = await load();
    applyThemeBuilder({ frosted: false });
    expect(dom.props.has('--glass'), '--glass must not be set inline').toBe(false);
    applyThemeBuilder({ frosted: true });
    expect(dom.props.has('--glass'), '--glass must not be set inline').toBe(false);
  });
});

describe('hexWithAlpha — the string-concat bug', () => {
  it('handles 3-digit hex, which naive concatenation corrupted', async () => {
    const { hexWithAlpha } = await load();
    // `'#fff' + '1a'` produced '#fff1a': not a color, so the browser dropped
    // the declaration and the dim accent silently kept its previous value.
    expect(hexWithAlpha('#fff', 0.1)).toBe('rgba(255, 255, 255, 0.1)');
  });

  it('handles 6-digit hex', async () => {
    const { hexWithAlpha } = await load();
    expect(hexWithAlpha('#7b2fff', 0.32)).toBe('rgba(123, 47, 255, 0.32)');
  });

  it('returns a non-hex color untouched rather than corrupting it', async () => {
    const { hexWithAlpha } = await load();
    expect(hexWithAlpha('rebeccapurple', 0.1)).toBe('rebeccapurple');
  });
});

describe('the CSS defines what the applier stamps', () => {
  // The applier writing data-theme="amoled" is worthless if no rule matches
  // it. This is the half that was missing: the attribute had no stylesheet
  // behind it, which is exactly how the control "worked" and did nothing.
  const css = fs.readFileSync(path.join(ROOT, 'src', 'aurora.css'), 'utf8');

  it('has a rule for every theme the applier accepts', () => {
    expect(css).toMatch(/:root\[data-theme="midnight"\]/);
    expect(css).toMatch(/:root\[data-theme="amoled"\]/);
  });

  it('has a rule for every non-default sidebar width', () => {
    expect(css).toMatch(/:root\[data-sidebar="compact"\]/);
    expect(css).toMatch(/:root\[data-sidebar="wide"\]/);
  });

  it('the sidebar grid actually consumes --sidebar-w', () => {
    expect(css).toMatch(/\.command-center\.with-sidebar\s*\{[^}]*var\(--sidebar-w/);
  });

  it('the spacing scale actually consumes --density-scale', () => {
    expect(css).toMatch(/--sp-4:\s*calc\([^)]*var\(--density-scale\)/);
  });

  it('the frosted-off rule exists and is declared AFTER the theme blocks', () => {
    // Source order decides at equal specificity, so a frosted-off rule placed
    // before the themes would lose to amoled's own --glass.
    const frosted = css.indexOf(':root[data-frosted="off"]');
    const amoled = css.indexOf(':root[data-theme="amoled"]');
    expect(frosted, 'frosted-off rule missing').toBeGreaterThan(-1);
    expect(frosted, 'frosted-off must come after the theme blocks').toBeGreaterThan(amoled);
  });

  it('every font the builder offers is loaded or generic', () => {
    // Inter is a webfont and must be imported; the rest are generic families.
    expect(css).toMatch(/fonts\.googleapis\.com[^'"]*Inter/);
  });
});
