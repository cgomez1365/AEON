/**
 * Frontend block registry — nav item shape.
 *
 * Pins the root cause of the "every block shows the same name and icon" bug:
 * getNavGroups() built its items without `id`, so every consumer that keyed
 * per-block state off item.id read one shared undefined bucket. A sidebar row
 * MUST be able to identify which block it is.
 */
import { describe, expect, it } from 'vitest';
import {
  BLOCKS, GROUP_META, ICON_BASE, ICON_PNG_BASE,
  getNavGroups, getEffectiveBlockGroups,
} from '../src/kernel/blockRegistry.js';

const navItems = () => getNavGroups().flatMap(g => g.items);

describe('getNavGroups item identity', () => {
  it('gives every block-backed item a real id', () => {
    const items = navItems().filter(i => i.id !== null);
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) {
      expect(typeof i.id).toBe('string');
      expect(i.id).not.toBe('undefined');
      expect(i.id.length).toBeGreaterThan(0);
    }
  });

  it('never emits an item whose id is literally undefined', () => {
    // `customizations[undefined]` coerces to the string key "undefined" — the
    // exact mechanism that made one block's icon appear on all of them.
    for (const i of navItems()) expect(i.id).not.toBeUndefined();
  });

  it('ids are unique, so no two rows can share per-block state', () => {
    const ids = navItems().map(i => i.id).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('nav ids round-trip to real registry blocks', () => {
    const known = new Set(BLOCKS.map(b => b.id));
    for (const i of navItems()) {
      if (i.id === null) continue;
      expect(known.has(i.id)).toBe(true);
    }
  });

  it('carries the block-declared iconEditable flag through to the item', () => {
    for (const i of navItems()) expect(typeof i.iconEditable).toBe('boolean');
  });
});

describe('icon paths are derived, never per-block literals', () => {
  it('every block icon hangs off the single ICON_BASE constant', () => {
    for (const b of BLOCKS) {
      expect(b.iconAsset.startsWith(ICON_BASE)).toBe(true);
      expect(b.iconAssetPng.startsWith(ICON_PNG_BASE)).toBe(true);
    }
  });

  it('defaults derive from the folder name', () => {
    // A block with no manifest override lands on <ICON_BASE>/<folder>.svg.
    const derived = BLOCKS.filter(b => b.iconAsset === `${ICON_BASE}/${b.id}.svg`);
    expect(derived.length).toBeGreaterThan(0);
  });
});

describe('folder is the only source of a display name', () => {
  // LABEL_OVERRIDES let the kernel disagree with the UI: it said "Resume
  // Grader" while the frontend derived "ATS Engine" from the folder, and every
  // boot logged a [REGISTRY] mismatch. The map is gone; renaming a block means
  // renaming its folder. Kernel and frontend must now agree by construction.
  const ACRONYMS = { ats: 'ATS', ai: 'AI', os: 'OS', vp: 'VP', llm: 'LLM', api: 'API' };
  const labelFromFolder = folder => folder.split(/[_-]+/).filter(Boolean)
    .map(w => ACRONYMS[w.toLowerCase()] || w[0].toUpperCase() + w.slice(1))
    .join(' ');

  it('every block label is exactly its folder name, humanised', () => {
    for (const b of BLOCKS) expect(b.label).toBe(labelFromFolder(b.id));
  });

  it('no manifest declares a label that differs from the folder', () => {
    // A disagreement here is what produced the boot warning.
    for (const b of BLOCKS) {
      const declared = b.manifest?.nav?.label || b.manifest?.label;
      if (declared) expect(declared).toBe(labelFromFolder(b.id));
    }
  });

  it('the resume grader is named from its folder, not an override map', () => {
    const rg = BLOCKS.find(b => b.id === 'resume_grader');
    expect(rg).toBeDefined();
    expect(rg.label).toBe('Resume Grader');
    expect(BLOCKS.some(b => b.id === 'ats_engine')).toBe(false);
  });
});

describe('shipped section defaults survive a fresh clone', () => {
  // These live in GROUP_META (git-tracked), not aeon-settings.json (ignored),
  // so a reclone renders them the same way this install does.
  it('the finance section ships as Home', () => {
    expect(GROUP_META.finance.label).toBe('Home');
  });

  it('the agent section ships as Agents', () => {
    expect(GROUP_META.agent.label).toBe('Agents');
  });

  it('fleet_control ships in the Home section', () => {
    const home = getEffectiveBlockGroups(null).find(g => g.id === 'finance');
    expect(home.items.some(b => b.id === 'fleet_control')).toBe(true);
  });
});
