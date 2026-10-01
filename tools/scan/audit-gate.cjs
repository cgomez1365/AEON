#!/usr/bin/env node
/**
 * Dependency audit gate.
 *
 * `npm audit --audit-level=high` ran in CI with `continue-on-error: true`,
 * which means it could never fail the build — 11 high-severity findings sat
 * unread for as long as CI was reporting them. A check that cannot fail is
 * not a check.
 *
 * This gate fails on any high/critical advisory in code that runs on a
 * customer's machine, and allows a small set of explicitly justified
 * exceptions. Every exception carries a reason and a review date, so an
 * accepted risk expires instead of becoming permanent silence.
 *
 * Scope: the WHOLE dependency tree, devDependencies included. This gate used
 * `--omit=dev` and called that "shipped code", but launch.js runs a plain
 * `npm install` and then `npm run build` on every customer machine on first
 * launch — vite, vite-plugin-pwa and workbox-build run there too (audit
 * finding A005, 2026-09-30). On 2026-09-30 the full tree and the production
 * tree reported the same two high advisories, so widening costs nothing today.
 *
 * Every acceptance below is also recorded, with the same review date, in
 * docs/DEPENDENCY_DECISIONS.md.
 *
 * Run: npm run scan:audit
 */
'use strict';

const { execSync } = require('child_process');

const FAIL_ON = new Set(['high', 'critical']);

/** The audit this gate reads. No --omit=dev: see the scope note above. */
const AUDIT_COMMAND = 'npm audit --json';

/**
 * Accepted advisories. Keyed by npm advisory ID.
 *
 * `reason` must explain why this specific codebase is not exposed — not that
 * the fix is inconvenient. `review` is the date the acceptance goes stale;
 * past it, the gate fails regardless.
 *
 * Removed 2026-09-30: 1124282 (react-router, RSC Mode CSRF). npm audit no
 * longer reports it against react-router 7.18.2, and an acceptance for an
 * advisory that is not there would silently cover it if it came back.
 */
const ACCEPTED = {
  1123525: {
    pkg: 'vite',
    reason: 'server.fs.deny bypass on Windows alternate paths, in the Vite DEV '
          + 'server only. Re-reviewed 2026-09-30: the customer path is launch.js, '
          + 'which runs `vite build` once and then `node server/server.js`; that '
          + 'serves dist/ through Express and never starts the dev server. The '
          + 'dev server runs only under `npm start` / `npm run dev` (developer '
          + 'entry points). It listens on 127.0.0.1 only (vite.config.js '
          + 'server.host, since 6defca4), so the remaining exposure is a '
          + 'contributor on Windows who starts it with --host on an untrusted '
          + 'network. Fixed in vite 6.4.3; a '
          + 'scratch `vite build` under 6.4.3 passed on 2026-09-30 but the '
          + 'upgrade is not taken yet (see docs/DEPENDENCY_DECISIONS.md).',
    review: '2026-10-31',
  },
  1240623: {
    pkg: '@grpc/grpc-js',
    reason: 'getAuthContext can report an unauthorized peer certificate as '
          + 'authorized. Published after fe93dbf; reviewed 2026-09-30. AEON '
          + 'never loads @grpc/grpc-js: it arrives only through firebase -> '
          + '@firebase/firestore, whose Node build requires it. AEON imports '
          + 'firebase only in browser code (src/kernel/firebase.js and three '
          + 'React files); Vite bundles firestore\'s browser build, which does '
          + 'not use grpc-js (the built dist/ contains no grpc-js code), and no '
          + 'Node code in AEON requires firebase. No fix is available: the '
          + 'latest firebase (12.19.0) still pins @grpc/grpc-js ~1.9.0, and '
          + '1.9.16 is the last 1.9.x.',
    review: '2026-10-31',
  },
};

function audit() {
  // npm audit exits non-zero when it finds anything — that is the normal case
  // here, so read stdout from the error rather than treating it as a failure.
  try {
    return JSON.parse(execSync(AUDIT_COMMAND, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024,
    }));
  } catch (e) {
    if (e.stdout) return JSON.parse(e.stdout);
    throw e;
  }
}

/**
 * Judge an `npm audit --json` report as of `today` (YYYY-MM-DD).
 * Pure, so a test can check the gate's verdict without the network.
 */
function evaluate(report, today) {
  const findings = [];

  for (const [name, v] of Object.entries((report && report.vulnerabilities) || {})) {
    for (const via of v.via || []) {
      if (typeof via !== 'object' || !via.source) continue;
      if (!FAIL_ON.has(via.severity)) continue;
      findings.push({ id: via.source, pkg: name, severity: via.severity, title: via.title || '' });
    }
  }

  const blocking = [];
  const accepted = [];
  const expired = [];

  for (const f of findings) {
    const a = ACCEPTED[f.id];
    if (!a) { blocking.push(f); continue; }
    if (a.review < today) expired.push({ ...f, review: a.review });
    else accepted.push({ ...f, review: a.review });
  }

  // An acceptance with nothing to accept is a note, not a failure — but it is
  // said, so it gets removed instead of quietly waiting for the advisory.
  const seen = new Set(findings.map(f => String(f.id)));
  const unused = Object.keys(ACCEPTED).filter(id => !seen.has(id));

  return { blocking, accepted, expired, unused, ok: !blocking.length && !expired.length };
}

function main() {
  const today = new Date().toISOString().slice(0, 10);
  const { blocking, accepted, expired, unused, ok } = evaluate(audit(), today);

  for (const a of accepted) {
    console.log(`[SCAN audit] accepted ${a.id} (${a.pkg}) — review by ${a.review}`);
  }
  for (const id of unused) {
    console.log(`[SCAN audit] note: accepted ${id} (${ACCEPTED[id].pkg}) is no longer reported — remove its acceptance`);
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

  if (!ok) process.exit(1);

  console.log('[SCAN audit] PASS — no unreviewed high/critical advisories in code that runs on a customer machine.');
}

// Run only as a script, so a test can require the verdict logic without
// running npm audit (which needs the network).
if (require.main === module) main();

module.exports = { ACCEPTED, AUDIT_COMMAND, FAIL_ON, evaluate };
