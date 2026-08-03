/**
 * AEON Block Standard — the cartridge contract.
 *
 * One source of truth (block.manifest.json) + the machinery that lets AEON
 * (the console) read any block (cartridge) dropped into src/blocks/ and wire
 * it up automatically: normalize its manifest, derive its env requirements,
 * check readiness against the live system, and flash a fresh runtime config
 * into the block so it can talk to AEON's kernel/models/auth.
 *
 * Used both by a one-time CLI (scripts) and by server.cjs on every boot.
 */
const fs = require('fs');
const path = require('path');

const BLOCKS_DIR = path.join(__dirname, '..', 'blocks');

// ── Icon asset base paths — one declaration, every consumer derives ────
// Mirror of ICON_BASE in blockRegistry.js (ESM/CJS boundary prevents a shared
// import). ICON_DIR is the on-disk location the icon library is scanned from.
const ICON_BASE     = '/brand/block-icons';
const ICON_PNG_BASE = `${ICON_BASE}/png`;
const ICON_DIR      = path.join(__dirname, '..', '..', 'public', 'brand', 'block-icons');

// ── Provider → env var(s) that prove the connection exists ───────────
const API_ENV = {
  groq:     ['GROQ_API_KEY'],
  gemini:   ['GEMINI_FREE_KEY_1', 'GEMINI_PAID_KEY'],   // any one
  openai:   ['OPENAI_API_KEY'],
  claude:   ['ANTHROPIC_API_KEY'],
  supabase: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'], // all
  firebase: ['VITE_FIREBASE_PROJECT_ID'],
  gas:      ['VITE_GAS_URL'],
  youtube:  ['YOUTUBE_REFRESH_TOKEN'],
  coinbase: ['__FILE__cdp_api_key.json'],                // desktop file, not env
  canva:    ['CANVA_API_KEY'],
};
// Providers requiring ALL listed vars (vs any-one).
const API_ENV_ALL = new Set(['supabase']);

// Label overrides used to live here. Deleted 2026-07-29: the frontend registry
// never read them, so the kernel said "Resume Grader" while the UI said "ATS
// Engine" and every boot logged a [REGISTRY] mismatch warning. Folder is the
// only source of a display name — to rename a block, rename its folder.

// ── Kernel nav defaults — synced INTO each block's manifest on boot ──
// The kernel owns sidebar layout. Blocks not listed here still load (system
// group, order 99). A block's manifest.nav is always overwritten from this
// map during syncAllBlocks — this IS manifest-as-truth: the kernel writes
// the manifest, the frontend reads the manifest, nobody else declares nav.
// Labels are NOT declared here — folder is truth (CEO rule, 2026-07-16):
// the displayed name always derives from the folder name via labelFromFolder.
// This map only owns layout: route, group, order, icon. Pruned to installed
// blocks; an unlisted block still loads (system group, order 99).
const NAV = {
  // FINANCE — everything that makes or tracks money
  dashboard:     { route: '/',           group: 'finance', order: 0, icon: 'CircleGauge' },
  // AGENT — VP and everything that watches or staffs it
  fleet_control: { route: '/fleet',      group: 'finance', order: 1, icon: 'Radio' },
  // WORK — client-facing operations
  resume_grader: { route: '/resume-grader', group: 'work', order: 0, icon: 'Users' },
  // CONTENT — knowledge and creation
  cookbook:      { route: '/cookbook',   group: 'content', order: 1, icon: 'BookOpen' },
  deep_research: { route: '/research',   group: 'content', order: 2, icon: 'FlaskConical' },
  orion_search:  { route: '/orion',      group: 'content', order: 3, icon: 'Telescope' },
  aeon_matrix:   { route: '/brain',      group: 'content', order: 4, icon: 'Workflow' },
  files:         { route: '/files',      group: 'content', order: 5, icon: 'Folder' },
  portfolio:     { route: '/portfolio',  group: 'content', order: 6, icon: 'FileText' },
  // TOOLS — utilities
  host_os:       { route: '/host',       group: 'tools',   order: 0, icon: 'Monitor' },
  council:       { route: '/council',    group: 'tools',   order: 1, icon: 'Landmark' },
  quick_links:   { route: '/links',      group: 'tools',   order: 2, icon: 'Link' },
  // SYSTEM — the OS itself
  settings:      { route: '/settings',   group: 'system',  order: 0, icon: 'Settings' },
  activity:      { route: '/activity',   group: 'system',  order: 1, icon: 'Activity' },
  master:        { route: '/master',     group: 'system',  order: 2, icon: 'Cpu' },
};

