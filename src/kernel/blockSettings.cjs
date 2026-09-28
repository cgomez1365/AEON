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

const BLOCKS_DIR = path.join(__dirname, '..', 'blocks');

// Where a value lived before it was declared. Read only when the operator has
// not saved it under blockSettings, so an existing install keeps its choice.
const LEGACY = {
  memory_core: {
    memory_in_context: (s) => s.prefs?.brain_settings?.memory_in_context ?? s.prefs?.memory_in_context,
    memory_max_context: (s) => s.prefs?.brain_settings?.memory_max_context ?? s.prefs?.memory_max_context,
    auto_memory: (s) => s.prefs?.brain_settings?.auto_memory ?? s.prefs?.auto_memory,
  },
};

const _defaults = new Map();
function defaults(id) {
  if (_defaults.has(id)) return _defaults.get(id);
  const out = {};
  try {
    const m = JSON.parse(fs.readFileSync(path.join(BLOCKS_DIR, id, 'block.manifest.json'), 'utf8'));
    for (const def of (m.contract?.settings || [])) out[def.key] = def.default;
  } catch { /* block not installed — saved values still resolve */ }
  _defaults.set(id, out);
  return out;
}

function get(id, settings = {}) {
  const values = { ...defaults(id) };
  for (const [key, read] of Object.entries(LEGACY[id] || {})) {
    const v = read(settings || {});
    if (v !== undefined && v !== null) values[key] = v;
  }
  return { ...values, ...((settings && settings.blockSettings) || {})[id] };
}

module.exports = { get, defaults, _clearCache: () => _defaults.clear() };
