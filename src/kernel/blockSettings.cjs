'use strict';
/**
 * A block's settings, resolved — the one reader.
 *
 * A block declares its settings in block.manifest.json `contract.settings`
 * ({key, type, default}); Settings renders them and saves overrides to
 * aeon-settings.json → blockSettings[<id>][<key>]. Every reader goes through
 * get(): manifest default, then any legacy location the value used to live
 * in, then the saved override. Before this, the declared values were written
 * and nothing read them (2026-09-28 audit): four blocks showed toggles that
 * changed nothing, while the values chat actually used had no control at all.
 */
const fs = require('fs');
const path = require('path');

// The one blocks root (blocksDir.cjs, BO-J1) — the same folder the block host
// mounts, so a test or a portable install pointing AEON_BLOCKS_DIR elsewhere
// reads the manifests it actually runs.
const { BLOCKS_DIR } = require('./blocksDir.cjs');

// Where a value lived before it was declared. Read only when the operator has
// not saved it under blockSettings, so an existing install keeps its choice.
const LEGACY = {
  memory_core: {
    memory_in_context: (s) => s.prefs?.brain_settings?.memory_in_context ?? s.prefs?.memory_in_context,
    memory_max_context: (s) => s.prefs?.brain_settings?.memory_max_context ?? s.prefs?.memory_max_context,
    auto_memory: (s) => s.prefs?.brain_settings?.auto_memory ?? s.prefs?.auto_memory,
  },
};

// Cached per manifest mtime: a block installed, updated or removed from the
// store with AEON running (no restart) is read fresh on its next call.
const _defaults = new Map(); // id -> { mtimeMs, values, secrets }
function declared(id) {
  const file = path.join(BLOCKS_DIR, id, 'block.manifest.json');
  let mtimeMs = -1;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { /* not installed */ }
  const hit = _defaults.get(id);
  if (hit && hit.mtimeMs === mtimeMs) return hit;
  const values = {};
  const secrets = [];
  if (mtimeMs !== -1) {
    try {
      const m = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const def of (m.contract?.settings || [])) {
        values[def.key] = def.default;
        if (def.type === 'secret') secrets.push(def.key);
      }
    } catch (e) { console.error(`[BLOCK SETTINGS] ${id} manifest unreadable: ${e.message}`); }
  }
  const entry = { mtimeMs, values, secrets };
  _defaults.set(id, entry);
  return entry;
}
function defaults(id) { return declared(id).values; }
/** Keys the manifest declares as `type: "secret"`. */
function secretKeys(id) { return declared(id).secrets.slice(); }

function get(id, settings = {}) {
  const values = { ...defaults(id) };
  for (const [key, read] of Object.entries(LEGACY[id] || {})) {
    const v = read(settings || {});
    if (v !== undefined && v !== null) values[key] = v;
  }
  return { ...values, ...((settings && settings.blockSettings) || {})[id] };
}

/**
 * A block's settings as the BROWSER may see them: every `type: "secret"`
 * value blanked, with `secretsSet[key]` saying whether one is saved.
 *
 * GET /api/settings and GET /api/settings/block/:id returned these values in
 * plain text (measured 2026-10-02: a saved site password came back from both).
 * sanitizeSettings() strips keys NAMED like secrets, but the resolved block
 * values were added back after it ran, and a secret declared as "site_login"
 * would never have matched its name test anyway. The declaration decides,
 * not the name. Server code still reads the real value through get() (blocks:
 * deps.blockSettings()).
 */
function forBrowser(id, settings = {}) {
  const values = get(id, settings);
  const secretsSet = {};
  for (const key of secretKeys(id)) {
    const v = values[key];
    secretsSet[key] = v !== undefined && v !== null && String(v) !== '';
    values[key] = '';
  }
  return { values, secretsSet };
}

module.exports = { get, defaults, secretKeys, forBrowser, _clearCache: () => _defaults.clear() };
