/**
 * B4 — the full build pipeline, wired end to end:
 *
 *   envelope (B1) → complexity gate (B2) → staging/ write (K5) → lint
 *     → LOW    : auto-promote → kernel.rescan() → live
 *     → MEDIUM : approval queue (single-click + perm summary)   [W5]
 *     → HIGH   : approval queue (full review + code diff)       [W5]
 *   approve → promote (fail-closed lint re-run) → rescan → live
 *   reject  → stays in staging/ for a human turn
 *
 * B5 — failure discipline: any lint/promote failure REPORTS and STOPS.
 * There is no retry loop anywhere in this file, by design. Failure is a
 * human turn, not a model loop.
 *
 * Tier 3 rule (B7): approving a build that declares shell access requires
 * IDE mode to be ON — a deliberate, visible mode switch — and the decision
 * is logged to the separate IDE audit channel.
 */
const path = require('path');
const fs = require('fs');
const { normalize } = require('./buildEnvelope.cjs');
const { gate } = require('./complexityGate.cjs');
const { bootProof } = require('./bootProof.cjs');
const { lintBlock, promoteBlock, ensureStagingDir, validateManifest, scanSources, detectCircularImports, STAGING_DIR, BLOCKS_DIR } = require('./staging.cjs');
const approvals = require('./approvals.cjs');
const ideMode = require('./ideMode.cjs');
const runState = require('./runState.cjs');

/** Write the envelope's proposed block into staging/<id>. Fails if the id is taken. */
function stageEnvelope(envelope) {
  const id = envelope.manifest?.id;
  if (!id || !/^[a-z0-9_]+$/.test(id)) return { ok: false, error: `invalid block id "${id}"` };
  ensureStagingDir();
  const dir = path.join(STAGING_DIR, id);
  if (fs.existsSync(dir)) return { ok: false, error: `staging/${id} already exists — decide or remove the previous attempt first (no silent overwrite)` };
  if (fs.existsSync(path.join(BLOCKS_DIR, id))) return { ok: false, error: `src/blocks/${id} already live — bump version and use the update flow` };

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'block.manifest.json'), JSON.stringify(envelope.manifest, null, 2), 'utf8');
  for (const f of envelope.files) {
    const dest = path.resolve(dir, f.path);
    if (!dest.startsWith(path.resolve(dir) + path.sep)) return { ok: false, error: `file path escapes staging: ${f.path}` };
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.content, 'utf8');
  }
  return { ok: true, dir, id };
}

