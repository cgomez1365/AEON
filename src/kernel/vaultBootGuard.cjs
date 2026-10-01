/**
 * The first-run vault key decision, as a pure function.
 *
 * Audit 2026-08-11 P0-01: server.js minted a fresh AEON_VAULT_MASTER_KEY
 * whenever the env key was absent — including when keyslots already existed.
 * The DEK is wrapped under a protector derived from the OLD key, so the new key
 * unwraps nothing; ensureKeyslots() then returns 'exists' and changes nothing.
 * The operator saw "[FIRST RUN] Vault master key generated" at the moment their
 * vault stopped opening.
 *
 * The decision lived inline at module scope in server.js, which meant it could
 * only be exercised by booting a real server on a real port. That is why it was
 * never tested. It is a function here so the three cases are assertable.
 *
 *   MINT   no keyslots, no env key  -> genuine first run; generate and persist
 *   REFUSE keyslots, no env key     -> two halves of one key; one is missing
 *   SKIP   env key present, or cloud -> nothing to do
 *
 * REFUSE deliberately does not exit the process. Sealing the vault while
 * staying reachable is the fail-closed behaviour: everything that does not
 * need a stored key still works.
 *
 * The recovery code is entered in launch.js (vaultKeyPlan / recoverVault),
 * which calls vault.recoverWithCode: during a desktop launch, or on its own as
 * `node launch.js --recover-vault`. The second form is the one every layout
 * has — the carried drive's and USB builds' launchers run `node server.cjs`,
 * never launch.js — so this message names it, with this install's own folder
 * and Node. Until 2026-09-30 it pointed at the code while no route, command
 * or screen could accept it (A017).
 */

const path = require('path');

const MINT = 'mint';
const REFUSE = 'refuse';
const SKIP = 'skip';

/**
 * @param {object} s
 * @param {boolean} s.isCloud       Vercel/read-only FS — keys come from env.
 * @param {boolean} s.hasEnvKey     AEON_VAULT_MASTER_KEY is set.
 * @param {boolean} s.hasKeyslots   secrets/aeon-keyslots.json exists.
 * @returns {'mint'|'refuse'|'skip'}
 */
function decideKeyGuard({ isCloud, hasEnvKey, hasKeyslots }) {
  if (isCloud) return SKIP;
  if (hasEnvKey) return SKIP;
  return hasKeyslots ? REFUSE : MINT;
}

/**
 * The operator-facing text for REFUSE. Names the cause and the way out.
 * appRoot/execPath default to this install and the Node running it, so the
 * command it prints runs as written wherever AEON was started from.
 */
function sealedMessage({ appRoot = path.join(__dirname, '..', '..'), execPath = process.execPath } = {}) {
  const bar = '='.repeat(64);
  return (
    `\n${bar}\n` +
    `[VAULT] SEALED — an existing vault was found with no master key.\n\n` +
    `        secrets/aeon-keyslots.json exists, but AEON_VAULT_MASTER_KEY is\n` +
    `        missing from .env. These are two halves of one key: move both or\n` +
    `        neither. A new key was NOT generated, because generating one\n` +
    `        cannot open this vault and would only hide the problem.\n\n` +
    `        If you still have the original .env, restore it and restart AEON.\n\n` +
    `        If you saved the recovery code shown when the vault was created,\n` +
    `        run this in a terminal, in the AEON app folder\n` +
    `        (${appRoot}),\n` +
    `        and paste the code when it asks:\n\n` +
    `            node launch.js --recover-vault\n\n` +
    `        If \`node\` is not found, run it with this AEON's own Node.js in\n` +
    `        its place: ${execPath}\n` +
    `        It reopens the vault and writes a new key to .env; then restart\n` +
    `        AEON. (The desktop install's LAUNCH.bat, launch.command and\n` +
    `        launch.sh also ask for the code when they start.)\n\n` +
    `        Without the original .env or the code, the keys stored in this\n` +
    `        vault cannot be read.\n` +
    `${bar}\n`
  );
}

module.exports = { decideKeyGuard, sealedMessage, MINT, REFUSE, SKIP };
