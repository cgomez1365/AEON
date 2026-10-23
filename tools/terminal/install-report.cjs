'use strict';
/**
 * What `aeon install` and `aeon update` say about the result — plain strings,
 * no colors and no printing, so the wording is testable
 * (tests/cli-install-report.test.js) and the CLI only decides how to paint it.
 */

/**
 * The server's interface-rebuild answer (`uiRebuilt`, from src/kernel/uiBuild.cjs)
 * as one of three outcomes the operator can act on:
 *   rebuilt  the build ran and passed
 *   skipped  it did not run (no build tooling here, or AEON was stopping)
 *   failed   it ran and failed — the block is still installed
 */
function uiRebuildReport(ui, id) {
  if (ui && ui.ok) {
    return { kind: 'rebuilt', text: `interface rebuilt in ${Math.round((ui.ms || 0) / 1000)}s — reload the tab to see ${id}` };
  }
  if (!ui || ui.skipped) {
    const why = (ui && ui.reason) || 'the server did not report a rebuild';
    return { kind: 'skipped', text: `the interface was not rebuilt (${why}) — run npm run build by hand, then reload the tab` };
  }
  const why = ui.error || ui.reason || 'no reason given';
  return { kind: 'failed', text: `the interface build FAILED (${why}) — ${id} is installed; fix the error above or run npm run build by hand, then reload the tab` };
}

/** A block lands STOPPED (blocks are manual-start); say how to start it. */
function startHint(id) {
  return `${id} landed stopped — start it with: aeon block start ${id}`;
}

/** The few facts worth showing of an install result (the raw one is ~250 lines of JSON). */
function installFacts(data) {
  const d = data || {};
  const id = d.blockId || (d.purchase && d.purchase.id) || '?';
  const label = d.purchase && d.purchase.label && d.purchase.label !== id ? `${d.purchase.label} ` : '';
  const version = d.purchase && d.purchase.version ? `v${d.purchase.version} ` : '';
  const score = (d.verdict && d.verdict.score) || (d.approval && d.approval.score) || null;
  const reasons = ((d.verdict && d.verdict.reasons) || (d.approval && d.approval.reasons) || [])
    .map((r) => (typeof r === 'string' ? r : `${r.sev ? `[${r.sev}] ` : ''}${r.why || r.rule || ''}`.trim()))
    .filter(Boolean)
    .map((r) => (r.length > 200 ? `${r.slice(0, 199)}…` : r));
  return {
    head: `${label}${version}(${id})`.trim(),
    stage: d.stage || 'unknown',
    score,
    reasons: reasons.slice(0, 5),
    moreReasons: Math.max(0, reasons.length - 5),
    approvalId: d.stage === 'queued' && d.approval ? d.approval.id || null : null,
  };
}

module.exports = { uiRebuildReport, startHint, installFacts };