function createBuildPipeline({
  getVaultSecrets = async () => [],
  rescan = () => ({ ok: false, error: 'no rescan hook' }),
  // Master M3 — the live route surface, so a staged block can be refused for
  // colliding before it is promoted rather than after.
  getLiveRoutes = () => [],
} = {}) {

  /**
   * Master M2 — run every gate against an in-memory envelope and write nothing.
   *
   * submitBuild() stages before it lints, and stageEnvelope() refuses an id
   * that already exists in staging/ or src/blocks/ (deliberately — no silent
   * overwrite). That is correct for a submit and useless for a check: an
   * operator who wants to know whether their block passes should not have to
   * create a staging directory, then remove it by hand, to find out.
   *
   * Same functions, same verdicts, no disk. If this says clean, submitBuild
   * reaches at least the staging step; the checks it cannot run without files
   * on disk are named in `notChecked` rather than silently skipped.
   */
  async function validateBuild(source, payload) {
    let envelope;
    try { envelope = normalize(source, payload); }
    catch (e) { return { ok: false, stage: 'envelope', error: e.message }; }

    const manifest = envelope.manifest || {};
    const id = manifest.id;

    const errors = [...validateManifest(manifest)];

    // lintBlock() checks these against a directory; do the same against the
    // envelope so a check and a submit cannot disagree about the same block.
    if (id && !envelope.files.some((f) => f.path === 'index.jsx')) errors.push('missing index.jsx');
    if (id && manifest.api_routes && !envelope.files.some((f) => /^api\//.test(f.path))) {
      errors.push('api_routes is true but no api/ file is present');
    }

    const declaredShell = manifest.contract?.permissions?.shell === true;
    const findings = [...scanSources(envelope.files, { declaredShell })];
    for (const cycle of detectCircularImports(envelope.files)) {
      findings.push({ check: 'circular-import', sev: 'HIGH', file: cycle.split(' → ')[0], why: `circular import: ${cycle}` });
    }

    // Collisions are a refusal at submit time, so report them at check time.
    const collisions = [];
    if (id) {
      if (fs.existsSync(path.join(STAGING_DIR, id))) {
        collisions.push(`staging/${id} already exists — decide or remove the previous attempt first`);
      }
      if (fs.existsSync(path.join(BLOCKS_DIR, id))) {
        collisions.push(`src/blocks/${id} is already live — bump version and use the update flow`);
      }
    }

    let vaultSecrets = [];
    try { vaultSecrets = await getVaultSecrets(); } catch {}
    const verdict = gate(envelope, { vaultSecrets });

    const hasHigh = findings.some((f) => f.sev === 'HIGH');
    const hasMed = findings.some((f) => f.sev === 'MEDIUM');
    const score = errors.length || hasHigh ? 'HIGH' : hasMed ? 'MEDIUM' : 'LOW';

    return {
      ok: true,
      wouldPass: errors.length === 0 && !hasHigh && collisions.length === 0,
      score,
      errors,
      findings,
      collisions,
      verdict,
      blockId: id || null,
      // §08 — a check that quietly covers less than the real gate is worse than
      // no check. Name what only exists once files are on disk.
      notChecked: ['staged boot', 'route collision against the live registry'],
    };
  }

  /** The single entry point for all four build sources. */
  async function submitBuild(source, payload, { operator = 'operator' } = {}) {
    // W5 — admin provisioned at FIRST block install, never assumed.
    const { provisioned } = approvals.ensureAdmin(operator);

    let envelope;
    try { envelope = normalize(source, payload); }
    catch (e) { return { ok: false, stage: 'envelope', error: e.message }; }

    let vaultSecrets = [];
    try { vaultSecrets = await getVaultSecrets(); } catch {}
    const verdict = gate(envelope, { vaultSecrets });

    const staged = stageEnvelope(envelope);
    if (!staged.ok) return { ok: false, stage: 'staging', error: staged.error, verdict };

    // Lint the on-disk staged block (adds structure + circular-import checks).
    const lint = lintBlock(staged.dir);
    if (lint.errors.length) {
      // B5: report + stop. Block stays in staging/ for a human to fix. NO retry.
      return { ok: false, stage: 'lint', error: 'lint failed — block stays in staging/', lint, verdict, blockId: staged.id };
    }

    // Master M3 — every gate above this line READS. This one runs the block:
    // mounts it through the real block host, calls the routes its manifest
    // declares, and reports what answered. It is sequenced after lint and the
    // complexity gate on purpose — those refuse shell, eval, path traversal
    // and secret reads, so what executes here has already been judged on what
    // it may do.
    //
    // A block that cannot boot never reaches the approval queue. Approving
    // something that has never run is how "checked for manifest shape but not
    // for booting" became true of 24 store packs.
    let boot;
    try {
      boot = await bootProof(STAGING_DIR, staged.id, { liveRoutes: getLiveRoutes() });
    } catch (e) {
      boot = { ok: false, errors: [`boot proof could not run: ${e.message}`] };
    }
    if (!boot.ok) {
      return {
        ok: false, stage: 'boot',
        error: boot.environmentError
          ? 'boot proof could not run — the block was not judged'
          : 'staged block did not boot — it stays in staging/',
        boot, lint, verdict, blockId: staged.id,
      };
    }

    if (verdict.score === 'LOW') {
      const promo = promoteBlock(staged.id);
      if (!promo.ok) return { ok: false, stage: 'promote', error: promo.error, lint: promo.lint, verdict, blockId: staged.id };
      // Interruption mode: every self-built block lands live-but-STOPPED.
      // Mounted code the operator hasn't started never handles a request.
      runState.registerManual(staged.id, { by: `pipeline:${envelope.source}` });
      const scan = rescan(`build:${staged.id}`);
      return { ok: true, stage: 'live', blockId: staged.id, verdict, boot, promoted: true, rescan: scan, adminProvisioned: provisioned,
               runState: 'stopped', note: `manual-start block — POST /api/build/blocks/${staged.id}/start to begin serving` };
    }

    // MEDIUM / HIGH → human queue (W5). Distinct behaviors carried on the item (GAP 2).
    const item = approvals.enqueue({
      blockId: staged.id,
      score: verdict.score,
      behavior: verdict.behavior,
      reasons: verdict.reasons,
      source: envelope.source,
      trust: envelope.trust,
      spec: envelope.spec,
      files: envelope.files,
      manifest: envelope.manifest,
    });
    return { ok: true, stage: 'queued', blockId: staged.id, verdict, boot, approval: item, adminProvisioned: provisioned };
  }

  /** Explicit human click. Approve = promote → rescan → live. */
  function approveBuild(approvalId, { approver = 'operator', note } = {}) {
    const item = approvals.getItem(approvalId);
    if (!item) return { ok: false, error: `approval ${approvalId} not found` };
    if (item.status !== 'pending') return { ok: false, error: `approval already ${item.status}` };

    // B7 — Tier 3 (shell) requires the deliberate IDE mode switch, never implicit.
    if (item.permissions?.shell === true) {
      if (!ideMode.isActive()) {
        return { ok: false, error: 'Tier 3 build (shell access): enable IDE mode first — POST /api/build/ide-mode {"active":true}', tier3: true };
      }
      ideMode.audit(`TIER3 APPROVAL by ${approver}: block "${item.blockId}" (shell access) — approval ${approvalId}`);
    }

    const decision = approvals.decide(approvalId, 'approved', { approver, note });
    if (!decision.ok) return decision;

    const promo = promoteBlock(item.blockId);
    if (!promo.ok) {
      // Approval given but the airlock still fails closed (e.g. undeclared HIGH
      // finding) — human approval does NOT override the lint gate. Report, stop.
      return { ok: false, stage: 'promote', error: promo.error, lint: promo.lint, approval: decision.item };
    }
    runState.registerManual(item.blockId, { by: `pipeline:approved` });
    const scan = rescan(`approve:${item.blockId}`);
    return { ok: true, stage: 'live', blockId: item.blockId, approval: decision.item, rescan: scan,
             runState: 'stopped', note: `manual-start block — POST /api/build/blocks/${item.blockId}/start to begin serving` };
  }

  function rejectBuild(approvalId, { approver = 'operator', note } = {}) {
    const decision = approvals.decide(approvalId, 'rejected', { approver, note });
    if (!decision.ok) return decision;
    // Rejected code stays in staging/ for inspection — removing it is a human act.
    return { ok: true, blockId: decision.item.blockId, approval: decision.item, note: 'block left in staging/ for inspection or manual removal' };
  }

  return { submitBuild, validateBuild, approveBuild, rejectBuild };
}

module.exports = { createBuildPipeline, stageEnvelope };
