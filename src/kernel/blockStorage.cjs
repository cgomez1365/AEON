'use strict';

const fs = require('fs');
const path = require('path');

/**
 * The storage surface a block is allowed to have.
 *
 * BO-SHIP P2.2 (CEO decision, 2026-08-12: direct fs becomes a build-time
 * violation; blocks port to this surface).
 *
 * The original surface was six functions. Blocks make 346 filesystem calls
 * across 14 modules — existsSync, readdirSync, statSync, unlinkSync, streams —
 * none of which had an equivalent here, which is why every block reached for
 * `require('fs')` instead. A boundary nobody can work behind is a boundary
 * nobody uses.
 *
 * So `storage.fs` is an fs-SHAPED object whose every path argument is resolved
 * through getBlockDataFile(blockId, rel) and therefore confined to the block's
 * own namespace. `../outside.json` throws /escapes/ — that confinement is the
 * kernel's, already tested in storage-contract.test.js, and this surface
 * inherits it rather than reimplementing it.
 *
 * That makes porting a block a one-line change:
 *
 *     -const fs = require('fs');
 *     +const fs = deps.blockStorage.fs;
 *
 * ...instead of rewriting thirty call sites per block, which is the difference
 * between a migration that finishes and one that stalls half-done.
 *
 * Writes still require `permissions.filesystem === 'write'`. A read-only block
 * gets a surface that can read its own data and nothing else.
 */
