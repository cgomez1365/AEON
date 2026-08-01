'use strict';
/**
 * Single authority for the address AEON listens on.
 *
 * AEON binds LOOPBACK BY DEFAULT, in every mode.
 *
 * The reasoning was already written for portable installs and is identical for
 * a consumer desktop: the machine is often on a network its owner does not
 * control, and — critically — a fresh install has no operator account yet, so
 * the session guard is not armed (guardActive() requires hasAccount()). A
 * default of 0.0.0.0 published the whole kernel and block surface, God Mode
 * included, to the LAN for the entire first-run window.
 *
 * Serving a LAN is a deliberate act, so it takes a deliberate env var.
 * `AEON_BIND=0.0.0.0` is the opt-out. Nothing else widens the bind.
 */

/** Addresses that reach only this machine. */
const LOOPBACK = Object.freeze(new Set(['127.0.0.1', '::1', 'localhost', '0:0:0:0:0:0:0:1']));

/**
 * Resolve the listen address.
 * @param {object} [env] - defaults to process.env
 * @returns {string}
 */
function resolveBind(env = process.env) {
  const explicit = String(env.AEON_BIND == null ? '' : env.AEON_BIND).trim();
  return explicit || '127.0.0.1';
}

/**
 * Does this address reach only the local machine?
 * IPv4 loopback is the whole 127.0.0.0/8 block, not just 127.0.0.1.
 */
function isLoopback(addr) {
  const a = String(addr == null ? '' : addr).trim().toLowerCase();
  if (LOOPBACK.has(a)) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

/** True when this process is reachable from outside the machine. */
function isExposed(env = process.env) {
  return !isLoopback(resolveBind(env));
}

module.exports = { resolveBind, isLoopback, isExposed, LOOPBACK };
