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
 * REFUSE deliberately does not exit the process. The recovery slot is what
 * restores access, and the operator needs the server up to use it. Sealing the
 * vault while staying reachable is the fail-closed behaviour; exiting would
 * lock them out of their own recovery path.
 */

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

/** The operator-facing text for REFUSE. Names the cause and the way out. */
function sealedMessage() {
  const bar = '='.repeat(64);
  return (
    `\n${bar}\n` +
    `[VAULT] SEALED — an existing vault was found with no master key.\n\n` +
    `        secrets/aeon-keyslots.json exists, but AEON_VAULT_MASTER_KEY is\n` +
    `        missing from .env. These are two halves of one key: move both or\n` +
    `        neither. A new key was NOT generated, because generating one\n` +
    `        cannot open this vault and would only hide the problem.\n\n` +
    `        To restore access, use your recovery code. It was printed once,\n` +
    `        when the vault was created.\n\n` +
    `        If you still have the original .env, restore it and reboot.\n` +
    `${bar}\n`
  );
}

module.exports = { decideKeyGuard, sealedMessage, MINT, REFUSE, SKIP };
