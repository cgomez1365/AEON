# Dependency decisions

Deferred or refused dependency upgrades, each with a reason and a **review
date**. A deferral with no date is how an advisory becomes permanent; this file
exists so "we looked at it" is a fact with an expiry rather than a memory.

Companion to `tools/scan/audit-gate.cjs`, which enforces the same discipline for
security advisories.

---

## Security acceptances in `tools/scan/audit-gate.cjs` — none since 2026-10-25

**Reviewed:** 2026-10-27 · **Review by:** none needed while the gate holds no
acceptances

**2026-10-27:** `ACCEPTED` in `tools/scan/audit-gate.cjs` is `{}`. It has been
empty since 2026-10-25, when PR #44 added the `package.json` `overrides` entry
that lifts `@grpc/grpc-js` to `^1.14.5` (1.14.6 installed). Measured
2026-10-27 on `72e20be`: `npm run scan:audit` passes and `npm audit` reports 0
advisories at any severity. A new acceptance needs a reason and a review date,
in the gate and in the table below.

History:

**2026-10-03:** vite moved to 6.4.3 (below). `npm audit` no longer reports the
vite advisory or the moderate vite/esbuild ones listed here, so the vite
acceptance is removed. One acceptance is left, grpc-js through firebase.

**2026-10-25:** firebase 13.1.0 (`@firebase/firestore` 4.19.0) still pins
`@grpc/grpc-js ~1.9.0`, so an npm `overrides` entry lifts grpc-js to `^1.14.5`
(fixed in 1.13.6 / 1.14.5; GHSA-m9gg-hp2v-232j, GHSA-f596-whhp-79r4). `npm audit`
no longer reports grpc-js, and the grpc-js acceptance is removed. The gate has no
acceptances left.

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
| 1123525 (GHSA-fx2h-pf6j-xcff) | high | vite 5.4.21 | **acceptance removed** 2026-10-03: fixed by vite 6.4.3, which AEON now uses | Until then: `server.fs.deny` bypass in the Vite **dev server**. The customer path (`launch.js`) runs `vite build`, then `node server/server.js`, which serves `dist/` through Express; the dev server never starts. It runs only under `npm start` / `npm run dev`, which listen on 127.0.0.1 only (`vite.config.js` `server.host`, since 6defca4), so the remaining exposure is a contributor on Windows who starts the dev server with `--host` on an untrusted network. |
| 1240623 (GHSA-m9gg-hp2v-232j) | high | @grpc/grpc-js 1.9.16 | **acceptance removed** 2026-10-25: `package.json` `overrides` pins `@grpc/grpc-js` `^1.14.5` (1.14.6 installed); `npm audit` no longer reports it | Until then: Published after `fe93dbf`. grpc-js arrives only through `firebase` → `@firebase/firestore`, whose **Node** build requires it. AEON imports firebase only in browser code (`src/kernel/firebase.js` and three React files); Vite bundles firestore's browser build, which does not use grpc-js — the built `dist/` contains no grpc-js code — and no Node code in AEON requires firebase. No fix exists yet: the latest firebase (12.19.0) still pins `@grpc/grpc-js ~1.9.0`, and 1.9.16 is the last 1.9.x. |
| 1124282 | — | react-router | **acceptance removed** | npm audit no longer reports it against react-router 7.18.2. A dead acceptance would silently cover the advisory if it came back. |

Below the gate's threshold (moderate), recorded so they are known, not
accepted in code — all Vite **dev server** only, same reasoning as 1123525.
None is reported after the vite 6.4.3 upgrade (2026-10-03):

