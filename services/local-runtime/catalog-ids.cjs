/**
 * One vocabulary for model identifiers.
 *
 * BO-D2e, root cause 3. Cookbook displays "Mistral 7B Instruct v0.3 (Q4_K_M)".
 * /model-pull demanded org/repo and answered "Invalid repo_id" to anything
 * else — including the catalogue ids its OWN description advertises:
 *
 *   "/model-pull qwen3-1.7b-q4 (curated catalog) or org/repo (HuggingFace)"
 *
 * The curated half of that sentence was false. /model/download validated
 * against a strict org/repo regex, so every catalogue id and every display
 * name was rejected. The operator was shown one vocabulary in the UI, told
 * about a second in the help text, and required to use a third.
 *
 * This resolves all of them to the one thing the downloader can use. It does
 * not guess: an input that matches nothing is returned unresolved, with the
 * near-misses, so the caller can name the remedy (§08).
 */

/** Strict HuggingFace org/repo. */
const REPO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Comparable form: case, spaces, punctuation and quantisation noise removed. */
function normalize(s) {
  return String(s || '').toLowerCase().replace(/[\s_().]+/g, '').replace(/-/g, '');
}

/**
 * A catalogue entry's download URL carries its repo:
 *   https://huggingface.co/Qwen/Qwen3-1.7B-GGUF/resolve/main/file.gguf
 * so the org/repo the downloader needs never has to be stored twice.
 */
function repoFromUrl(url) {
  const m = /^https?:\/\/huggingface\.co\/([^/]+)\/([^/]+)\//.exec(String(url || ''));
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Resolve whatever the operator typed into a repo id.
 *
 * @param {string} input
 * @param {Array}  catalog  entries from model-catalog.json
 * @returns {{ok, repoId?, matched?, via?, error?, suggestions?}}
 */
function resolveModelIdentifier(input, catalog = []) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return { ok: false, error: 'No model was named.', suggestions: [] };

  const entries = Array.isArray(catalog) ? catalog : [];
  const target = normalize(raw);

  // 1. A catalogue id or display name — what the UI actually shows.
  for (const m of entries) {
    if (normalize(m.id) === target || normalize(m.displayName) === target) {
      const repoId = repoFromUrl(m.url);
      if (repoId) return { ok: true, repoId, matched: m.id, via: normalize(m.id) === target ? 'catalog-id' : 'display-name' };
      // Catalogued but not resolvable to a repo — say so rather than
      // falling through to "Invalid repo_id", which would blame the input.
      return { ok: false, matched: m.id, error: `"${m.displayName || m.id}" is in the catalogue but carries no downloadable repository.`, suggestions: [] };
    }
  }

  // 2. Already the thing the downloader wants.
  if (REPO_ID_RE.test(raw)) return { ok: true, repoId: raw, via: 'repo-id' };

  // 3. Nothing matched. Offer the near-misses rather than a flat refusal —
  //    "tinyllama" should not be a dead end when the catalogue is right there.
  const suggestions = entries
    .filter(m => normalize(m.id).includes(target) || normalize(m.displayName).includes(target) || target.includes(normalize(m.id)))
    .slice(0, 5)
    .map(m => ({ id: m.id, displayName: m.displayName }));

  return {
    ok: false,
    error: `"${raw}" is not a catalogue model or a HuggingFace repository.`,
    suggestions,
  };
}

module.exports = { resolveModelIdentifier, repoFromUrl, normalize, REPO_ID_RE };
