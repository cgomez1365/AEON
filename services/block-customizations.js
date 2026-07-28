/**
 * Block Customizations — user overrides for block labels and icons.
 * Lives in data/block-customizations.json (private, not Vault-indexed).
 * Sits above LABEL_OVERRIDES in blockStandard and above manifest defaults.
 * Schema: { [blockId]: { label?: string, iconAsset?: string } }
 */
const fs   = require('fs');
const path = require('path');

const DATA_DIR  = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'block-customizations.json');

function _read() {
  try {
    if (!fs.existsSync(STORE_FILE)) return {};
    return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch { return {}; }
}

function _write(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2));
}

function get(blockId) {
  const store = _read();
  return store[blockId] || null;
}

function getAll() {
  return _read();
}

function set(blockId, patch) {
  const store = _read();
  store[blockId] = { ...(store[blockId] || {}), ...patch };
  // Strip undefined/null fields
  for (const k of Object.keys(store[blockId])) {
    if (store[blockId][k] == null) delete store[blockId][k];
  }
  if (!Object.keys(store[blockId]).length) delete store[blockId];
  _write(store);
}

function reset(blockId) {
  const store = _read();
  delete store[blockId];
  _write(store);
}

module.exports = { get, getAll, set, reset };
