'use strict';
/**
 * One-time re-authentication tokens for actions that hand out the keys to
 * everything (the credential export: .env + keyslots = the whole vault).
 * A logged-in session is not enough for those — a session left open or
 * stolen would be. The Security block checks the password and issues a
 * token here; the guarded route consumes it. Single use, two minutes,
 * bound to one purpose. In-process only: a restart voids every token.
 */
const crypto = require('crypto');

const TTL_MS = 2 * 60 * 1000;
const _tokens = new Map(); // token -> { purpose, expires }

function issue(purpose) {
  const now = Date.now();
  for (const [t, v] of _tokens) if (v.expires <= now) _tokens.delete(t);
  const token = crypto.randomBytes(32).toString('hex');
  _tokens.set(token, { purpose, expires: now + TTL_MS });
  return token;
}

function consume(token, purpose) {
  const v = typeof token === 'string' ? _tokens.get(token) : null;
  if (!v) return false;
  _tokens.delete(token);
  return v.purpose === purpose && v.expires > Date.now();
}

module.exports = { issue, consume, TTL_MS, _reset: () => _tokens.clear() };
