/**
 * Suite-wide path isolation. Runs BEFORE any test file is loaded.
 *
 * Several kernel and block modules resolve their storage roots at MODULE SCOPE
 * and `mkdirSync` them right there — endpoints.cjs does it for `secrets/`,
 * services/storage.js for `data/`. Merely requiring such a module creates the
 * directory inside the install. Nothing in a test needs to run for it to
 * happen.
 *
 * That is the quiet end of the rule learned expensively on 2026-08-03:
 *
 *     A test may OBSERVE a live instance. It may not PROVISION one.
 *
 * The loud end was `npm test` claiming the only operator slot and flipping
 * guardEnabled. Directories are harmless by comparison — but they are the same
 * defect, and they were invisible for the same reason: on a developer machine
 * `secrets/` and `data/` already exist, so nothing looks wrong. It only shows
 * on a bare clone inspected after a full run.
 *
 * WHY HERE AND NOT PER FILE. The first attempt set these variables at the top
 * of each offending test file. That does not work and the reason is worth
 * writing down: vitest runs many test files per worker, so whichever file
 * loaded the module FIRST has already resolved its paths. Per-file isolation
 * makes the leak depend on file ordering, which is the same class of
 * ordering-dependent luck BO-A4 removed from model auto-pick.
 *
 * `setupFiles` runs once per worker before any test module is imported, which
 * is the only place this can be correct.
 *
 * Individual tests may still override these with their own temp dirs — this is
 * a floor, not a ceiling.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-suite-'));

// Exactly the two roots that leaked, and no more. VAULT_PATH and
// AEON_WORKSPACE were in an earlier draft and are deliberately NOT set:
// storage-contract.test.js asserts real Vault path SHAPE
// (`Vault/blocks/<id>/…`), and redirecting it broke a correct test. The scope
// of a fix should match the scope of the defect.
process.env.AEON_SECRETS_DIR = path.join(root, 'secrets');
process.env.DATA_PATH = path.join(root, 'data');

for (const dir of [process.env.AEON_SECRETS_DIR, process.env.DATA_PATH]) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}
