/**
 * The aurora StatCard renders `icon` directly as a child, so it takes an
 * ELEMENT. Two other components in this codebase — activity's local StatCard
 * and fleet_control's StatusCard — destructure `{ icon: Icon }` and render
 * `<Icon />`, so they take a COMPONENT. Same prop name, opposite contracts.
 *
 * On 2026-08-10 the Master rewrite passed the bare lucide component to the
 * aurora one. React received a forwardRef object ({$$typeof, render,
 * displayName}), threw minified error #31, and the whole page died behind the
 * runtime-error screen. `npm run build` compiled it without complaint: JSX
 * cannot tell a component from an element at build time, and nothing in the
 * suite renders a block UI.
 *
 * This closes the specific class cheaply. It is NOT a substitute for rendering
 * the page — see the note at the bottom.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.name.endsWith('.jsx')) acc.push(full);
  }
  return acc;
}

const IMPORTS_AURORA = /from\s+['"][^'"]*components\/aurora['"]/;
// icon={Something} — a bare capitalised identifier, i.e. a component.
const BARE_COMPONENT_ICON = /icon=\{([A-Z][A-Za-z0-9_]*)\}/g;

describe('aurora StatCard takes an element, not a component', () => {
  it('no file using aurora passes a bare component as icon', () => {
    const offenders = [];
    for (const file of walk(path.join(ROOT, 'src'))) {
      const src = fs.readFileSync(file, 'utf8');
      if (!IMPORTS_AURORA.test(src)) continue;      // only the aurora contract
      if (!/\bStatCard\b/.test(src)) continue;
      for (const m of src.matchAll(BARE_COMPONENT_ICON)) {
        offenders.push(`${path.relative(ROOT, file)} → icon={${m[1]}} should be icon={<${m[1]} />}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the aurora StatCard really does render icon as a child', () => {
    // If this ever changes to <Icon />, the rule above is wrong and should go
    // — a guard that outlives its reason becomes folklore.
    const aurora = fs.readFileSync(path.join(ROOT, 'src/components/aurora/index.jsx'), 'utf8');
    expect(aurora).toMatch(/\{icon\s*&&\s*<span[^>]*>\{icon\}<\/span>\}/);
  });

  it('blocks with their OWN icon-as-component cards are left alone', () => {
    // activity and fleet_control destructure { icon: Icon } and render <Icon/>.
    // They are correct, and this test must not "fix" working code.
    const activity = fs.readFileSync(path.join(ROOT, 'src/blocks/activity/index.jsx'), 'utf8');
    expect(activity).toMatch(/function StatCard\(\{\s*icon:\s*Icon/);
    expect(activity).not.toMatch(IMPORTS_AURORA);
  });
});

/**
 * WHAT THIS DOES NOT COVER, stated rather than implied (§08):
 *
 * Nothing in this suite renders a block UI. This catches one prop contract by
 * pattern-matching source text; it would not catch a null dereference in a
 * component body, a bad hook order, or the next prop mismatch of a different
 * shape. The honest fix is a jsdom smoke render of every block's default
 * export, which is a real piece of work and is recorded as open rather than
 * pretended away here.
 */
