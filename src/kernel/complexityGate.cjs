/**
 * B2 — deterministic complexity gate. String/AST checks against an envelope.
 * NEVER an LLM call — asking a model if something is risky makes the gate
 * exploitable. Shares CODE_CHECKS with the staging lint (one source of truth).
 *
 * Scoring (Ship Plan table):
 *   Pure CRUD, own folder, no new perms        → LOW    → auto-build
 *   Cross-block write / shared schema          → MEDIUM → single-click + perm summary
 *   Cost exceeds daily threshold               → MEDIUM → single-click + cost breakdown
 *   permissions.shell == true                  → HIGH   → full review + code diff + explicit approve
 *   requiredSecrets not in vault               → HIGH   → full review — new secret grant
 *   Code refs paths outside own block          → HIGH   → full review — sandbox escape attempt
 *
 * GAP 2 honored: LOW / MEDIUM / HIGH have three DISTINCT approval behaviors.
 */
const { scanSources, validateManifest } = require('./staging.cjs');

const DAILY_COST_THRESHOLD = Number(process.env.AEON_BUILD_DAILY_COST_LIMIT || 1.0); // USD/day

const BEHAVIORS = Object.freeze({
  LOW:    { behavior: 'auto-build',   human: false, ui: null },
  MEDIUM: { behavior: 'single-click', human: true,  ui: 'perm+cost summary' },
  HIGH:   { behavior: 'full-review',  human: true,  ui: 'perm breakdown + code diff + explicit approve' },
});

/**
 * gate(envelope, { vaultSecrets: [names present in vault] })
 * → { score, behavior, reasons[], findings[] }
 */
function gate(envelope, { vaultSecrets = [] } = {}) {
  const reasons = [];
  const m = envelope.manifest || {};
  const perms = m.contract?.permissions || {};

  // Manifest must at least be structurally sane — a malformed manifest is HIGH by definition.
  const manifestErrors = validateManifest(m);
  if (manifestErrors.length) reasons.push({ sev: 'HIGH', rule: 'manifest', why: manifestErrors.join('; ') });

  // permissions.shell == true → HIGH (Tier 3 lane)
  if (perms.shell === true) reasons.push({ sev: 'HIGH', rule: 'shell', why: 'requests shell access — Tier 3 full review' });

  // requiredSecrets not in vault → HIGH
  const required = (m.requires?.env || []).concat(m.contract?.requiredSecrets || []);
  const missing = required.filter(s => !vaultSecrets.includes(s) && !process.env[s]);
  if (missing.length) reasons.push({ sev: 'HIGH', rule: 'secrets', why: `requires secrets not in vault: ${missing.join(', ')}` });

  // Cross-block WRITE (Tier 2): filesystem write beyond own scope, or declared outputs into other blocks.
  const crossWrite =
    (perms.filesystem === 'write' && m.contract?.storage?.scope && m.contract.storage.scope !== 'block') ||
    (m.contract?.outputs || []).some(o => typeof o === 'object' && o.block && o.block !== m.id);
  if (crossWrite) reasons.push({ sev: 'MEDIUM', rule: 'cross-block-write', why: 'writes outside own block scope — Tier 2 approval' });

  // Cost threshold → MEDIUM
  if ((envelope.estimatedDailyCost || 0) > DAILY_COST_THRESHOLD) {
    reasons.push({ sev: 'MEDIUM', rule: 'cost', why: `estimated $${envelope.estimatedDailyCost}/day exceeds $${DAILY_COST_THRESHOLD}/day threshold` });
  }

  // Code checks — same engine as staging lint. Paste source gets NO shell excuse
  // even if declared (zero trust bonus): declared shell still needs the human
  // HIGH review to see it, so leave it flagged for untrusted sources.
  const declaredShell = perms.shell === true && envelope.trust !== 'untrusted';
  const findings = scanSources(envelope.files || [], { declaredShell });
  for (const f of findings) {
    if (f.sev === 'HIGH') reasons.push({ sev: 'HIGH', rule: f.check, why: `${f.file}: ${f.why}` });
    else if (f.sev === 'MEDIUM') reasons.push({ sev: 'MEDIUM', rule: f.check, why: `${f.file}: ${f.why}` });
  }

  const score = reasons.some(r => r.sev === 'HIGH') ? 'HIGH'
              : reasons.some(r => r.sev === 'MEDIUM') ? 'MEDIUM'
              : 'LOW';

  return { score, ...BEHAVIORS[score], reasons, findings };
}

module.exports = { gate, BEHAVIORS, DAILY_COST_THRESHOLD };
