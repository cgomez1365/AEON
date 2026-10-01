# Dependency decisions

Deferred or refused dependency upgrades, each with a reason and a **review
date**. A deferral with no date is how an advisory becomes permanent; this file
exists so "we looked at it" is a fact with an expiry rather than a memory.

Companion to `tools/scan/audit-gate.cjs`, which enforces the same discipline for
security advisories.

---

## Security acceptances in `tools/scan/audit-gate.cjs` — re-reviewed 2026-09-30

**Reviewed:** 2026-09-30 · **Review by:** 2026-10-31

The gate's two acceptances (vite 1123525, react-router 1124282) were dated
2026-10-01, so the CI `security` leg would have gone red from 2026-10-02 (UTC)
on an unchanged tree. On 2026-09-30 a new high advisory in `@grpc/grpc-js`
(1240623) made the gate fail outright. Each entry was re-checked against the
code on 2026-09-30, not just re-dated.

The gate now audits the **whole** dependency tree. It used `--omit=dev`, but
`launch.js` runs a plain `npm install` and then `npm run build` on every
customer machine, so the build toolchain runs there too. Measured 2026-09-30
(`npm audit`): the full tree and the production tree report the same two high
advisories.

| Advisory | Severity | Package | Decision | Why AEON is not exposed |
|---|---|---|---|---|
| 1123525 (GHSA-fx2h-pf6j-xcff) | high | vite 5.4.21 | accepted to 2026-10-31 | `server.fs.deny` bypass in the Vite **dev server**. The customer path (`launch.js`) runs `vite build`, then `node server/server.js`, which serves `dist/` through Express; the dev server never starts. It runs only under `npm start` / `npm run dev`, which listen on 127.0.0.1 only (`vite.config.js` `server.host`, since 6defca4), so the remaining exposure is a contributor on Windows who starts the dev server with `--host` on an untrusted network. |
| 1240623 (GHSA-m9gg-hp2v-232j) | high | @grpc/grpc-js 1.9.16 | accepted to 2026-10-31 | Published after `fe93dbf`. grpc-js arrives only through `firebase` → `@firebase/firestore`, whose **Node** build requires it. AEON imports firebase only in browser code (`src/kernel/firebase.js` and three React files); Vite bundles firestore's browser build, which does not use grpc-js — the built `dist/` contains no grpc-js code — and no Node code in AEON requires firebase. No fix exists yet: the latest firebase (12.19.0) still pins `@grpc/grpc-js ~1.9.0`, and 1.9.16 is the last 1.9.x. |
| 1124282 | — | react-router | **acceptance removed** | npm audit no longer reports it against react-router 7.18.2. A dead acceptance would silently cover the advisory if it came back. |

Below the gate's threshold (moderate), recorded so they are known, not
accepted in code — all Vite **dev server** only, same reasoning as 1123525:

- 1116229 (GHSA-4w7w-66w2-5vf9) — vite: path traversal in optimized-deps `.map` handling.
- 1120784 (GHSA-v6wh-96g9-6wx3) — vite's launch-editor: NTLMv2 hash disclosure via UNC paths on Windows.
- 1102341 (GHSA-67mh-4wv8-2f99) — esbuild ≤0.24.2 (vite 5's): any website can send requests to the dev server and read the response.

**Unblocked when:** vite moves to 6.4.3 or later (below), and firebase ships a
firestore that depends on a fixed grpc-js — or AEON drops firebase.

---

## vite 5.4.21 → 8.x — **DEFERRED**

**Decided:** 2026-08-04 (BO-A3d) · **Re-reviewed:** 2026-09-30 · **Review by:** 2026-10-31

Dependabot has `dependabot/npm_and_yarn/vite-8.1.5` open on origin, and prior
build orders described it as "the ready-made fix for the deferred dev-only
vite/esbuild advisories". It is not ready-made. It was **tested, not guessed
at**, and it fails.

- The bump is `^5.4.21 → ^8.2.0` — a **three-major** jump, not one.
- Vite 8 replaces the esbuild/rollup pipeline with **rolldown**.
- `npm run build` fails at `[plugin vite-plugin-pwa:build]`. `vite-plugin-pwa`
  is how AEON ships its service worker and offline precache; a failing build is
  not a partial degradation, it is no artifact at all.
- `vite-plugin-pwa@1.3.0` is the **latest published version** and its
  `peerDependencies` claim `vite: "… || ^8.0.0"`. It declares support it does
  not deliver — the same overclaiming class this build order exists to remove,
  arriving from upstream.
- `@vitejs/plugin-react-swc` additionally warns that its `esbuild` option is
  deprecated under vite 8 and wants `oxc`.

**Why deferring is safe.** The advisories this upgrade would close are
**dev-server only** — they do not affect the built artifact an operator runs.
`npm run scan:audit` carries the high one as a reviewed acceptance (review by
2026-10-31, table above), so nothing is silently ignored.

**Unblocked when:** `vite-plugin-pwa` ships a release that genuinely builds
under rolldown. Re-test with `npm run build`; if it produces `dist/sw.js`, take
the upgrade.

**A smaller step exists: vite 6.4.3 (one major, not three).** Found
2026-09-30. Every vite advisory above stops at 6.4.2 or earlier, and vite 6.4.3
depends on esbuild `^0.25.0`, past the esbuild advisory. `vite-plugin-pwa@1.3.0`
and `@vitejs/plugin-react-swc@3.11.0` both declare vite 6 support. Measured in
a scratch copy of `fe93dbf` with `npm i -D vite@6.4.3`: `vite build` passed and
wrote `dist/sw.js`, and `npm audit` then reported no vite or esbuild advisory.
**Not measured:** the test suite, the dev server, or AEON booting on the
result. Not taken here — it is a major bump the day before a release, and the
standing instruction is to hold the vite major. It is the next thing to try.

---

## actions/setup-node v5 → v7 — **DO NOT MERGE YET**

**Decided:** 2026-08-04 (BO-A3d) · **Review by:** 2026-10-01

`dependabot/github_actions/actions/setup-node-7` is open on origin. The
workflow pins `actions/setup-node@v5` in both jobs and **CI is green**, so
nothing is blocked.

Guessing at this was declined once already and that was correct. It stays
declined for the same reason: nobody has read *why* v7 fails, and merging a CI
change you do not understand converts a green pipeline into an unknown one for
no benefit. A dependency bump whose only justification is "it is newer" is not
a justification.

**Unblocked when:** someone reads the v7 release notes and the failing run's
log, and can state what changed. Then merge on purpose.

---

## Also open on origin, untouched by BO-A3d

Listed so they are known rather than discovered later. None are on the release
path and none are security-driven:

- `dependabot/github_actions/actions/checkout-7`
- `dependabot/npm_and_yarn/concurrently-10.0.3`
- `dependabot/npm_and_yarn/inquirer-14.0.2`
- `dependabot/npm_and_yarn/minor-and-patch-52612f826a`
- `dependabot/npm_and_yarn/typescript-7.0.2`
