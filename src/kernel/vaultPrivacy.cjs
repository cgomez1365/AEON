/**
 * Vault files the Second Brain must not hold — not in the index, not in
 * recall, not in /ask — because the operator said so in Memory Core.
 *
 *   Agents/<Folder>/…                     an agent set to Local only: its
 *                                         memory, its chats, its mission log
 *   Agents/<Folder>/memory/<id>.md        a memory switched Off
 *   Agents/<Folder>/memory/memories.json  a memory store that holds an Off
 *                                         memory, or cannot be read. A store
 *                                         with every memory on stays indexed:
 *                                         a memory whose <id>.md mirror was
 *                                         never written is found through it.
 *
 * Found 2026-10-03 (audit #2): Memory Core said "Local only — never leaves
 * this computer" and "Off — not sent to the model", while the indexer walked
 * both into the index and an embedder in the cloud received them, and /ask
 * quoted a switched-off memory into a cloud chat call.
 *
 * Whether a memory is on is read from its store (memories.json) — the record
 * the chat itself reads before it sends memories to a model. A mirror whose
 * store cannot be read, or that its store does not list, is judged by its own
 * front matter ("active: false"). An agent.json that exists but cannot be read
 * withholds the folder: a privacy setting nobody can read is not "off".
 *
 * Everything is read from disk once per scope (one scan, one recall), so a
 * switch flipped a moment ago is honoured by the next one.
 *
 * A path is judged as the disk resolves it, not as it was typed (the A056
 * class, which fs.cjs's safePath fixed for its denylist): macOS, Windows and
 * the exFAT drive ignore case, so "agents/scout/memory/s1.md" opens Scout's
 * file, and a symlink elsewhere in the Vault can lead into Agents/. The path
 * is judged both as realpath resolves it and as given; a part that does not
 * exist is matched without regard to case, so a mis-cased path is withheld on
 * every disk.
 *
 * Kernel module: relative requires only, takes the vault root as an argument.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FRONTMATTER_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---/;

// The deepest part of `p` that exists, resolved by the disk (its real case,
// symlinks followed), with the rest appended as given. null: nothing resolves.
function onDisk(p) {
  const rest = [];
  let probe = p;
  for (;;) {
    try { return path.join(fs.realpathSync.native(probe), ...rest); }
    catch {
      const up = path.dirname(probe);
      if (up === probe) return null;
      rest.unshift(path.basename(probe));
      probe = up;
    }
  }
}

// A Vault-relative POSIX path as its parts, ".." resolved and clamped at the
// Vault root ("Notes/../Agents/Scout" is Agents/Scout).
function split(relPosix) {
  const norm = path.posix.normalize(`/${relPosix}`).slice(1);
  return norm.split('/').filter(Boolean);
}

const within = (child, parent) => child === parent || child.startsWith(parent + path.sep);

function createScope(vaultRoot) {
  const realRoot = onDisk(path.resolve(vaultRoot));
  const agentsRoot = path.join(vaultRoot, 'Agents');
  let agentFolders = null;
  const localOnly = new Map();
  const stores = new Map();

  // The parts of a Vault-relative path as the disk names them.
  function resolveParts(parts) {
    if (realRoot) {
      const real = onDisk(path.join(path.resolve(vaultRoot), ...parts));
      if (real && within(real, realRoot)) return path.relative(realRoot, real).split(path.sep).filter(Boolean);
    }
    return parts;
  }

  // A folder under Agents/ by its name on disk, matched without regard to
  // case when the name as given does not exist. Unchanged when none matches.
  function folderOnDisk(folder) {
    if (fs.existsSync(path.join(agentsRoot, folder))) return folder;
    if (!agentFolders) { try { agentFolders = fs.readdirSync(agentsRoot); } catch { agentFolders = []; } }
    const lower = folder.toLowerCase();
    return agentFolders.find((f) => f.toLowerCase() === lower) || folder;
  }

  function isLocalOnly(folder) {
    if (!localOnly.has(folder)) {
      let yes = false;
      try {
        yes = JSON.parse(fs.readFileSync(path.join(agentsRoot, folder, 'agent.json'), 'utf8'))?.privacy === 'local-only';
      } catch (e) {
        // No agent.json (Agents/council, the operator's own AEON before it was
        // named) is an ordinary folder. One that is there and unreadable is not.
        yes = !(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR'));
      }
      localOnly.set(folder, yes);
    }
    return localOnly.get(folder);
  }

  // { all, off } — the ids a store lists and the ones switched off; null when
  // the store is missing or cannot be read.
  function store(folder) {
    if (!stores.has(folder)) {
      let rec = null;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(agentsRoot, folder, 'memory', 'memories.json'), 'utf8'));
        const list = Array.isArray(raw) ? raw : raw?.memories;
        if (Array.isArray(list)) {
          rec = { all: new Set(), off: new Set() };
          for (const m of list) {
            if (!m || m.id == null) continue;
            rec.all.add(String(m.id));
            if (m.active === false) rec.off.add(String(m.id));
          }
        }
      } catch { rec = null; }
      stores.set(folder, rec);
    }
    return stores.get(folder);
  }

  function mirrorSaysOff(full) {
    try {
      const fd = fs.openSync(full, 'r');
      try {
        const buf = Buffer.alloc(4096);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        const m = FRONTMATTER_RE.exec(buf.subarray(0, n).toString('utf8'));
        return !!m && /^active:\s*false\s*$/m.test(m[1]);
      } finally { fs.closeSync(fd); }
    } catch { return false; }
  }

  /**
   * Why a Vault-relative POSIX path is withheld, or null when it is not.
   * 'local-only-agent' | 'memory-off' | 'memory-store'. Works for a folder
   * too ("Agents/Scout"), so a walk can skip a Local only agent whole.
   */
  function withheld(relPosix) {
    return withheldFor(relPosix);
  }

  /**
   * The same verdicts for a caller that is itself an agent set to Local only
   * (agentTools.cjs): `ownFolder` is that agent's folder, and a path inside
   * it is not withheld for being a Local only agent's — its own memory,
   * scratchpad and handoffs are its own. A memory it switched Off, and a
   * store that holds one, still are. Every other caller passes nothing and
   * gets exactly withheld().
   */
  function withheldFor(relPosix, { ownFolder = null } = {}) {
    const given = split(String(relPosix || '').replace(/\\/g, '/').replace(/^Vault\//, ''));
    const real = resolveParts(given);
    const own = ownFolder ? String(ownFolder).toLowerCase() : null;
    // Both: the name the disk gives it, and the one it was reached by (a
    // symlink named Agents/Scout is Scout's to the operator, wherever it points).
    return judge(real, own) || (real.join('/') === given.join('/') ? null : judge(given, own));
  }

  function judge(parts, own = null) {
    if (parts.length < 2 || parts[0].toLowerCase() !== 'agents') return null;
    const folder = folderOnDisk(parts[1]);
    if (folder.startsWith('.')) return null;
    if (isLocalOnly(folder) && !(own && folder.toLowerCase() === own)) return 'local-only-agent';
    if (parts.length !== 4 || parts[2].toLowerCase() !== 'memory') return null;
    const name = parts[3];
    if (name.toLowerCase() === 'memories.json') {
      // Withheld while it holds a switched-off memory, or cannot be read.
      const st = store(folder);
      return !st || st.off.size ? 'memory-store' : null;
    }
    if (!/\.md$/i.test(name)) return null;
    const id = name.slice(0, -3);
    const st = store(folder);
    if (st && st.all.has(id)) return st.off.has(id) ? 'memory-off' : null;
    return mirrorSaysOff(path.join(agentsRoot, folder, 'memory', name)) ? 'memory-off' : null;
  }

  /** The same, for an absolute path; null when it is not in the Vault. */
  function withheldAt(absPath) {
    const abs = path.resolve(String(absPath || ''));
    const real = onDisk(abs);
    let rel = null;
    if (realRoot && real && within(real, realRoot)) rel = path.relative(realRoot, real);
    else if (within(abs, path.resolve(vaultRoot))) rel = path.relative(path.resolve(vaultRoot), abs);
    return rel == null ? null : withheld(rel.split(path.sep).join('/'));
  }

  /** A Vault-relative path as the disk names it (an index key), POSIX. */
  function canonical(relPosix) {
    return resolveParts(split(String(relPosix || '').replace(/\\/g, '/'))).join('/');
  }

  return { withheld, withheldFor, withheldAt, canonical };
}

/** One-off check, for a caller with a single path. */
function withheld(vaultRoot, relPosix) {
  return createScope(vaultRoot).withheld(relPosix);
}

/** One-off check of an absolute path. */
function withheldAt(vaultRoot, absPath) {
  return createScope(vaultRoot).withheldAt(absPath);
}

module.exports = { createScope, withheld, withheldAt };
