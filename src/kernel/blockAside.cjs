/**
 * Moving a block's folder aside — never deleting it.
 *
 * Shared by the lifecycle routes (routers/build.cjs: uninstall / restore) and
 * the store's update (store.cjs updateFromStore), so "moved aside" means the
 * same place and the same folder name everywhere: <data>/removed-blocks/<id>@<time>.
 */
const fs = require('fs');
const path = require('path');

function defaultRemovedDir() {
  return path.join(require('./aeonHome.cjs').roots({ appRoot: path.join(__dirname, '..', '..') }).data, 'removed-blocks');
}

/** rename, or copy + remove across devices (a carried drive, another volume). */
function moveDir(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try { fs.renameSync(from, to); }
  catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

const asideName = (id, tag = '') => `${id}${tag}@${new Date().toISOString().replace(/[:.]/g, '-')}`;

module.exports = { defaultRemovedDir, moveDir, asideName };
