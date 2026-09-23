/**
 * A kernel hook into one block's module that follows the block in and out.
 *
 * A few kernel hooks call into a block directly (the token heatmap recorder,
 * the Second Brain index scheduler). They were wired once at boot: a block
 * absent at boot stayed unwired after a runtime restore until the next
 * restart, and a kernel-held instance outlived the block's removal (measured
 * 2026-09-23). `get()` looks for the file on each call and builds the
 * instance on first use, so blocks can be added and removed while AEON runs
 * (Bible §03, "Composable").
 */
const fs = require('fs');
const path = require('path');

function liveBlockModule({ blocksDir, file, deps }) {
  const abs = path.join(blocksDir, file);
  let instance = null;
  // The instance is kept across a remove/restore: some factories start timers
  // (the Matrix's nightly re-index), and building one per restore would stack them.
  return function get() {
    if (!fs.existsSync(abs)) return null;
    if (!instance) instance = require(abs)(deps);
    return instance;
  };
}

module.exports = { liveBlockModule };
