'use strict';

const fs = require('fs');
const path = require('path');

function createBlockStorage({ blockId, contract = {}, getBlockDataFile, getBlockVaultFile, vaultSync, requestIndex }) {
  const permissions = contract.permissions || {};
  const memory = contract.memory || { mode: 'none', indexed: false, userConfigurable: false };
  const canWrite = permissions.filesystem === 'write';

  function requireWrite() {
    if (!canWrite) throw new Error(`Block ${blockId} did not declare filesystem write access`);
  }

  function dataFile(relPath = '') {
    return getBlockDataFile(blockId, relPath);
  }

  function writeData(relPath, content) {
    requireWrite();
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
    requireWrite();
    const file = memoryFile(relPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    requestIndex?.({ blockId, kind: 'document', path: relPath });
    return file;
  }

  function publishState(state) {
    requireWrite();
    if (memory.mode === 'none') throw new Error(`Block ${blockId} did not declare long-term memory`);
    vaultSync(blockId, state);
  }

  return Object.freeze({
    declaration: Object.freeze({ storage: contract.storage || {}, memory }),
    dataFile,
    readData: (relPath, encoding = 'utf8') => fs.readFileSync(dataFile(relPath), encoding),
    writeData,
    memoryFile,
    writeMemoryDocument,
    publishState,
  });
}

module.exports = { createBlockStorage };
