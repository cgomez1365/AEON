/**
 * Every setting type a manifest declares must have a real control.
 *
 * BlockSettingControl handled 'toggle', 'select' and 'number', and sent
 * everything else to a plain text input as its fallback. Six settings across
 * three blocks declare `"type": "boolean"` — the other spelling — so all six
 * rendered as text boxes.
 *
 * That is not a cosmetic mismatch. The value saved was a STRING, and the
 * consumers test truthiness: guardian.cjs does `if (!p.lockEveryLaunch)`.
 * Because Boolean("false") is true, an operator typing "false" into the box
 * to turn OFF "Ask for password every time AEON opens" would have turned it
 * ON. A security control that inverts under a plausible input is the worst
 * shape this class of defect can take.
 *
 * This gate fails if a manifest ever declares a type the renderer does not
 * explicitly handle — which is what let the mismatch go unnoticed.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BLOCKS = path.join(ROOT, 'src', 'blocks');
const PANEL = fs.readFileSync(path.join(BLOCKS, 'settings', 'index.jsx'), 'utf8');

/** Every type BlockSettingControl branches on explicitly. */
function handledTypes() {
  const fn = PANEL.slice(PANEL.indexOf('function BlockSettingControl'));
  const body = fn.slice(0, fn.indexOf('\nfunction '));
  const types = new Set();
  for (const m of body.matchAll(/def\.type === '([a-z]+)'/g)) types.add(m[1]);
  return types;
}

/** Every {block, key, type} declared in contract.settings across all blocks. */
function declaredSettings() {
  const out = [];
  for (const dir of fs.readdirSync(BLOCKS)) {
    const mf = path.join(BLOCKS, dir, 'block.manifest.json');
    if (!fs.existsSync(mf)) continue;
    let m;
    try { m = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch { continue; }
    for (const s of m?.contract?.settings || []) {
      if (s && s.key && s.type) out.push({ block: m.id, key: s.key, type: s.type, label: s.label });
    }
  }
  return out;
}

describe('block settings — every declared type has a control', () => {
  const handled = handledTypes();
  const declared = declaredSettings();

  it('the panel actually branches on some types (guard against a broken parse)', () => {
    expect(handled.size).toBeGreaterThan(2);
    expect(declared.length).toBeGreaterThan(0);
  });

  it('no manifest declares a type the renderer silently drops to a text box', () => {
    // 'text' and 'secret' are the intended fallback, so they are fine.
    const intendedFallback = new Set(['text', 'secret']);
    const unhandled = declared.filter(
      s => !handled.has(s.type) && !intendedFallback.has(s.type)
    );
    expect(
      unhandled,
      'These settings render as a plain text input because BlockSettingControl '
      + 'has no branch for their type. A boolean saved as a string is truthy '
      + 'even when it reads "false":\n'
      + unhandled.map(s => `  ${s.block}.${s.key} (type: ${s.type}) — ${s.label || ''}`).join('\n')
    ).toEqual([]);
  });

  it('boolean is handled, since three blocks use that spelling', () => {
    // Named explicitly: this is the exact spelling that was missing.
    expect(handled.has('boolean'), "BlockSettingControl must branch on 'boolean'").toBe(true);
  });

  it('a boolean control coerces a stringy stored value rather than trusting it', () => {
    // A store written by the old text input can still hold "false". Reading
    // that as ON would silently re-enable whatever the operator turned off.
    const fn = PANEL.slice(PANEL.indexOf('function BlockSettingControl'));
    const body = fn.slice(0, fn.indexOf('\nfunction '));
    expect(body).toMatch(/current === 'true'/);
  });
});
