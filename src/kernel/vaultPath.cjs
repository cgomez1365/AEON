/**
 * A Vault path a MODEL supplied, resolved safely — or refused with a reason.
 *
 * The agent tools (agentTools.cjs) take paths from model output, which is
 * untrusted: a document the model read can tell it to open "../../.ssh/id_rsa".
 * Every refusal is decided before any file is opened:
 *
 *   bad-path       not a string, longer than 512, a NUL byte, or empty
 *   absolute-path  /x, C:\x, \\host\x, file:..., ~/x
 *   traversal      any ".." segment (refused as written, never resolved)
 *   hidden         any segment starting with "." (Agents/.removed too) or OS junk
 *   outside-vault  a symlink inside the Vault that leads out of it
 *   not-found      nothing there (with the remedy)
 *
 * A leading "Vault/" is accepted and dropped ("Vault/Notes/a.md" is
 * "Notes/a.md"), and backslashes are read as slashes.
 *
 * Kernel module: relative requires only, takes the vault root as an argument.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { isInside } = require('./pathContainment.cjs');
const { isOsJunk } = require('./osJunk.cjs');

const PATH_MAX = 512;

const refuse = (code, message) => ({ ok: false, code, message });

// The realpath of the deepest part of `p` that exists, or null.
function deepestReal(p) {
  let probe = p;
  for (;;) {
    try { return fs.realpathSync.native(probe); }
    catch {
      const up = path.dirname(probe);
      if (up === probe) return null;
      probe = up;
    }
  }
}

/**
 * resolveInVault(vaultRoot, input, { allowRoot, mustExist })
 *   → { ok: true, abs, rel } | { ok: false, code, message }
 * `rel` is POSIX and Vault-relative ('' for the root).
 */
function resolveInVault(vaultRoot, input, { allowRoot = false, mustExist = true } = {}) {
  if (typeof input !== 'string') return refuse('bad-path', 'The path must be a string, like "Notes/plan.md".');
  if (input.length > PATH_MAX) return refuse('bad-path', `The path is longer than ${PATH_MAX} characters.`);
  if (input.includes('\0')) return refuse('bad-path', 'The path holds a NUL character.');
  let s = input.trim().replace(/\\/g, '/');
  if (/^(?:[a-z]:|file:|~)/i.test(s) || s.startsWith('/')) {
    return refuse('absolute-path', `"${input}" is not a Vault path. Use a path inside the Vault, like "Notes/plan.md".`);
  }
  // "./Notes", "Vault/Notes", "./Vault/./Notes"
  for (;;) {
    const next = s.replace(/^\.\/+/, '').replace(/^vault(?:\/+|$)/i, '');
    if (next === s) break;
    s = next;
  }
  const segs = s.split('/').filter((x) => x !== '' && x !== '.');
  if (segs.some((x) => x === '..')) {
    return refuse('traversal', `"${input}" climbs out with "..". Use a path inside the Vault, like "Notes/plan.md".`);
  }
  if (segs.some((x) => x.startsWith('.') || isOsJunk(x))) {
    return refuse('hidden', `"${input}" names a hidden or system file; AEON's tools do not open those.`);
  }
  const rel = segs.join('/');
  if (!rel && !allowRoot) return refuse('bad-path', 'A file path is required, like "Notes/plan.md".');
  const root = path.resolve(vaultRoot);
  const abs = rel ? path.join(root, ...segs) : root;
  if (!isInside(root, abs, { allowRoot })) return refuse('outside-vault', `"${input}" is outside the Vault.`);

  // Symlinks: the deepest part that exists must resolve inside the real Vault.
  const realRoot = deepestReal(root);
  if (realRoot) {
    const real = deepestReal(abs);
    if (real && !(real === realRoot || isInside(realRoot, real))) {
      return refuse('outside-vault', `"${input}" leads outside the Vault (a link). AEON's tools stay inside the Vault.`);
    }
  }
  if (mustExist && !fs.existsSync(abs)) {
    return refuse('not-found', `Nothing at "${rel || '/'}" in the Vault. Use vault_list or vault_search to find the right path.`);
  }
  return { ok: true, abs, rel };
}

module.exports = { resolveInVault, PATH_MAX };
