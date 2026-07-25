/**
 * vaultSync.cjs
 * Kernel utility — blocks call vaultSync(blockId, stateObj) to write their
 * state summary to the Second Brain's Vault.
 *
 * Writes two files per block:
 *   Vault/blocks/{blockId}/state.json  — machine-readable, fast lookup
 *   Vault/blocks/{blockId}/state.md    — human + RAG-readable
 *
 * Uses atomic write (temp → rename) so the Second Brain never reads a partial file.
 * Call on data mutation, NOT on every read.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const storage = require('../../services/storage.js');

let indexScheduler = null;

function setIndexScheduler(scheduler) {
  indexScheduler = typeof scheduler === 'function' ? scheduler : null;
}

function requestIndex(change) {
  if (!indexScheduler) return;
  try {
    const result = indexScheduler(change);
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch {}
}

/**
 * @param {string} blockId   — matches the block folder name, e.g. "trading"
 * @param {object} stateObj  — flat or nested object with the block's key metrics.
 *   Each key should be a short metric name; value can be a primitive or
 *   { value, unit, context } object for richer Markdown output.
 *
 * @example
 *   vaultSync('trading', {
 *     engine_status: { value: 'OFF', context: 'Paper trading disabled' },
 *     open_trades:   { value: 0, unit: 'trades', context: 'No positions open' },
 *     daily_pnl:     { value: 0, unit: 'USD', context: 'Session not started' },
 *   });
 */
function vaultSync(blockId, stateObj) {
  if (!blockId || typeof blockId !== 'string') {
    throw new Error('vaultSync: blockId must be a non-empty string');
  }
  if (!stateObj || typeof stateObj !== 'object') {
    throw new Error('vaultSync: stateObj must be a plain object');
  }

  const blockDir = storage.getBlockVaultFile(blockId);
  fs.mkdirSync(blockDir, { recursive: true });

  const ts = new Date().toISOString();

  // ── 1. Write state.json (machine-readable) ──────────────────────────────
  const jsonPayload = JSON.stringify({ blockId, lastSync: ts, state: stateObj }, null, 2);
  atomicWrite(path.join(blockDir, 'state.json'), jsonPayload);

  // ── 2. Write state.md (human + RAG-readable) ────────────────────────────
  const label = _labelFromId(blockId);
  const mdLines = [
    `# ${label} — State Snapshot`,
    `**Last sync:** ${ts}`,
    `**Block:** ${blockId}`,
    '',
    '## Current State',
  ];

  for (const [key, raw] of Object.entries(stateObj)) {
    if (key === '_summary') continue; // handled below
    const { value, unit, context } = _normalise(raw);
    const displayVal = unit ? `${value} ${unit}` : String(value);
    const ctxPart    = context ? ` — ${context}` : '';
    mdLines.push(`- **${_humanKey(key)}:** ${displayVal}${ctxPart}`);
  }

  // Summary line — accept explicit _summary or auto-generate
  const summary = stateObj._summary || _autoSummary(blockId, stateObj);
  mdLines.push('', '## Summary', summary, '');

  atomicWrite(path.join(blockDir, 'state.md'), mdLines.join('\n'));
  requestIndex({ blockId, kind: 'state-summary' });
}

// ── helpers ─────────────────────────────────────────────────────────────────

function atomicWrite(filePath, content) {
  const tmp = path.join(os.tmpdir(), `vsync-${path.basename(filePath)}-${Date.now()}.tmp`);
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

function _labelFromId(id) {
  return id
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function _humanKey(key) {
  return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function _normalise(raw) {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    return {
      value:   raw.value   !== undefined ? raw.value   : JSON.stringify(raw),
      unit:    raw.unit    || '',
      context: raw.context || '',
    };
  }
  return { value: raw, unit: '', context: '' };
}

function _autoSummary(blockId, stateObj) {
  // Best-effort one-liner from the first few values
  const pairs = Object.entries(stateObj)
    .filter(([k]) => k !== '_summary')
    .slice(0, 3)
    .map(([k, v]) => {
      const { value } = _normalise(v);
      return `${_humanKey(k)}: ${value}`;
    });
  return `${_labelFromId(blockId)} — ${pairs.join(', ')}.`;
}

module.exports = { vaultSync, setIndexScheduler, requestIndex };
