/**
 * The ONLY path authority for AEON's .env file.
 *
 * AEON already redirects every other writable root out of its install
 * directory: VAULT_PATH, DATA_PATH, AEON_WORKSPACE (services/storage.js) and
 * AEON_SECRETS_DIR (vault.cjs:22, endpoints.cjs:27, credentialBackup.cjs:45,
 * sessionValidator.cjs:33). The .env file was the one exception, and it is the
 * one file the first-run vault guard WRITES to.
 *
 * That matters for a packaged desktop build. A signed .app or an installed
 * Program Files directory must be treated as read-only: on macOS the bundle is
 * code-signed, and content that changes after signing fails Gatekeeper, which
 * reports the app as "damaged" rather than as unsigned. An installer that mints
 * a vault key into its own bundle on first launch breaks its own signature the
 * first time it runs.
 *
 * Precedence: AEON_ENV_FILE -> <appRoot>/.env
 *
 * Two rules inherited from services/local-runtime/paths.cjs, for the same
 * reasons documented there:
 *
 *   1. A RELATIVE override resolves against appRoot, never process.cwd(). A
 *      launcher started from another directory must not silently relocate the
 *      operator's master key.
 *
 *   2. appRoot must be absolute and explicit. Callers pass their own root;
 *      this module never infers one, because a second inferred root is how
 *      this class of defect starts.
 */
'use strict';

const path = require('path');

/**
 * Resolve the .env path.
 *
 * @param {{ appRoot: string, env?: object }} ctx
 *   appRoot - absolute path to the AEON install directory.
 *   env     - environment to read (defaults to process.env; injectable for tests).
 * @returns {string} absolute path to the .env file
 */
function envFilePath(ctx = {}) {
  const appRoot = ctx.appRoot;
  if (!appRoot || typeof appRoot !== 'string' || !path.isAbsolute(appRoot)) {
    throw new Error('envFilePath: ctx.appRoot must be an absolute path');
  }

  const env = ctx.env || process.env;
  const raw = env.AEON_ENV_FILE;

  // A launcher that exports an unset variable hands us "" or "   ". Resolving
  // that would yield appRoot itself — a directory — and every read and write
  // against it would fail in a way that reads like a corrupt install. Fall
  // back to the default instead (R-05: no silent failure, and no garbage path).
  const override = typeof raw === 'string' ? raw.trim() : '';
  if (!override) return path.join(appRoot, '.env');

  return path.isAbsolute(override) ? override : path.resolve(appRoot, override);
}

module.exports = { envFilePath };
