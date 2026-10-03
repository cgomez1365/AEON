/**
 * Vault files the Second Brain must not hold — not in the index, not in
 * recall, not in /ask — because the operator said so in Memory Core.
 *
 *   Agents/<Folder>/…                     an agent set to Local only: its
 *                                         memory, its chats, its mission log
 *   Agents/<Folder>/memory/<id>.md        a memory switched Off
 *   Agents/<Folder>/memory/memories.json  every memory store: it holds the Off
 *                                         memories too, and each memory is
 *                                         indexed through its own <id>.md
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
 * Kernel module: relative requires only, takes the vault root as an argument.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FRONTMATTER_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---/;

function createScope(vaultRoot) {
  const agentsRoot = path.join(vaultRoot, 'Agents');
  const localOnly = new Map();
  const stores = new Map();

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
    const parts = String(relPosix || '').replace(/\\/g, '/').replace(/^Vault\//, '').split('/').filter(Boolean);
    if (parts[0] !== 'Agents' || parts.length < 2) return null;
    const folder = parts[1];
    if (folder.startsWith('.')) return null;
    if (isLocalOnly(folder)) return 'local-only-agent';
    if (parts.length !== 4 || parts[2] !== 'memory') return null;
    const name = parts[3];
    if (name === 'memories.json') return 'memory-store';
    if (!/\.md$/i.test(name)) return null;
    const id = name.slice(0, -3);
    const st = store(folder);
    if (st && st.all.has(id)) return st.off.has(id) ? 'memory-off' : null;
    return mirrorSaysOff(path.join(agentsRoot, folder, 'memory', name)) ? 'memory-off' : null;
  }

  return { withheld };
}

/** One-off check, for a caller with a single path. */
function withheld(vaultRoot, relPosix) {
  return createScope(vaultRoot).withheld(relPosix);
}

module.exports = { createScope, withheld };
