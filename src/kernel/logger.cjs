/**
 * AEON Structured Logger — Pino-backed, console-safe.
 *
 * Why: console.log is invisible on Vercel serverless and unstructured, so prod
 * issues are undebuggable. Pino emits JSON (queryable in log aggregators) and
 * pretty-prints locally. If pino is ever absent, we degrade to console so the
 * server never crashes on a logging import.
 *
 * Usage:
 *   const log = require('./src/kernel/logger.cjs');
 *   log.info({ correlationId }, 'block loaded');
 *   log.error({ err }, 'llm dispatch failed');
 *
 * Level via AEON_LOG_LEVEL (trace|debug|info|warn|error). Pretty locally,
 * raw JSON on Vercel/production.
 */
const { isCloud: _isCloud } = require('./runtime.cjs');
let logger;
try {
  const pino = require('pino');
  const isProd = process.env.NODE_ENV === 'production' || !!_isCloud();
  logger = pino({
    level: process.env.AEON_LOG_LEVEL || 'info',
    base: { service: 'aeon-kernel', runtime: _isCloud() ? 'cloud' : 'local' },
    redact: {
      // Never log secrets even if they get passed into a log object.
      paths: [
        'req.headers.authorization', 'authorization', 'apikey', 'api_key',
        'password', 'token', 'secret', 'AEON_MOBILE_SECRET', 'AEON_VAULT_MASTER_KEY',
        'SUPABASE_SERVICE_ROLE_KEY', '*.key', '*.secret',
      ],
      censor: '[REDACTED]',
    },
    transport: isProd ? undefined : {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
    },
  });
} catch (e) {
  // Fallback: pino unavailable — shim the interface over console.
  const fmt = (lvl) => (...args) => console[lvl === 'error' || lvl === 'fatal' ? 'error' : 'log'](`[${lvl.toUpperCase()}]`, ...args);
  logger = { trace: fmt('trace'), debug: fmt('debug'), info: fmt('info'), warn: fmt('warn'), error: fmt('error'), fatal: fmt('fatal'), child: () => logger };
  logger.warn('[logger] pino unavailable, using console fallback:', e.message);
}

module.exports = logger;
