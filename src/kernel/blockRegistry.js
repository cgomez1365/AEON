/**
 * AEON Block Registry (frontend) — the cartridge reader.
 *
 * Auto-discovers every block under src/blocks/ via Vite's import.meta.glob:
 * its default-exported component AND its block.manifest.json. The console
 * (DesktopLayout) builds nav + routes from THIS — drop a folder with a
 * manifest + index.jsx and it appears, zero edits to the layout.
 */

import React from 'react';

// Manifests stay eager (tiny JSON — needed to build nav at boot).
// Components are LAZY: each block's code loads only when its route is
// visited. With 34 blocks, eager loading meant every block's full
// dependency tree parsed + executed on boot — the main cause of slow
// startup and high memory on low-RAM machines.
const componentModules = import.meta.glob('../blocks/*/index.jsx');
const manifestModules  = import.meta.glob('../blocks/*/block.manifest.json', { eager: true });

const GROUP_META = {
  finance:  { label: 'FINANCE',  icon: '⚡', order: 0 },
  agent:    { label: 'AGENT',    icon: '🤖', order: 1 },
  work:     { label: 'WORK',     icon: '💼', order: 2 },
  content:  { label: 'CONTENT',  icon: '🔍', order: 3 },
  tools:    { label: 'TOOLS',    icon: '🔧', order: 4 },
  system:   { label: 'SYSTEM',   icon: '📊', order: 5 },
  // Legacy groups — blocks not yet migrated still render
  command:  { label: 'COMMAND',      icon: '⚡', order: 6 },
  business: { label: 'BUSINESS',     icon: '💼', order: 7 },
  intel:    { label: 'INTELLIGENCE', icon: '🔍', order: 8 },
  ops:      { label: 'OPERATIONS',   icon: '📦', order: 9 },
};

