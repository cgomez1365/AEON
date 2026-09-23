/**
 * Names an operating system or file manager drops beside real files.
 *
 * macOS writes an AppleDouble sidecar "._<name>" for any file carrying an
 * extended attribute, on every volume that cannot store attributes natively —
 * exFAT, FAT, SMB shares. Finder adds ".DS_Store"; "Compress" adds a
 * "__MACOSX/" folder to zips; Windows adds "Thumbs.db" and "desktop.ini";
 * removable drives collect ".Spotlight-V100", ".fseventsd", ".Trashes",
 * "$RECYCLE.BIN" and "System Volume Information".
 *
 * None of these is ever content. On 2026-09-22 an AEON copied to an exFAT
 * drive carried 50,806 sidecars, and every directory scan that filtered by
 * extension took them for real files — the block host tried to mount
 * "._chat.cjs", the Second Brain indexed "._note.md". Scans that own their
 * directory (code, versions, sessions) skip every hidden name; scans of places
 * a person might keep dotfiles on purpose use isOsJunk.
 *
 * Kernel module: no requires beyond node built-ins.
 */
'use strict';

const OS_JUNK = new Set([
  '.DS_Store', '.AppleDouble', '.LSOverride', '.Spotlight-V100', '.fseventsd',
  '.Trashes', '.TemporaryItems', '.DocumentRevisions-V100', '.apdisk', '__MACOSX',
  'Thumbs.db', 'ehthumbs.db', 'desktop.ini', '$RECYCLE.BIN', 'System Volume Information',
]);

/** True for OS/file-manager droppings: AppleDouble sidecars and the fixed set above. */
function isOsJunk(name) {
  const n = String(name || '');
  return n.startsWith('._') || OS_JUNK.has(n);
}

/** True for any dot-name. For directories AEON owns, where nothing hidden is ever content. */
function isHidden(name) {
  return String(name || '').startsWith('.');
}

module.exports = { isOsJunk, isHidden, OS_JUNK };
