'use strict';

/**
 * Credential backup, owned by the kernel.
 *
 * BO-SHIP P2.2 (CEO: "the settings → security crossing needs a real API, not a
 * path"). Audit P0-07 / §12.
 *
 * `GET /api/settings/export-credentials` assembled the bundle itself: it built
 * `path.join(APP_ROOT, 'secrets')`, dynamically required services/storage.js to
 * call `getVaultFile(path.join('blocks','security'))`, and read `.env` from the
 * app root. A block was reaching into two private operational roots and a
 * SIBLING BLOCK's Vault namespace to do it.
 *
 * The three artifacts are halves of one key — the vault is unreadable without
 * all of them, which is exactly why the backup exists and exactly why a partial
 * restore locks the owner out. That makes assembling them a kernel concern.
 * Settings now asks for a bundle and renders the answer; it does not know where
 * any of it lives.
 *
 * This module holds no policy about WHO may call it. The route stays behind the
 * manifest auth guard (P2.1) — the boundary fixed here is namespace ownership,
 * not authorization, and conflating the two is how one of them gets forgotten.
 */
const fs = require('fs');
const path = require('path');

const APP_ROOT = path.join(__dirname, '..', '..');

/**
 * Where each artifact lives. One place, so a future move updates one map
 * instead of every caller that guessed a path.
 *
 * @param {object} [deps]
 * @param {function} [deps.getVaultFile] injected for tests; defaults to the
 *   real storage service, required lazily so this module stays importable in
 *   contexts where storage is not configured.
 */
function resolveSources(deps = {}) {
  const getVaultFile = deps.getVaultFile
    || ((...a) => require(path.join(APP_ROOT, 'services', 'storage.js')).getVaultFile(...a));

  const appRoot = deps.appRoot || APP_ROOT;
  const secretsDir = deps.secretsDir
    || process.env.AEON_SECRETS_DIR
    || path.join(appRoot, 'secrets');

  let securityVaultDir = null;
  try { securityVaultDir = getVaultFile(path.join('blocks', 'security')); } catch { /* unconfigured */ }

  return {
    '.env': path.join(appRoot, '.env'),
    'secrets/aeon-keyslots.json': path.join(secretsDir, 'aeon-keyslots.json'),
    'vault/provider_credentials.json': securityVaultDir
      ? path.join(securityVaultDir, 'provider_credentials.json')
      : null,
  };
}

/**
 * Assemble the backup.
 *
 * @returns {{ ok: boolean, bundle?: object, filename?: string, error?: string }}
 *   ok:false when every artifact is missing — there is nothing to back up, and
 *   handing the operator an empty file that looks like a backup is worse than
 *   telling them. R-05.
 */
function exportBundle(deps = {}) {
  const sources = resolveSources(deps);

  const bundle = {
    _artifact: 'AEON credential backup',
    _warning: 'Contains plaintext secrets. Store offline, never commit to git.',
    _restore: 'On a fresh clone: copy .env to root, secrets/aeon-keyslots.json to secrets/, vault/provider_credentials.json to its vault path. Boot — vault auto-unlocks.',
    exported_at: new Date().toISOString(),
    files: {},
  };

  for (const [key, filePath] of Object.entries(sources)) {
    if (!filePath) { bundle.files[key] = null; continue; }
    try { bundle.files[key] = fs.readFileSync(filePath, 'utf8'); }
    catch { bundle.files[key] = null; }
  }

  if (!Object.values(bundle.files).some((v) => v !== null)) {
    return { ok: false, error: 'No credential files found — nothing to export.' };
  }

  return {
    ok: true,
    bundle,
    filename: `aeon-credentials-${new Date().toISOString().slice(0, 10)}.json`,
  };
}

module.exports = { exportBundle, resolveSources };
