/**
 * BO-J1 — one authority for "where do blocks live".
 *
 * Principle 04: what a block may touch is derived from its own manifest,
 * "by the same code path in every environment". Seven modules each computed
 * `path.join(__dirname, '..', 'blocks')` independently, which is the same
 * shape as the two model registries (BO-C) and the two activity routers
 * (BO-D2g): not a missing feature, a second copy nobody knew was there.
 *
 * It also left the root un-overridable — the only one. DATA_PATH, VAULT_PATH,
 * AEON_WORKSPACE and AEON_SECRETS_DIR are all redirectable, and `blocks` was
 * the omission. That is why tests/block-customize.test.js has to drive the
 * real customize router against the real src/blocks/, mutating two COMMITTED
 * manifests and restoring them in afterAll. On 2026-08-10 that race was
 * observed failing two different readers mid-write:
 *
 *   block-manifest-routes  — read a manifest with placeholder values
 *   vercel-mount-parity    — JSON.parse on a half-written file
 *                            ("Unexpected end of JSON input")
 *
 * Roughly one run in three. The test is not careless; the kernel gave it no
 * alternative. This is the alternative.
 *
 * Resolved ONCE at module load, deliberately. A value that can change between
 * two reads in the same process is worse than one that is wrong — callers
 * must set AEON_BLOCKS_DIR before requiring anything that reaches this,
 * exactly as AEON_SECRETS_DIR already requires.
 */
const path = require('path');

const DEFAULT_BLOCKS_DIR = path.join(__dirname, '..', 'blocks');

// aeon-path-authority-allow — this module IS the blocks-root authority; the
// override exists so tests and portable installs can point at a copy.
const BLOCKS_DIR = process.env.AEON_BLOCKS_DIR
  ? path.resolve(process.env.AEON_BLOCKS_DIR)
  : DEFAULT_BLOCKS_DIR;

const isOverridden = () => BLOCKS_DIR !== DEFAULT_BLOCKS_DIR;

module.exports = { BLOCKS_DIR, DEFAULT_BLOCKS_DIR, isOverridden };
