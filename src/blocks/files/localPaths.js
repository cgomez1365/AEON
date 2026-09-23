// Path arithmetic for the Local pane — pure, no React, so it is testable in
// node (tests/files-block.test.js).
//
// Why it exists (measured 2026-09-23, agent C4): the pane built every path from
// the browser's WORKSPACE constant, which is VITE_AEON_WORKSPACE — set by no
// build, so always ''. The landing folder the server shows is the Vault, but
//   - New folder at the landing view sent `/${name}` — the filesystem root —
//     and got 403 "Path is outside the allowed area";
//   - Upload at the landing view sent targetDir '', which the uploader resolves
//     to the workspace, not the Vault on screen: "1 file saved" and the file
//     never appeared in the list.
// The server already answers every listing with the absolute folder it listed
// (`path`). Every path here is derived from that, never from a build constant.

/** The separator a path uses: backslash for a Windows path, else slash. */
export function sepOf(p) {
  const s = String(p || '');
  if (/^[A-Za-z]:[\\/]/.test(s) || /^\\\\/.test(s)) return '\\';
  return s.includes('\\') && !s.includes('/') ? '\\' : '/';
}

/** A child of `dir` named `name`, in dir's own separator. */
export function joinPath(dir, name) {
  const d = String(dir || '');
  const sep = sepOf(d);
  const trimmed = d.replace(/[\\/]+$/, '');
  // POSIX root '/' trims to '' — keep it absolute. 'C:\' trims to 'C:'.
  return `${trimmed}${sep}${name}`;
}

/** The folder containing `p`; a root returns itself. */
export function parentOf(p) {
  const s = String(p || '');
  const sep = sepOf(s);
  const trimmed = s.replace(/[\\/]+$/, '');
  const at = trimmed.lastIndexOf(sep);
  if (at < 0) return s;
  if (at === 0) return sep;                          // '/Users' -> '/'
  const head = trimmed.slice(0, at);
  return /^[A-Za-z]:$/.test(head) ? head + sep : head; // 'C:\Users' -> 'C:\'
}

/**
 * Breadcrumbs for `current`. Inside the landing folder they are relative to it
 * (the Home button already names the landing folder); anywhere else they are
 * the absolute path's segments. Each crumb carries the absolute path to load.
 */
export function crumbsFor(current, landing) {
  const cur = String(current || '');
  if (!cur) return [];
  const sep = sepOf(cur);
  const base = String(landing || '').replace(/[\\/]+$/, '');
  if (base && (cur === base || cur.startsWith(base + sep))) {
    const rel = cur.slice(base.length).split(/[\\/]/).filter(Boolean);
    return rel.map((label, i) => ({ label, path: base + sep + rel.slice(0, i + 1).join(sep) }));
  }
  const parts = cur.split(/[\\/]/).filter(Boolean);
  const posix = sep === '/' && cur.startsWith('/');
  return parts.map((label, i) => {
    const joined = parts.slice(0, i + 1).join(sep);
    return { label, path: posix ? '/' + joined : (i === 0 && /^[A-Za-z]:$/.test(joined) ? joined + sep : joined) };
  });
}