function createBlockStorage({ blockId, contract = {}, getBlockDataFile, getBlockVaultFile, vaultSync, requestIndex }) {
  const permissions = contract.permissions || {};
  const memory = contract.memory || { mode: 'none', indexed: false, userConfigurable: false };
  const canWrite = permissions.filesystem === 'write';

  function requireWrite(op) {
    if (!canWrite) {
      throw new Error(
        `Block ${blockId} called ${op} but its manifest does not declare `
        + `permissions.filesystem: "write".`
      );
    }
  }

  function dataFile(relPath = '') {
    return getBlockDataFile(blockId, relPath);
  }

  function writeData(relPath, content) {
    requireWrite('writeData');
    const file = dataFile(relPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Write beside, then rename over: a crash or a full disk mid-write leaves
    // the previous file whole instead of a truncated one (store builder B1,
    // 2026-09-23). Same-directory rename is atomic on APFS, ext4, NTFS, exFAT.
    const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      fs.writeFileSync(tmp, content, 'utf8');
      fs.renameSync(tmp, file);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
      throw e;
    }
    return file;
  }

  function memoryFile(relPath = '') {
    if (memory.mode !== 'document') throw new Error(`Block ${blockId} did not declare document memory`);
    return getBlockVaultFile(blockId, relPath);
  }

  function writeMemoryDocument(relPath, content) {
    requireWrite('writeMemoryDocument');
    const file = memoryFile(relPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    requestIndex?.({ blockId, kind: 'document', path: relPath });
    return file;
  }

  function publishState(state) {
    requireWrite('publishState');
    if (memory.mode === 'none') throw new Error(`Block ${blockId} did not declare long-term memory`);
    vaultSync(blockId, state);
  }

  // ── The confined fs-shaped surface ─────────────────────────────────
  // Every path argument goes through dataFile(), so every one of these is
  // rooted in the block's namespace and inherits the kernel's escape check.
  const scopedFs = Object.freeze({
    // Reads
    existsSync: (rel) => {
      try { return fs.existsSync(dataFile(rel)); } catch { return false; }
    },
    readFileSync: (rel, enc = 'utf8') => fs.readFileSync(dataFile(rel), enc),
    readdirSync: (rel = '', opts) => fs.readdirSync(dataFile(rel), opts),
    statSync: (rel) => fs.statSync(dataFile(rel)),
    createReadStream: (rel, opts) => fs.createReadStream(dataFile(rel), opts),

    // Writes
    writeFileSync: (rel, data, opts) => {
      requireWrite('writeFileSync');
      const file = dataFile(rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      return fs.writeFileSync(file, data, opts ?? 'utf8');
    },
    appendFileSync: (rel, data, opts) => {
      requireWrite('appendFileSync');
      const file = dataFile(rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      return fs.appendFileSync(file, data, opts ?? 'utf8');
    },
    mkdirSync: (rel, opts) => {
      requireWrite('mkdirSync');
      return fs.mkdirSync(dataFile(rel), { recursive: true, ...(opts || {}) });
    },
    unlinkSync: (rel) => {
      requireWrite('unlinkSync');
      return fs.unlinkSync(dataFile(rel));
    },
    rmSync: (rel, opts) => {
      requireWrite('rmSync');
      return fs.rmSync(dataFile(rel), opts);
    },
    renameSync: (from, to) => {
      requireWrite('renameSync');
      return fs.renameSync(dataFile(from), dataFile(to));
    },
    createWriteStream: (rel, opts) => {
      requireWrite('createWriteStream');
      const file = dataFile(rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      return fs.createWriteStream(file, opts);
    },
  });

  // Convenience for the commonest shape in block code: read-or-default JSON.
  //
  // A file that EXISTS but will not parse used to read as the fallback, and the
  // block's next write replaced it — the operator's data gone without a word
  // (store builder B1, 2026-09-23). It is now moved aside first, named, and
  // said out loud; the block carries on from the fallback and nothing is lost.
  function readJSON(relPath, fallback = null) {
    const file = dataFile(relPath);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return fallback; }
    try { return JSON.parse(text); } catch (e) {
      // A read-only block cannot overwrite it, so it is left where it is.
      if (!canWrite) return fallback;
      const aside = `${file}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      try {
        fs.renameSync(file, aside);
        console.warn(`[BLOCK STORAGE] ${blockId}: ${relPath} could not be read (${e.message}); kept as ${path.basename(aside)} and started from empty.`);
      } catch (moveErr) {
        console.warn(`[BLOCK STORAGE] ${blockId}: ${relPath} could not be read (${e.message}) and could not be moved aside (${moveErr.message}).`);
      }
      return fallback;
    }
  }
  function writeJSON(relPath, value) {
    return writeData(relPath, JSON.stringify(value, null, 2));
  }

  return Object.freeze({
    declaration: Object.freeze({ storage: contract.storage || {}, memory }),
    blockId,
    dataFile,
    readData: (relPath, encoding = 'utf8') => fs.readFileSync(dataFile(relPath), encoding),
    writeData,
    readJSON,
    writeJSON,
    memoryFile,
    writeMemoryDocument,
    publishState,
    fs: scopedFs,
  });
}

/**
 * The same surface, rooted at an absolute directory.
 *
 * BO-SHIP P2.2. A ported block still needs somewhere to go when the host hands
 * it no blockStorage — on Vercel the only writable dir is /tmp, and a block
 * loaded outside the host (tests, tooling) has no injected deps at all.
 *
 * Without this, every ported block would keep `require('fs')` solely for its
 * fallback branch, which would leave the fs ratchet exactly where it started
 * and make the whole migration cosmetic. The confinement is the same: paths
 * resolve under `root` and `..` cannot escape it.
 */
function createRootedStorage(root, { write = true } = {}) {
  const base = path.resolve(root);
  return createBlockStorage({
    blockId: path.basename(base),
    contract: { permissions: { filesystem: write ? 'write' : 'read' } },
    getBlockDataFile: (_blockId, rel = '') => {
      const resolved = path.resolve(base, rel);
      if (resolved !== base && !resolved.startsWith(base + path.sep)) {
        throw new Error(`path escapes the ${path.basename(base)} namespace`);
      }
      return resolved;
    },
    getBlockVaultFile: (_blockId, rel = '') => path.join(base, '_vault', rel),
    vaultSync: () => {},
    requestIndex: () => {},
  });
}

module.exports = { createBlockStorage, createRootedStorage };
