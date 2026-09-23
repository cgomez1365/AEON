/**
 * The token heatmap's recorder, taken from the activity block when it is there.
 *
 * services/ai.js calls one recorder after every LLM call; the activity block
 * writes it into its per-day history file. server.js used to require the
 * block's router at boot, mount that SECOND instance at /api, and hand its
 * recorder to ai.js. The block loader already mounts the block's own instance
 * from its manifest, so after `aeon block remove activity` the kernel's copy
 * kept answering /api/token-analytics/* with 200 — the Dashboard's "Activity
 * is not installed" panels never showed — and a block restored at runtime
 * recorded nothing until a restart (measured 2026-09-23).
 *
 * Now nothing is mounted here. The recorder looks for the block on each call:
 * a removed block stops recording, a restored one records at once.
 */
const fs = require('fs');
const path = require('path');

function createActivityRecorder({ blocksDir, deps }) {
  const file = path.join(blocksDir, 'activity', 'api', 'token-analytics.cjs');
  let instance = null;
  return function recordActivity(...args) {
    if (!fs.existsSync(file)) { instance = null; return false; }
    if (!instance) instance = require(file)(deps);
    if (typeof instance._recordActivity !== 'function') return false;
    instance._recordActivity(...args);
    return true;
  };
}

module.exports = { createActivityRecorder };