- 1116229 (GHSA-4w7w-66w2-5vf9) — vite: path traversal in optimized-deps `.map` handling.
- 1120784 (GHSA-v6wh-96g9-6wx3) — vite's launch-editor: NTLMv2 hash disclosure via UNC paths on Windows.
- 1102341 (GHSA-67mh-4wv8-2f99) — esbuild ≤0.24.2 (vite 5's): any website can send requests to the dev server and read the response.

**Unblocked when:** firebase ships a firestore that depends on a fixed
grpc-js, or AEON drops firebase. (The other half, vite 6.4.3, was done on
2026-10-03.) Done another way on 2026-10-25: the `overrides` entry. Drop it
once firestore's own range admits a fixed grpc-js.

---

## vite → 8.x — **DEFERRED**

**Decided:** 2026-08-04 (BO-A3d) · **Re-reviewed:** 2026-09-30, 2026-10-27 · **Review by:** 2026-11-30

Dependabot opened a vite 8 update (`dependabot/npm_and_yarn/vite-8.1.5`), and
prior build orders described it as "the ready-made fix for the deferred dev-only
vite/esbuild advisories". It is not ready-made. It was **tested, not guessed
at**, and it fails. The pull request was closed unmerged; its branch is no longer
on origin (checked 2026-10-03). Its successor, PR #33 (vite 8.3.2), was closed
unmerged on 2026-10-03.

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

**Why deferring is safe.** The vite advisories that once made this upgrade
urgent were closed by vite 6.4.3 (2026-10-03, below). Deferring vite 8 leaves
no vite advisory open, and `npm run scan:audit` holds no vite acceptance: if
one is reported again, the gate fails.

**Unblocked when:** `vite-plugin-pwa` ships a release that genuinely builds
under rolldown. Re-test with `npm run build`; if it produces `dist/sw.js`, take
the upgrade.

**2026-10-27 re-test (measured).** A scratch copy of `72e20be` on macOS, Node
24.20.0, npm 11.19.0, with
`npm i -D vite@8.3.5 vite-plugin-pwa@2.0.0 @vitejs/plugin-react-swc@4.3.3`.
vite-plugin-pwa 2.0.0 was published 2026-10-03. plugin-react-swc 3.11.0 does
not list vite 8 in its peers, so it went up too. Nothing from this test is
committed.

- Baseline, same copy on vite 6.4.5: `npm run build` passed and the PWA step
  reported 49 precache entries (2357.76 KiB).
- vite 8 as configured: `npm run build` **fails**, but no longer in
  vite-plugin-pwa. Rolldown rejects the object form of
  `build.rollupOptions.output.manualChunks` in `vite.config.js` ("Expected
  Function but received Object", then
  `TypeError: manualChunks is not a function`). The failed build still wrote a
  `dist/sw.js`: 15 precache entries, 0.00 KiB, and no app files beside it.
- vite 8 with `manualChunks` rewritten as a function (in the scratch copy
  only): `npm run build` exited 0, and the PWA step reported 50 precache
  entries (2359.90 KiB).
- **Not measured:** the test suite, the dev server, AEON booting through
  `launch.js`, and the npm 10 lockfile check on that tree.

So `dist/sw.js` alone is not proof: a failed build wrote one. A pass is
`npm run build` exiting 0 with a precache close to the vite 6 count. The
deferral stands until after go-live. Taking vite 8 means the `vite.config.js`
change, `@vitejs/plugin-react-swc` 4.x (PR #61, below), a lockfile npm 10
leaves unchanged, and a full CI run.

**A smaller step exists: vite 6.4.3 (one major, not three).** Found
2026-09-30. Every vite advisory above stops at 6.4.2 or earlier, and vite 6.4.3
depends on esbuild `^0.25.0`, past the esbuild advisory. `vite-plugin-pwa@1.3.0`
and `@vitejs/plugin-react-swc@3.11.0` both declare vite 6 support. Measured in
a scratch copy of `fe93dbf` with `npm i -D vite@6.4.3`: `vite build` passed and
wrote `dist/sw.js`, and `npm audit` then reported no vite or esbuild advisory.

**Taken 2026-10-03** (audit #12): `vite ^6.4.3`. Measured on that tree: the
full suite passed, `npm run build` passed and wrote `dist/sw.js`, the dev
server started and served the app on 127.0.0.1, and `npm audit` reported no
vite or esbuild advisory. **Not measured:** AEON booting through `launch.js`
on the result. Vite 8 stays deferred for the reasons above.

---

## package-lock.json — written with npm 10

**Decided:** 2026-10-03 (audit #6)

Node 22.13 ships npm 10; Node 24 and 26 ship npm 11. `launch.js` runs
`npm install` on a first launch, so if a user's npm would write a different
lockfile, it rewrites the tracked file in their checkout and a later
`git pull` that touches it stops. `npm ci` on npm 10 also refused the v3.2.0
lockfile npm 11 wrote (27 `Missing:` lines).

The cause was a nested vite 8 that vitest had resolved for itself when the root
vite was 5.4.21; npm 10 and npm 11 disagree about its optional esbuild peer.
vitest 4.1.11 accepts vite 6, so it now uses the root vite 6.4.3 and the nested
copy is gone. The lockfile was then written with npm 10.9.2. Measured on
macOS: `npm ci --dry-run` passes, and `npm install --package-lock-only` leaves the
lockfile byte-identical, on npm 10.9.2 and on npm 11.19.0. CI checks the second
on every Linux leg (npm 10 on the floor leg, npm 11 on Node 24 and 26).

To change a dependency: change it with any npm, then rewrite the lockfile with

    npx -y npm@10.9.2 install --package-lock-only

**Cost, accepted:** npm 10 does not write the `libc` field npm 11 had put on
Linux native packages, and npm uses that field to skip musl builds on a glibc
Linux. Measured by simulation on macOS (npm 11.19.0,
`npm ci --ignore-scripts --os=linux --cpu=x64 --libc=glibc`): this lockfile
installs 4 musl packages the v3.2.0 lockfile did not — `@swc/core`,
`@rollup/rollup`, `@napi-rs/canvas` and the `@napi-rs/canvas` copy under
`pdfjs-dist` — 95,736 KB on disk (`du -sk`) on Linux x64. **Not measured** on
a real Linux machine. Writing the field back with npm 11 would bring back the
rewrite for Node 22 users: npm 10 removes it (it removed all 39 when this
lockfile was written).

---

## actions/checkout and actions/setup-node v5 → v7 — **MERGED**

**Decided:** 2026-08-04 (BO-A3d held `setup-node` v7, "do not merge yet"; it left
`checkout` v7 untouched) · **Merged:** 2026-09-14

The 2026-08-04 entry held `actions/setup-node@v7` because nobody had read why a
run on it failed. Both v7 bumps were merged on 2026-09-14: `c3d0992`
(`actions/checkout` 5 → 7, PR #10) and `d2474e1` (`actions/setup-node` 5 → 7,
PR #11). CI on the v3.2.0 release commit `cf73b00` ran 5/5 green on them (run
37102458513). Since 2026-10-03 (audit #43) `.github/workflows/ci.yml` pins both to
commit SHAs in both jobs: checkout `3d3c42e…` (v7.0.1) and setup-node `8207627…`
(v7.0.0).

---

## Dependabot pull requests — checked 2026-10-27

Read on 2026-10-27 from the pull requests, `git ls-remote --heads origin`
and the CI run on each branch, against `main` = `72e20be`.

- **#60** `@napi-rs/canvas` 1.0.11 → 1.0.13 (the weekly minor-and-patch group):
  **closed** unmerged on 2026-10-27. Four build legs failed
  `tests/brand-mark.test.js` ("stale icons"); the Node 22.13 leg stopped
  earlier, at the npm 10 lockfile check (run 40460955039). `package.json`
  pins canvas at exactly 1.0.11 because 1.0.12 and later render the brand
  icons differently (main commit `7c876bc`). `.github/dependabot.yml` now
  ignores `@napi-rs/canvas`. To lift: bump it on its own branch, run
  `npm run brand:icons`, commit the new icons, and let CI pass.
- **#61** `@vitejs/plugin-react-swc` 3.11.0 → 4.3.3, major: **held until after
  go-live**. It fails only the Node 22.13 leg, where npm 10's
  `npm install --package-lock-only` changes the lockfile (run 40460974894).
  3.11.0 does not list vite 8 in its peers, so vite 8 waits on this (above).
- **#62** `concurrently` 9.2.4 → 10.0.6, major, dev-only: CI green.
- **#63** `pdfjs-dist` 4.10.38 → 6.4.299, two majors: **held**. It needs a
  smoke test on a text PDF and on a scanned PDF through the OCR path
  (`src/blocks/aeon_matrix/api/_extract.cjs`). Its Windows leg failed on a 10 s
  timeout in `tests/local-runtime/cookbook-fit.test.js` (run 40460999447); not
  yet explained.
- **#64** `googleapis` 173 → 188, major: CI green.

0 open Dependabot alerts (the 2026-10-27 read-only check). `npm audit` on
`72e20be` reports 0 advisories (measured 2026-10-27).

Branches on origin: `main` and the five Dependabot branches of #60 to #64 (#60's
was still there when checked). The stale branch of PR #42 (closed 2026-10-25)
was removed on 2026-10-27.

The 2026-10-03 listing named PR #32 (the minor-and-patch group of that week)
and PR #33 (vite 8.3.2). Both were closed unmerged: #33 on 2026-10-03, #32 on
2026-10-06 (UTC).

The branches this file listed on 2026-08-04 (`checkout-7`, `setup-node-7`,
`concurrently-10.0.3`, `inquirer-14.0.2`, `typescript-7.0.2`, `vite-8.1.5` and
an older minor-and-patch group) are gone: the two actions bumps were merged
(above). PRs #2–#5 (concurrently, vite 8, typescript, inquirer) were closed by
hand on 2026-09-14; the older minor-and-patch group (PR #13) was superseded by
Dependabot.

None of #61 to #64 is security-driven: the gate holds no acceptances and
`npm audit` reports nothing they would close.
