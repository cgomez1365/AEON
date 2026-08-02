// Path containment — one implementation, used everywhere a path is authorized.
//
// The repo checked containment with `resolved.startsWith(root)` in seven places.
// A string prefix is not a filesystem boundary: C:\Users\Alexandra starts with
// C:\Users\Alex and is not inside it. Same for /data/vault-backup vs /data/vault.
//
// path.relative() answers the real question — what would I have to traverse to
// get from root to candidate? If the answer starts with '..', is absolute, or is
// empty, the candidate is not strictly inside the root.

const path = require('path');
const fs = require('fs');

/**
 * True when `candidate` resolves strictly inside `root`.
 * The root itself is NOT inside itself — callers authorizing a read or write
 * want a child, and allowing the root directory as a target has surprised us.
 *
 * @param {string} root       containing directory (need not exist)
 * @param {string} candidate  path being authorized
 * @param {{allowRoot?: boolean}} [opts] allowRoot: accept the root itself too
 */
function isInside(root, candidate, opts = {}) {
  if (typeof root !== 'string' || typeof candidate !== 'string') return false;
  if (root === '' || candidate === '') return false;

  let rel;
  try {
    rel = path.relative(path.resolve(root), path.resolve(candidate));
  } catch {
    return false;
  }

  if (rel === '') return !!opts.allowRoot;
  if (path.isAbsolute(rel)) return false;               // different drive/root
  // '..' alone, or any segment starting the traversal upward.
  if (rel === '..' || rel.startsWith(`..${path.sep}`)) return false;
  return true;
}

/**
 * isInside() against a list of roots. Returns the matching root, or null.
 */
function insideAny(roots, candidate, opts = {}) {
  if (!Array.isArray(roots)) return null;
  for (const root of roots) {
    if (isInside(root, candidate, opts)) return root;
  }
  return null;
}

/**
 * Containment after symlink resolution, for cases where a link inside an
 * allowed root could point outside it. Falls back to the lexical check when the
 * path does not exist yet (a create target legitimately does not).
 */
function isInsideReal(root, candidate, opts = {}) {
  if (!isInside(root, candidate, opts)) return false;
  try {
    const realRoot = fs.realpathSync(path.resolve(root));
    const realCandidate = fs.realpathSync(path.resolve(candidate));
    return isInside(realRoot, realCandidate, opts);
  } catch {
    return true; // target does not exist yet; lexical check already passed
  }
}

module.exports = { isInside, insideAny, isInsideReal };
