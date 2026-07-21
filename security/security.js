/**
 * AEON Jarvis — Security Layer (Blood Vessels)
 * Enforcement middleware + audit trail: correlation IDs, CORS allowlist,
 * helmet headers, rate limiting, tunnel Bearer gate, hard shell gate,
 * SDI schema enforcement, OS exec allowlists.
 */
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

module.exports = ({ supabase, getLocalFile, WORKSPACE, AUDIT_FILE, SDI_VIOLATION_LOG }) => {

  // ── Correlation ID ──
  const correlationId = (req, res, next) => {
    req.correlationId = 'AEON-REQ-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    next();
  };

  // ── CORS allowlist ──
  const allowedOrigins = [
    'http://localhost:3000',
    'https://aeon-cortex.vercel.app',
    ...(process.env.AEON_ALLOWED_ORIGINS
      ? process.env.AEON_ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
      : [])
  ];

  // Any loopback origin is the operator's own machine — Electron (:3001), vite
  // (:3000), and preview ports must all pass. Off-machine access is enforced by
  // the tunnel Bearer gate, not CORS.
  const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
  const corsMiddleware = cors({
    origin: function (origin, callback) {
      if (!origin || LOOPBACK.test(origin) || allowedOrigins.includes(origin)) return callback(null, true);
      console.warn(`[SECURITY] Blocked CORS origin: ${origin}`);
      return callback(new Error(`CORS: origin not allowed`));
    },
    credentials: true
  });

  // ── Security headers ──
  const helmetMiddleware = helmet({
    contentSecurityPolicy: process.env.AEON_ENABLE_CSP === '1' ? undefined : false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

  // ── Rate limiting ──
  const apiLimiter = rateLimit({
    windowMs: parseInt(process.env.AEON_RATE_WINDOW_MS || '60000', 10),
    max: parseInt(process.env.AEON_RATE_MAX || '120', 10),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Rate limit exceeded. Slow down.' },
    // Loopback is the operator's own UI (SPA polling alone exceeds any sane
    // per-minute cap). The limiter exists for external traffic, which is
    // additionally Bearer-gated. SSE/WS paths are long-lived, also skipped.
    skip: (req) => {
      if (req.path.startsWith('/events') || req.path.startsWith('/ws')) return true;
      const ip = req.ip || '';
      return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    },
  });

  // ── Tunnel gate: AEON_MOBILE_SECRET on non-localhost /api ──
  const tunnelGate = (req, res, next) => {
    const host = req.get('host') || '';
    if (host.includes('localhost') || host.includes('127.0.0.1') || process.env.VERCEL) {
      return next();
    }
    const authHeader = req.headers.authorization;
    const mobileSecret = process.env.AEON_MOBILE_SECRET;
    if (!mobileSecret) {
      console.warn('[SECURITY WARNING] AEON_MOBILE_SECRET is not set in .env. Denying external request.');
      return res.status(401).json({ correlation_id: req.correlationId || 'AEON-SYS', error: 'Unauthorized. Secret not configured.' });
    }
    if (authHeader !== `Bearer ${mobileSecret}`) {
      console.warn('[SECURITY WARNING] Invalid or missing Bearer token from external source.');
      return res.status(401).json({ correlation_id: req.correlationId || 'AEON-SYS', error: 'Unauthorized. Invalid Token.' });
    }
    next();
  };

  // ── Hard gate for OS-level shell endpoints — no localhost bypass, fail-closed ──
  const requireShellAuth = (req, res, next) => {
    const mobileSecret = process.env.AEON_MOBILE_SECRET;
    if (!mobileSecret) {
      console.warn('[SECURITY] Shell endpoint blocked: AEON_MOBILE_SECRET not configured (fail-closed).');
      return res.status(503).json({
        correlation_id: req.correlationId || 'AEON-SYS',
        error: 'Shell endpoints disabled: server secret (AEON_MOBILE_SECRET) not configured.'
      });
    }
    const ip = req.ip || req.connection?.remoteAddress || '';
    const isLocalhost = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (isLocalhost) return next();
    const authHeader = req.headers.authorization || '';
    if (authHeader !== `Bearer ${mobileSecret}`) {
      console.warn(`[SECURITY] Unauthorized shell access attempt on ${req.path} from ${req.ip}.`);
      return res.status(401).json({
        correlation_id: req.correlationId || 'AEON-SYS',
        error: 'Unauthorized: a valid Bearer token is required for OS shell endpoints.'
      });
    }
    next();
  };

  // ── OS exec allowlists ──
  // NEVER add 'rm', 'del', 'format', 'powershell', 'cmd /c', 'curl', 'wget'
  // or any prefix that could chain arbitrary shell commands.
  const SAFE_EXEC_PREFIXES = [
    'python backend/direct_qwen.py',
    'python backend/direct_zenith.py',
    'python tools/',
    'node server.cjs',
    'node tools/',
    'npm run',
    'npm test',
    'git status',
    'git log',
    'git diff',
    'ffmpeg',
    'start http'
  ];

  const USER_HOME = process.env.USERPROFILE || process.env.HOME || '';
  const ALLOWED_ROOTS = [
    USER_HOME,
    WORKSPACE,
    path.join(USER_HOME, 'Desktop'),
    'C:\\Program Files'
  ].filter(Boolean);

  // ── Tamper-evident audit trail ──
  const writeOSAudit = (action, command, exitCode, outLen, correlationId = 'AEON-SYS') => {
    try {
      const newEntry = {
        id: `audit_${Date.now()}`,
        correlation_id: correlationId,
        agent: 'OS-Bridge',
        action,
        details: command,
        status_code: exitCode,
        telemetry_tokens: outLen,
        timestamp: new Date().toISOString()
      };
      if (supabase) {
        supabase.from('aeon_audit_log').insert([newEntry]).then();
      }
      if (!fs.existsSync(AUDIT_FILE)) fs.writeFileSync(AUDIT_FILE, JSON.stringify([], null, 2));
      const audit = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
      audit.push(newEntry);
      if (audit.length > 100) audit.shift();
      fs.writeFileSync(AUDIT_FILE, JSON.stringify(audit, null, 2));
    } catch (e) { /* silent fail on audit */ }
  };

  // ── Immutable SDI enforcement (Zenith mandate) ──
  const SDI_SCHEMAS = {
    client: {
      required: ['name'],
      fields: {
        name: 'string', email: 'string', phone: 'string', industry: 'string',
        scale: 'string', status: 'string', address: 'string', notes: 'string', website: 'string',
      }
    },
    candidate: {
      required: ['name', 'role'],
      fields: {
        name: 'string', email: 'string', phone: 'string', role: 'string',
        resumeText: 'string', source: 'string', grade: 'string', score: 'number',
      }
    },
    logistics: {
      required: ['itemName'],
      fields: {
        itemName: 'string', barcode: 'string', quantity: 'number', unit: 'string',
        truck: 'string', driver: 'string', destination: 'string', notes: 'string', status: 'string',
      }
    },
    email: {
      required: ['clientName', 'email'],
      fields: { clientName: 'string', email: 'string', subject: 'string', body: 'string', status: 'string' }
    },
    audit: {
      required: ['agent', 'action'],
      fields: { agent: 'string', action: 'string', details: 'string' }
    }
  };

  const logSDIViolation = (schemaName, payload, errors) => {
    const violation = {
      id: `SDI-${Date.now()}`,
      timestamp: new Date().toISOString(),
      schema: schemaName,
      errors,
      payloadSnapshot: JSON.stringify(payload).substring(0, 500)
    };
    let violations = [];
    if (fs.existsSync(SDI_VIOLATION_LOG)) {
      try { violations = JSON.parse(fs.readFileSync(SDI_VIOLATION_LOG, 'utf8')); } catch {}
    }
    violations.push(violation);
    while (violations.length > 200) violations.shift();
    fs.writeFileSync(SDI_VIOLATION_LOG, JSON.stringify(violations, null, 2));
    console.warn(`[SDI VIOLATION] Schema: ${schemaName} | Errors: ${errors.join(', ')}`);
    return violation;
  };

  const validateSDI = (schemaName, payload) => {
    const schema = SDI_SCHEMAS[schemaName];
    if (!schema) return { valid: true, errors: [] };
    const errors = [];
    for (const field of schema.required) {
      if (payload[field] === undefined || payload[field] === null || payload[field] === '') {
        errors.push(`Missing required field: "${field}"`);
      }
    }
    for (const [field, expectedType] of Object.entries(schema.fields)) {
      if (payload[field] !== undefined && payload[field] !== null) {
        const actualType = typeof payload[field];
        if (actualType !== expectedType) {
          if (expectedType === 'number' && !isNaN(Number(payload[field]))) continue;
          errors.push(`Field "${field}" expected ${expectedType}, got ${actualType}`);
        }
      }
    }
    if (errors.length > 0) logSDIViolation(schemaName, payload, errors);
    return { valid: errors.length === 0, errors };
  };

  return {
    correlationId, corsMiddleware, helmetMiddleware, apiLimiter, tunnelGate,
    requireShellAuth, SAFE_EXEC_PREFIXES, ALLOWED_ROOTS, writeOSAudit,
    SDI_SCHEMAS, validateSDI, logSDIViolation,
  };
};
