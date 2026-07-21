/**
 * W5 — approval routing: admin provisioning at first block install, explicit
 * approval queue for MEDIUM/HIGH builds, 48h stale-queue fallback.
 *
 * Rules (Ship Plan v2, Month 3):
 *  - Admin is provisioned at the FIRST block install — never assumed to exist.
 *  - Solo mode: operator = approver, but approval is still an explicit click.
 *    Nothing MEDIUM/HIGH ever auto-approves because the approver is the requester.
 *  - Team mode: Tier 2/3 builds route to the admin role of this instance.
 *  - Fallback: any item pending > 48h triggers an alert to the configured
 *    backup contact (policy: src/kernel/APPROVAL_FALLBACK_POLICY.md).
 *
 * Deterministic module: no LLM, no network. Alerts are written to the queue
 * file + broadcast on the terminal stream; delivery transport is the host's
 * concern (email/webhook can subscribe to the feed later).
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');
const DB_DIR = process.env.AEON_DB_DIR || path.join(ROOT, 'db'); // env override = test isolation
const ROLES_FILE = path.join(DB_DIR, 'aeon-roles.json');
const QUEUE_FILE = path.join(DB_DIR, 'aeon-approvals.json');

const STALE_MS = Number(process.env.AEON_APPROVAL_STALE_HOURS || 48) * 3600 * 1000;

const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };
const writeJson = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2), 'utf8'); };

function getRoles() { return readJson(ROLES_FILE, { admin: null, mode: null, backupContact: null, provisionedAt: null }); }

/**
 * Called at the FIRST block install (pipeline submit). Idempotent: once an
 * admin exists this is a no-op. Solo default: the installing operator IS the
 * admin. backupContact starts null — the 48h fallback nags until it is set.
 */
function ensureAdmin(operator = 'operator') {
  const roles = getRoles();
  if (roles.admin) return { roles, provisioned: false };
  const fresh = {
    admin: operator,
    mode: 'solo',                    // flips to 'team' when a second user role is added
    backupContact: roles.backupContact || process.env.AEON_BACKUP_CONTACT || null, // OWNER DECISION — see APPROVAL_FALLBACK_POLICY.md
    provisionedAt: new Date().toISOString(),
  };
  writeJson(ROLES_FILE, fresh);
  return { roles: fresh, provisioned: true };
}

function setBackupContact(contact) {
  const roles = getRoles();
  roles.backupContact = contact || null;
  writeJson(ROLES_FILE, roles);
  return roles;
}

function loadQueue() { return readJson(QUEUE_FILE, { items: [], alerts: [] }); }

/**
 * Queue a MEDIUM (single-click) or HIGH (full-review) build for the admin.
 * The stored item carries everything the approval UI needs to render the
 * distinct behavior (GAP 2): perm summary for MEDIUM, full diff for HIGH.
 */
function enqueue({ blockId, score, behavior, reasons = [], source, trust, spec, files = [], manifest }) {
  const q = loadQueue();
  const roles = getRoles();
  const item = {
    id: `APR-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    blockId, score, behavior, reasons, source, trust,
    spec: (spec || '').slice(0, 2000),
    // HIGH gets the full code diff; MEDIUM only needs the perm/cost summary.
    diff: score === 'HIGH' ? files.map(f => ({ path: f.path, content: f.content })) : undefined,
    permissions: manifest?.contract?.permissions || {},
    status: 'pending',
    routedTo: roles.admin || 'operator',
    createdAt: new Date().toISOString(),
    decidedAt: null, decidedBy: null, decisionNote: null,
  };
  q.items.unshift(item);
  writeJson(QUEUE_FILE, q);
  try { global.broadcastTerminalEvent?.('APPROVAL', `[${score}] build "${blockId}" queued for ${item.routedTo} (${behavior})`); } catch {}
  return item;
}

function getItem(id) { return loadQueue().items.find(i => i.id === id) || null; }
function list(status) {
  const q = loadQueue();
  return status ? q.items.filter(i => i.status === status) : q.items;
}

/** Explicit click — never called by any automated path (B5 discipline). */
function decide(id, decision, { approver = 'operator', note = null } = {}) {
  if (!['approved', 'rejected'].includes(decision)) return { ok: false, error: `invalid decision "${decision}"` };
  const q = loadQueue();
  const item = q.items.find(i => i.id === id);
  if (!item) return { ok: false, error: `approval ${id} not found` };
  if (item.status !== 'pending') return { ok: false, error: `approval ${id} already ${item.status}` };
  item.status = decision;
  item.decidedAt = new Date().toISOString();
  item.decidedBy = approver;
  item.decisionNote = note;
  writeJson(QUEUE_FILE, q);
  try { global.broadcastTerminalEvent?.('APPROVAL', `${decision.toUpperCase()}: "${item.blockId}" by ${approver}`); } catch {}
  return { ok: true, item };
}

/**
 * 48h fallback (W5). Any pending item older than STALE_MS raises one alert
 * (deduped per item) addressed to the backup contact; if none is configured
 * the alert says so explicitly — a stuck queue with no resolution path is a
 * production incident, so the missing contact is itself alertable.
 */
function checkStaleQueue(now = Date.now()) {
  const q = loadQueue();
  const roles = getRoles();
  const fresh = [];
  for (const item of q.items) {
    if (item.status !== 'pending') continue;
    if (now - Date.parse(item.createdAt) < STALE_MS) continue;
    if (q.alerts.some(a => a.approvalId === item.id)) continue; // already alerted
    const alert = {
      approvalId: item.id,
      blockId: item.blockId,
      contact: roles.backupContact || null,
      message: roles.backupContact
        ? `Approval "${item.blockId}" pending >48h — admin "${roles.admin}" unreachable? Escalated to ${roles.backupContact}.`
        : `Approval "${item.blockId}" pending >48h and NO backup contact configured — set one via /api/build/roles/backup-contact.`,
      raisedAt: new Date(now).toISOString(),
    };
    q.alerts.unshift(alert);
    fresh.push(alert);
    try { global.broadcastTerminalEvent?.('APPROVAL-ESCALATION', alert.message); } catch {}
  }
  if (fresh.length) writeJson(QUEUE_FILE, q);
  return { checked: q.items.filter(i => i.status === 'pending').length, escalated: fresh };
}

module.exports = { ensureAdmin, getRoles, setBackupContact, enqueue, getItem, list, decide, checkStaleQueue, STALE_MS, QUEUE_FILE, ROLES_FILE };
