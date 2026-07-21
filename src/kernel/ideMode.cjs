/**
 * B7 — IDE mode: the Tier 3 state switch (shell / kernel-self-edit).
 *
 * Rules (Ship Plan v2, Month 3):
 *  - Explicit state change only: a human POSTs the toggle. Never an implicit
 *    upgrade because a model decided the user "probably wants" deeper access.
 *  - Visible: state is exposed in /core/state and /api/build/ide-mode so the
 *    UI can render the "KERNEL IS NOW EDITABLE" banner whenever active.
 *  - Separate audit channel: everything Tier 3 logs to db/ide_audit.log —
 *    its own file, not mixed into the general audit stream.
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');
const DB_DIR = process.env.AEON_DB_DIR || path.join(ROOT, 'db'); // env override = test isolation
const STATE_FILE = path.join(DB_DIR, 'aeon-ide-mode.json');
const AUDIT_LOG = path.join(DB_DIR, 'ide_audit.log');

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { active: false, changedAt: null, changedBy: null }; } };

function isActive() { return readState().active === true; }
function status() { return { ...readState(), banner: isActive() ? 'KERNEL IS NOW EDITABLE — IDE MODE (Tier 3) ACTIVE' : null }; }

/** Separate Tier 3 audit channel. Append-only. */
function audit(line) {
  fs.mkdirSync(path.dirname(AUDIT_LOG), { recursive: true });
  fs.appendFileSync(AUDIT_LOG, `${new Date().toISOString()} ${line}\n`, 'utf8');
}

/** Explicit toggle — the ONLY way IDE mode changes. */
function setActive(active, { operator = 'operator' } = {}) {
  const state = { active: active === true, changedAt: new Date().toISOString(), changedBy: operator };
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  audit(`IDE MODE ${state.active ? 'ENABLED' : 'DISABLED'} by ${operator}`);
  try { global.broadcastTerminalEvent?.('IDE-MODE', state.active ? '⚠ KERNEL IS NOW EDITABLE — IDE mode ON' : 'IDE mode OFF — kernel locked'); } catch {}
  return status();
}

function readAudit(lines = 100) {
  try { return fs.readFileSync(AUDIT_LOG, 'utf8').trim().split('\n').slice(-lines); } catch { return []; }
}

module.exports = { isActive, status, setActive, audit, readAudit, AUDIT_LOG, STATE_FILE };