function folderFromPath(p) {
  const m = p.match(/\.\.\/blocks\/([^/]+)\//);
  return m ? m[1] : null;
}

// ── Folder-is-truth naming (CEO rule, 2026-07-16) ──────────────────
// The displayed name is ALWAYS derived from the folder name. To rename a
// block, rename its folder. Manifest labels are ignored for display and a
// mismatch logs a warning so stale manifests get fixed.
const ACRONYMS = { ats: 'ATS', ai: 'AI', os: 'OS', vp: 'VP', llm: 'LLM', api: 'API' };
function labelFromFolder(folder) {
  return folder.split(/[_-]+/).filter(Boolean)
    .map(w => ACRONYMS[w.toLowerCase()] || w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

// Build the canonical block list.
const BLOCKS = [];
for (const [p, loader] of Object.entries(componentModules)) {
  const folder = folderFromPath(p);
  if (!folder || folder.startsWith('_')) continue; // _template etc. never register (K2)
  // Lazy component — code fetched on first render of the block's route.
  const Component = React.lazy(loader);

  const manifestPath = `../blocks/${folder}/block.manifest.json`;
  const manifest = (manifestModules[manifestPath] && (manifestModules[manifestPath].default || manifestModules[manifestPath])) || null;
  if (!manifest) { console.warn(`[REGISTRY] ${folder} has no manifest — skipped`); continue; }
  if (manifest.nav && manifest.nav.hidden) continue;

  const label = labelFromFolder(folder);
  const manifestLabel = (manifest.nav && manifest.nav.label) || manifest.label;
  if (manifestLabel && manifestLabel !== label) {
    console.warn(`[REGISTRY] ${folder}: manifest label "${manifestLabel}" ignored — folder is truth → "${label}"`);
  }

  BLOCKS.push({
    id: folder,
    route: manifest.route || `/${folder}`,
    label,
    icon: (manifest.nav && manifest.nav.icon) || manifest.icon || 'Boxes',
    iconAsset: (manifest.nav && manifest.nav.iconAsset) || `/brand/block-icons/${folder}.svg`,
    iconAssetPng: (manifest.nav && manifest.nav.iconAssetPng) || `/brand/block-icons/png/${folder}.png`,
    group: (manifest.nav && manifest.nav.group) || manifest.category || 'system',
    order: (manifest.nav && manifest.nav.order != null) ? manifest.nav.order : 99,
    uiMode: manifest.ui ?? 'full',
    Component,
    manifest,
  });
}

// Sort within group by order, then label.
BLOCKS.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));

// The operator's own reclassification/renames/custom sections — set via
// Settings (settings.blockLayout) from the Dashboard's Installed Blocks grid.
// Shared by getNavGroups (sidebar) AND the Dashboard, so dragging a block or
// renaming a section in one place is the SAME truth the other reads — no
// separate copy of "what group is this block in" to drift out of sync.
const UNSORTED_GROUP_ID = 'unsorted';

/**
 * Blocks grouped per manifest defaults, with the operator's overrides
 * applied on top: per-block group reassignment, custom sections, renamed/
 * hidden default sections. A hidden default section's blocks (present and
 * any future block sharing that manifest group) fall through to an
 * always-available Unsorted section instead of disappearing.
 */
export function getEffectiveBlockGroups(blockLayout) {
  const overrides = blockLayout?.overrides || {};
  const customGroups = blockLayout?.customGroups || {};
  const groupOverrides = blockLayout?.groupOverrides || {};

  const byGroup = {};
  for (const b of BLOCKS) {
    if (b.uiMode === 'headless') continue;
    if (!byGroup[b.group]) {
      const meta = GROUP_META[b.group] || { label: b.group.toUpperCase(), icon: '📦', order: 99 };
      const ov = groupOverrides[b.group];
      byGroup[b.group] = { id: b.group, meta: { ...meta, label: ov?.label || meta.label }, items: [], custom: false, hidden: !!ov?.hidden };
    }
  }
  for (const [gid, cg] of Object.entries(customGroups)) {
    if (byGroup[gid]) continue;
    const ov = groupOverrides[gid];
    byGroup[gid] = { id: gid, meta: { label: ov?.label || cg.label, icon: cg.icon || 'custom', order: cg.order ?? 50 }, items: [], custom: true, hidden: !!ov?.hidden };
  }
  byGroup[UNSORTED_GROUP_ID] = { id: UNSORTED_GROUP_ID, meta: { label: 'UNSORTED', icon: 'custom', order: 1000 }, items: [], custom: false, hidden: false, safetyNet: true };

  for (const b of BLOCKS) {
    if (b.uiMode === 'headless') continue;
    const overrideGroup = overrides[b.id];
    let targetId = (overrideGroup && byGroup[overrideGroup]) ? overrideGroup : b.group;
    if (byGroup[targetId]?.hidden) targetId = UNSORTED_GROUP_ID;
    byGroup[targetId].items.push(b);
  }

  return Object.values(byGroup)
    .filter(g => !g.hidden && (!g.safetyNet || g.items.length > 0))
    .sort((a, b) => (a.meta.order ?? 99) - (b.meta.order ?? 99));
}

/**
 * Nav groups, each with its ordered items — drives the sidebar. Pass the
 * current blockLayout (from Settings) so the sidebar reflects the same
 * reclassification/renames the Dashboard's block grid does.
 */
export function getNavGroups(extraItems = [], blockLayout = null) {
  const groups = getEffectiveBlockGroups(blockLayout);
  const out = groups.map(g => ({
    id: g.id,
    label: g.meta.label,
    icon: g.meta.icon,
    order: g.meta.order,
    items: g.items.map(b => ({
      path: b.route,
      label: b.label,
      icon: b.icon,
      iconAsset: b.iconAsset,
      iconAssetPng: b.iconAssetPng,
    })),
  }));
  // Inject non-block extras (e.g. Second Brain, a component not a block).
  for (const ex of extraItems) {
    const target = out.find(g => g.id === ex.group);
    if (target) {
      target.items.push({
        path: ex.path,
        label: ex.label,
        icon: ex.icon,
        iconAsset: ex.iconAsset,
        iconAssetPng: ex.iconAssetPng,
      });
      continue;
    }
    out.push({
      id: ex.group,
      label: GROUP_META[ex.group]?.label || ex.group.toUpperCase(),
      icon: GROUP_META[ex.group]?.icon || '📦',
      order: GROUP_META[ex.group]?.order ?? 99,
      items: [{
        path: ex.path,
        label: ex.label,
        icon: ex.icon,
        iconAsset: ex.iconAsset,
        iconAssetPng: ex.iconAssetPng,
      }],
    });
  }
  return out.sort((a, b) => a.order - b.order);
}

/** Route → Component list for <Routes>. Includes uiMode + manifest for BlockShell. */
export function getRoutes() {
  return BLOCKS.map(b => ({ path: b.route, Component: b.Component, id: b.id, uiMode: b.uiMode, manifest: b.manifest }));
}

/**
 * Slash commands declared by blocks in their manifest's contract.commands.
 * Each command: { cmd, desc, method, route, param, display } + owning block.
 * The Neural Terminal merges these with the kernel built-ins, so a block's
 * commands appear when it's installed and vanish when it's removed — same
 * manifest-as-truth model as nav and routes. No hardcoded command list.
 */
export function getCommands() {
  const out = [];
  for (const b of BLOCKS) {
    const cmds = (b.manifest.contract && b.manifest.contract.commands) || b.manifest.commands || [];
    for (const c of cmds) {
      if (!c || !c.cmd) continue;
      out.push({
        cmd: c.cmd,
        desc: c.desc || '',
        method: (c.method || 'POST').toUpperCase(),
        route: c.route || null,          // API path to call, e.g. /api/trading/start
        param: c.param || null,          // query/body key for the typed argument
        display: c.display || null,      // response field to render (answer|text|content|message)
        blockId: b.id,
        blockLabel: b.label,
      });
    }
  }
  return out.sort((a, b) => a.cmd.localeCompare(b.cmd));
}

/** Blocks with uiMode === 'headless' — exclude from nav and routes. */
export function getHeadlessBlocks() {
  return BLOCKS.filter(b => b.uiMode === 'headless');
}

export { BLOCKS, GROUP_META };
