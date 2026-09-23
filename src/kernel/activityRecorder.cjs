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
const { liveBlockModule } = require('./liveBlockModule.cjs');

function createActivityRecorder({ blocksDir, deps }) {
  const activity = liveBlockModule({ blocksDir, file: 'activity/api/token-analytics.cjs', deps });
  return function recordActivity(...args) {
    const instance = activity();
    if (!instance || typeof instance._recordActivity !== 'function') return false;
    instance._recordActivity(...args);
    return true;
  };
}

module.exports = { createActivityRecorder };
