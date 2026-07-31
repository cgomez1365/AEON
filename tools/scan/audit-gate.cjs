#!/usr/bin/env node
/**
 * Dependency audit gate.
 *
 * `npm audit --audit-level=high` ran in CI with `continue-on-error: true`,
 * which means it could never fail the build — 11 high-severity findings sat
 * unread for as long as CI was reporting them. A check that cannot fail is
 * not a check.
 *
 * This gate fails on any high/critical advisory affecting SHIPPED code, and
 * allows a small set of explicitly justified exceptions. Every exception
 * carries a reason and a review date, so an accepted risk expires instead of
 * becoming permanent silence.
 *
 * Run: npm run scan:audit
 */
'use strict';

const { execSync } = require('child_process');

const FAIL_ON = new Set(['high', 'critical']);

/**
 * Accepted advisories. Keyed by npm advisory ID.
 *
 * `reason` must explain why this specific codebase is not exposed — not that
 * the fix is inconvenient. `review` is the date the acceptance goes stale;
 * past it, the gate fails regardless.
 */
const ACCEPTED = {
  1124282: {
    pkg: 'react-router',
    reason: 'RSC Mode CSRF. AEON is a Vite SPA using BrowserRouter — it imports '
          + 'only from react-router-dom and uses no RSC/server APIs, so the '
          + 'vulnerable code path is never reached. Fix requires the v8 major.',
    review: '2026-10-01',
  },
  1123525: {
    pkg: 'vite',
    reason: 'server.fs.deny bypass in the Vite DEV server. Production serves a '
          + 'static dist/ through Express; the dev server never runs there. '
          + 'Resolved by the pending vite@8 upgrade.',
    review: '2026-10-01',
  },
};

function audit() {
  // npm audit exits non-zero when it finds anything — that is the normal case
  // here, so read stdout from the error rather than treating it as a failure.
  try {
    return JSON.parse(execSync('npm audit --json --omit=dev', {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024,
    }));
  } catch (e) {
    if (e.stdout) return JSON.parse(e.stdout);
    throw e;
  }
}

function main() {
  const report = audit();
  const findings = [];

  for (const [name, v] of Object.entries(report.vulnerabilities || {})) {
    for (const via of v.via || []) {
      if (typeof via !== 'object' || !via.source) continue;
      if (!FAIL_ON.has(via.severity)) continue;
      findings.push({ id: via.source, pkg: name, severity: via.severity, title: via.title || '' });
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const blocking = [];
  const accepted = [];
  const expired = [];

  for (const f of findings) {
    const a = ACCEPTED[f.id];
    if (!a) { blocking.push(f); continue; }
    if (a.review < today) expired.push({ ...f, review: a.review });
    else accepted.push({ ...f, review: a.review });
  }

  for (const a of accepted) {
    console.log(`[SCAN audit] accepted ${a.id} (${a.pkg}) — review by ${a.review}`);
  }

  if (expired.length) {
    console.error('\n[SCAN audit] FAIL — accepted advisories are past their review date:');
    for (const e of expired) console.error(`     ${e.id}  ${e.pkg}  review was ${e.review}`);
    console.error('\nRe-assess and either fix the dependency or extend the review date.');
  }

  if (blocking.length) {
    console.error(`\n[SCAN audit] FAIL — ${blocking.length} unreviewed high/critical advisory(ies):`);
    for (const b of blocking) console.error(`     ${b.id}  ${b.severity}  ${b.pkg}  ${b.title.slice(0, 70)}`);
    console.error('\nFix the dependency, or add an entry to ACCEPTED with a reason and review date.');
  }

  if (blocking.length || expired.length) process.exit(1);

  console.log('[SCAN audit] PASS — no unreviewed high/critical advisories in shipped code.');
}

main();
