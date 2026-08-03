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
const { isCloud: _isCloud } = require('../src/kernel/runtime.cjs');

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

  // Is this request from the machine AEON is running on?
  //
  // Read the SOCKET, never the Host header. Host: is a string the client sends —
  // anyone who can reach the port can claim `Host: localhost` and be trusted.
  // req.ip reflects the actual peer. This is a signal about origin, not proof of
  // identity: a malicious local process, a compromised browser tab, or an
  // exposed dev proxy are all 127.0.0.1. Never let it stand in for a session.
  const isLoopbackRequest = (req) => {
    const ip = req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || '';
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  };

  // ── Tunnel gate: AEON_MOBILE_SECRET on non-local /api ──
  const tunnelGate = (req, res, next) => {
    if (isLoopbackRequest(req) || _isCloud()) {
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

  // ── Gate for privileged OS endpoints ──
  //
  // This function's own comment used to promise "no localhost bypass,
  // fail-closed" — ten lines above the line that returned next() for every
  // loopback caller. Both halves were wrong: the comment was false, and a
  // shared secret is not a user session anyway.
  //
  // Now: a valid operator session is required from every origin. Loopback earns
  // no exemption. AEON_MOBILE_SECRET remains accepted for remote/tunnel callers
  // that have no browser session, and remains fail-closed when unset.
  const requireShellAuth = (req, res, next) => {
    // Required lazily: sessionValidator resolves its secrets dir at module load,
    // and tests set AEON_SECRETS_DIR before requiring. Loading it at the top of
    // security.js would pin the wrong path.
    let sessionOk = false;
    try {
      const sessions = require('../src/kernel/server-utils/sessionValidator.cjs');
      sessionOk = !!sessions.validateSession(req)?.ok;
    } catch { sessionOk = false; }
    if (sessionOk) return next();

    const mobileSecret = process.env.AEON_MOBILE_SECRET;
    if (!mobileSecret) {
      console.warn('[SECURITY] Privileged OS endpoint blocked: no session and AEON_MOBILE_SECRET not configured (fail-closed).');
      return res.status(503).json({
        correlation_id: req.correlationId || 'AEON-SYS',
        error: 'OS endpoints disabled: sign in, or configure AEON_MOBILE_SECRET for headless access.'
      });
    }
    const authHeader = req.headers.authorization || '';
    if (authHeader !== `Bearer ${mobileSecret}`) {
      console.warn(`[SECURITY] Unauthorized OS access attempt on ${req.path} from ${req.ip}.`);
      return res.status(401).json({
        correlation_id: req.correlationId || 'AEON-SYS',
        error: 'Unauthorized: an operator session or a valid Bearer token is required.'
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

  const USER_HOME = process.env.USERPROFILE || process.env.HOME || ''; // aeon-path-authority-allow
  const ALLOWED_ROOTS = [
    USER_HOME,
    WORKSPACE,
    path.join(USER_HOME, 'Desktop'),
    'C:\\Program Files' // aeon-path-authority-allow
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