const ICON_FALLBACKS = {
  activity: 'Activity',
  aeon_matrix: 'Workflow',
  cookbook: 'BookOpen',
  council: 'Landmark',
  dashboard: 'CircleGauge',
  deep_research: 'FlaskConical',
  files: 'Folder',
  fleet_control: 'Radio',
  host_os: 'Monitor',
  master: 'Cpu',
  memory_core: 'Workflow',
  orion_search: 'Telescope',
  quick_links: 'Link',
  resume_grader: 'Users',
  security: 'Shield',
  settings: 'Settings',
  writer: 'PenLine',
};

// Installed blocks are explicit about where their durable output belongs.
// "compatibility" keeps the existing APIs alive while those blocks are migrated
// one at a time; staged and newly created blocks must use "scoped".
const MEMORY_POLICY = {
  activity: 'none', aeon_matrix: 'document', cookbook: 'none',
  council: 'document', dashboard: 'none', deep_research: 'summary', files: 'summary',
  fleet_control: 'none', host_os: 'summary', master: 'none', memory_core: 'document',
  orion_search: 'none', quick_links: 'none', resume_grader: 'none', security: 'none',
  settings: 'none', writer: 'document', _blank: 'none', _template: 'none',
};

// ── Folder-is-truth naming — mirror of blockRegistry.js labelFromFolder ──
const ACRONYMS = { ats: 'ATS', ai: 'AI', os: 'OS', vp: 'VP', llm: 'LLM', api: 'API' };
function labelFromFolder(folder) {
  return folder.split(/[_-]+/).filter(Boolean)
    .map(w => ACRONYMS[w.toLowerCase()] || w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

const GROUP_META = {
  finance: { label: 'FINANCE', icon: '⚡', order: 0 },
  agent:   { label: 'AGENT',   icon: '🤖', order: 1 },
  work:    { label: 'WORK',    icon: '💼', order: 2 },
  content: { label: 'CONTENT', icon: '🔍', order: 3 },
  tools:   { label: 'TOOLS',   icon: '🔧', order: 4 },
  system:  { label: 'SYSTEM',  icon: '📊', order: 5 },
};

function listBlockFolders() {
  if (!fs.existsSync(BLOCKS_DIR)) return [];
  return fs.readdirSync(BLOCKS_DIR).filter(f => {
    if (f.startsWith('_')) return false; // _template is scaffolding, never synced/mounted (K2)
    try { return fs.statSync(path.join(BLOCKS_DIR, f)).isDirectory(); } catch { return false; }
  });
}

function readManifest(folder) {
  const p = path.join(BLOCKS_DIR, folder, 'block.manifest.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/** Build the env-var list a block needs from its declared API requirements. */
function deriveEnv(apis) {
  const env = [];
  for (const a of apis || []) {
    for (const v of (API_ENV[a] || [])) if (!env.includes(v)) env.push(v);
  }
  return env;
}

/**
 * Normalize one folder's manifest to the canonical schema. Pure: returns the
 * new manifest object (caller decides whether to write). Preserves existing
 * description/category/deployment; injects nav + derived env; pins route to
 * the canonical NAV route when present (heals drift).
 */
function normalizeManifest(folder) {
  const m = readManifest(folder) || {};
  const nav = NAV[folder];
  const icon = (nav && nav.icon) || ICON_FALLBACKS[folder] || m.nav?.icon || m.icon || 'Boxes';
  // ── Icon: the manifest IS the store ────────────────────────────────
  // The customize route writes the user's pick into nav.iconAsset, and boot
  // sync must PRESERVE it — that's what makes an icon change outlive a fresh
  // clone (block.manifest.json is git-tracked; data/ is not). A pick whose
  // file no longer exists degrades to the folder default instead of rendering
  // a broken image forever.
  const declaredIcon = m.nav?.iconAsset;
  const iconExists = declaredIcon
    ? fs.existsSync(path.join(ICON_DIR, path.basename(declaredIcon)))
    : false;
  const iconAsset    = iconExists ? declaredIcon : `${ICON_BASE}/${folder}.svg`;
  const iconAssetPng = `${ICON_PNG_BASE}/${folder}.png`;
  // Block-declared opt-out — the cartridge decides whether its icon is
  // user-editable, not the shell. Absent = editable.
  const iconEditable = m.contract?.customizable?.icon !== false;
  const apis = (m.requires && m.requires.apis) || [];
  const hasApi = fs.existsSync(path.join(BLOCKS_DIR, folder, 'api'));

  // ── AEON Block Contract v2 ─────────────────────────────────────────
  // Every field the Neural Terminal needs to understand, wire, and
  // control a block without parsing its source code.
  const out = {
    // K1: schema version travels with the manifest — absent = 1.0.0 (grandfathered).
    // See src/kernel/schema.json + MIGRATION_POLICY.md before touching this shape.
    manifestVersion: '1.1.0',
    id: folder,
    label: labelFromFolder(folder),
    icon,
    route: (nav && nav.route) || m.route || `/${folder}`,
    description: m.description || '',
    category: m.category || (nav && nav.group) || 'system',
    tier: m.tier || (['dashboard','fleet_control','settings','activity','master'].includes(folder) ? 'core' : 'plugin'),
    nav: nav
      ? { group: nav.group, order: nav.order, label: labelFromFolder(folder), icon, iconAsset, iconAssetPng, hidden: false }
      : { group: 'system', order: 99, label: labelFromFolder(folder), icon, iconAsset, iconAssetPng, hidden: m.nav?.hidden === true },
    // Widget contract — quick-view the dashboard can render (weather-widget model)
    widget: m.widget || null,
    requires: {
      apis,
      env: (m.requires && m.requires.env) || deriveEnv(apis),
      local: (m.requires && m.requires.local) || [],
      blocks: (m.requires && m.requires.blocks) || [],
    },
    provides: {
      routes: true,
      api: hasApi,
      models: (m.provides && m.provides.models) || [],
    },
    api_routes: hasApi,
    version: m.version || '1.0.0',

    // ── Block Contract: Intelligence Layer ───────────────────────────
    // Tells the Neural Terminal and any AI model what this block can do.
    contract: {
      // What the operator may change about this block's presentation. Declared
      // by the cartridge — the shell never decides this per-block. Only `icon`
      // is user-editable; the display NAME always derives from the folder
      // (folder-is-truth, CEO rule 2026-07-16).
      customizable: { icon: iconEditable },
      // What the block accepts as input (data types, file formats, etc)
      inputs:  m.contract?.inputs  || [],
      // What the block produces as output
      outputs: m.contract?.outputs || [],
      // Events this block emits (other blocks can subscribe)
      events:  m.contract?.events  || [],
      // Permissions the block requests from the OS sandbox
      permissions: m.contract?.permissions || {
        filesystem: hasApi ? 'read' : 'none',   // none | read | write
        network:    apis.length > 0 ? 'external' : 'internal', // none | internal | external
        secrets:    apis.length > 0,             // can access vault keys
        shell:      false,                       // can execute shell commands
        ai:         true,                        // can call kernelLLM
      },
      // Storage requirements
      storage: {
        type: m.contract?.storage?.type || 'json',
        scope: m.contract?.storage?.scope || 'block',
        local: { indexed: false, retention: m.contract?.storage?.local?.retention || 'operational' },
        access: m.contract?.storage?.access || (folder.startsWith('_') ? 'scoped' : 'compatibility'),
      },
      // Durable user memory belongs in the Vault only. Local block data is not indexed.
      memory: {
        mode: m.contract?.memory?.mode || MEMORY_POLICY[folder] || 'none',
        indexed: (m.contract?.memory?.mode || MEMORY_POLICY[folder] || 'none') !== 'none',
        userConfigurable: m.contract?.memory?.userConfigurable === true,
      },
      // AI capabilities this block exposes
      ai: m.contract?.ai || {
        canGenerate:   false,  // block can generate content via LLM
        canAnalyze:    false,  // block can analyze user data via LLM
        canAutomate:   false,  // block supports autonomous task execution
        roles:         [],     // which kernelLLM roles it uses: ['chat', 'research', ...]
      },
      // Deployment targets where this block is functional
      targets: m.contract?.targets || {
        local:      true,
        vercel:     (typeof m.deployment === 'string' ? m.deployment : m.deployment?.target) !== 'local_required',
        docker:     true,
        cloudflare: (typeof m.deployment === 'string' ? m.deployment : m.deployment?.target) !== 'local_required',
      },
      // Terminal commands this block registers (e.g. /trading start)
      commands: m.contract?.commands || [],
      // Settings keys this block reads from aeon-settings.json
      settings_keys: m.contract?.settings_keys || [],
      // Declared settings controls — Settings renders these automatically.
      // Block leaves → its controls leave; block arrives → they appear.
      // Each: { key, label, desc, type: 'toggle'|'text'|'secret'|'select'|'number', default, options? }
      // Values persist in aeon-settings.json → blockSettings[<id>][<key>].
      settings: m.contract?.settings || [],
    },

    // ── Diagram-spec top-level fields (v4 enrichment) ─────────────────
    routes: m.routes || (hasApi ? [{ method: 'ALL', path: `/${folder}/*`, auth: true }] : []),
    env: m.env || deriveEnv(apis),
    ai: {
      capabilities: m.ai?.capabilities || m.contract?.ai?.roles || [],
      canGenerate: m.ai?.canGenerate ?? m.contract?.ai?.canGenerate ?? false,
      canAnalyze: m.ai?.canAnalyze ?? m.contract?.ai?.canAnalyze ?? false,
      canAutomate: m.ai?.canAutomate ?? m.contract?.ai?.canAutomate ?? false,
    },
    storage: {
      provider: m.storage?.provider || m.contract?.storage?.type || 'json',
      tables: m.storage?.tables || [],
      scope: m.storage?.scope || m.contract?.storage?.scope || 'block',
    },
    dependencies: m.dependencies || (m.requires?.blocks) || [],
    deployment: {
      target: typeof m.deployment === 'object' ? m.deployment.target : (m.deployment || 'universal'),
      runtime: m.deployment?.runtime || (m.contract?.targets?.vercel === false ? 'local' : 'any'),
    },
  };
  return out;
}

/** Check readiness of a block against live env + a desktop-file probe. */
function checkReadiness(manifest, env) {
  env = env || process.env;
  const missing = [];
  for (const a of manifest.requires.apis || []) {
    const vars = API_ENV[a] || [];
    if (!vars.length) continue;
    const fileProbe = vars.find(v => v.startsWith('__FILE__'));
    if (fileProbe) {
      const fname = fileProbe.replace('__FILE__', '');
      // Look inside the install first (secrets/), Desktop only as legacy.
      const ok = [
        path.join(__dirname, '..', '..', 'secrets', fname),
        path.join(process.env.USERPROFILE || process.env.HOME || '', 'Desktop', fname), // aeon-path-authority-allow
      ].some(p => { try { return fs.existsSync(p); } catch { return false; } });
      if (!ok) missing.push(a);
      continue;
    }
    const present = API_ENV_ALL.has(a)
      ? vars.every(v => !!env[v])
      : vars.some(v => !!env[v]);
    if (!present) missing.push(a);
  }
  const depTarget = typeof manifest.deployment === 'object' ? manifest.deployment.target : manifest.deployment;
  const localMissing = (depTarget === 'local_required' && process.env.VERCEL) ? ['desktop'] : [];

  // ── Declared AI roles ─────────────────────────────────────────────────────
  // Readiness used to be computed from requires.apis ALONE. Writer leaves that
  // empty while declaring contract.ai.roles ["creative"], so Writer reported
  // ready even when its role pointed at a provider with no model — the operator
  // clicked an AI action and got an error from a block the UI called ready.
  //
  // Roles are reported SEPARATELY rather than folded into `ready`, and that is
  // a deliberate line. memory_core declares role "chat" for its distill route,
  // but /api/memory/add needs no model at all — saving a memory is a file
  // write. Failing the whole block because one AI capability cannot serve would
  // overstate in the opposite direction and would have broken memory saving,
  // which is the capability BO-F1 exists to make trustworthy.
  //
  // So: `ready` keeps meaning "hard requirements met, the block will mount and
  // its non-AI capabilities work". `roles` says which declared AI capabilities
  // can actually serve right now, and `degraded` is the one-word summary a
  // badge or an error message can act on.
  const declaredRoles = manifest.contract?.ai?.roles || [];
  let roles = null;
  if (declaredRoles.length) {
    let describe = null;
    try { describe = require('./endpoints.cjs').describeRoleLocal; } catch { /* endpoints absent */ }
    roles = {};
    for (const role of declaredRoles) {
      if (!describe) { roles[role] = { ready: null, reason: 'resolver_unavailable' }; continue; }
      try {
        const r = describe(role);
        roles[role] = r.ok
          ? { ready: true, provider: r.provider, model: r.model }
          : { ready: false, reason: r.reason, provider: r.provider || null };
      } catch (e) {
        // R-05: an unresolvable role is reported, never silently treated as fine.
        roles[role] = { ready: false, reason: 'resolver_threw', error: e.message };
      }
    }
  }

  return {
    ready: missing.length === 0 && localMissing.length === 0,
    missingApis: missing,
    localMissing,
    roles,
    degraded: !!roles && Object.values(roles).some(r => r.ready === false),
  };
}

/**
 * Merge a block's own .env.block into the environment — a cartridge shipping
 * its own defaults. AEON-CENTRAL ALWAYS WINS: a key already set globally (real
 * .env / process.env) is never overwritten, so dropping a block can't clobber
 * the operator's keys. Block-only keys (e.g. a block-specific base URL) fill in.
 * Returns the list of keys the block contributed.
 */
function mergeBlockEnv(folder) {
  const p = path.join(BLOCKS_DIR, folder, '.env.block');
  if (!fs.existsSync(p)) return [];
  const added = [];
  try {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!m) continue;
      const key = m[1];
      const val = m[2].trim().replace(/^["']|["']$/g, '');
      if (process.env[key] === undefined || process.env[key] === '') {
        process.env[key] = val;       // fill gap; central value wins if present
        added.push(key);
      }
    }
  } catch {}
  return added;
}

/**
 * Flash a fresh runtime config into a block — the console writing the save
 * file onto the cartridge. Overwritten every boot so it's always in sync with
 * central settings/models/auth. Blocks read this to reach AEON services.
 */
function writeRuntimeConfig(folder, manifest, ctx) {
  const cfg = {
    _generated: new Date().toISOString(),
    _warning: 'AUTO-GENERATED by AEON on boot. Do not edit — changes are overwritten.',
    blockId: folder,
    apiBase: ctx.apiBase || '/api',
    runtime: ctx.runtime || (process.env.VERCEL ? 'cloud' : 'local'),
    auth: { required: !!ctx.requireLogin, mode: 'session+bearer' },
    models: ctx.models || {},            // resolved role → {provider,model} snapshot
    readiness: checkReadiness(manifest, process.env),
  };
  try {
    fs.writeFileSync(path.join(BLOCKS_DIR, folder, '.aeon.runtime.json'), JSON.stringify(cfg, null, 2));
    return true;
  } catch { return false; }
}

/**
 * Full boot pass: normalize every manifest (write), delete legacy block.json,
 * flash runtime configs, and return the registry with readiness.
 */
function syncAllBlocks(ctx = {}) {
  const registry = [];
  for (const folder of listBlockFolders()) {
    mergeBlockEnv(folder);                 // cartridge defaults fill gaps (central wins)
    const manifest = normalizeManifest(folder);
    // Persist normalized manifest (heals drift, adds nav/env).
    try {
      fs.writeFileSync(path.join(BLOCKS_DIR, folder, 'block.manifest.json'), JSON.stringify(manifest, null, 2));
    } catch (e) { console.warn(`[BLOCK] manifest write failed ${folder}: ${e.message}`); }
    // Kill the legacy duplicate.
    const legacy = path.join(BLOCKS_DIR, folder, 'block.json');
    if (fs.existsSync(legacy)) { try { fs.unlinkSync(legacy); } catch {} }
    // Flash runtime config.
    if (ctx.writeRuntime !== false) writeRuntimeConfig(folder, manifest, ctx);
    registry.push({ ...manifest, readiness: checkReadiness(manifest, process.env) });
  }
  return registry;
}

module.exports = {
  BLOCKS_DIR, NAV, GROUP_META, API_ENV, MEMORY_POLICY,
  ICON_BASE, ICON_PNG_BASE, ICON_DIR,
  listBlockFolders, readManifest, normalizeManifest, deriveEnv,
  checkReadiness, writeRuntimeConfig, syncAllBlocks, mergeBlockEnv,
};
