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
    fs.writeFileSync(file, content, 'utf8');
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
  function readJSON(relPath, fallback = null) {
    try { return JSON.parse(fs.readFileSync(dataFile(relPath), 'utf8')); } catch { return fallback; }
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

module.exports = { createBlockStorage };
