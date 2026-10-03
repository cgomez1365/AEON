# Dependency decisions

Deferred or refused dependency upgrades, each with a reason and a **review
date**. A deferral with no date is how an advisory becomes permanent; this file
exists so "we looked at it" is a fact with an expiry rather than a memory.

Companion to `tools/scan/audit-gate.cjs`, which enforces the same discipline for
security advisories.

---

## Security acceptances in `tools/scan/audit-gate.cjs` — re-reviewed 2026-09-30

**Reviewed:** 2026-09-30 · **Review by:** 2026-10-31

**2026-10-03:** vite moved to 6.4.3 (below). `npm audit` no longer reports the
vite advisory or the moderate vite/esbuild ones listed here, so the vite
acceptance is removed. One acceptance is left, grpc-js through firebase.

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
| 1240623 (GHSA-m9gg-hp2v-232j) | high | @grpc/grpc-js 1.9.16 | accepted to 2026-10-31 | Published after `fe93dbf`. grpc-js arrives only through `firebase` → `@firebase/firestore`, whose **Node** build requires it. AEON imports firebase only in browser code (`src/kernel/firebase.js` and three React files); Vite bundles firestore's browser build, which does not use grpc-js — the built `dist/` contains no grpc-js code — and no Node code in AEON requires firebase. No fix exists yet: the latest firebase (12.19.0) still pins `@grpc/grpc-js ~1.9.0`, and 1.9.16 is the last 1.9.x. |
| 1124282 | — | react-router | **acceptance removed** | npm audit no longer reports it against react-router 7.18.2. A dead acceptance would silently cover the advisory if it came back. |

Below the gate's threshold (moderate), recorded so they are known, not
accepted in code — all Vite **dev server** only, same reasoning as 1123525.
None is reported after the vite 6.4.3 upgrade (2026-10-03):

- 1116229 (GHSA-4w7w-66w2-5vf9) — vite: path traversal in optimized-deps `.map` handling.
- 1120784 (GHSA-v6wh-96g9-6wx3) — vite's launch-editor: NTLMv2 hash disclosure via UNC paths on Windows.
- 1102341 (GHSA-67mh-4wv8-2f99) — esbuild ≤0.24.2 (vite 5's): any website can send requests to the dev server and read the response.

**Unblocked when:** firebase ships a firestore that depends on a fixed
grpc-js, or AEON drops firebase. (The other half, vite 6.4.3, was done on
2026-10-03.)

---

## vite → 8.x — **DEFERRED**

**Decided:** 2026-08-04 (BO-A3d) · **Re-reviewed:** 2026-09-30 · **Review by:** 2026-10-31

Dependabot opened a vite 8 update (`dependabot/npm_and_yarn/vite-8.1.5`), and
prior build orders described it as "the ready-made fix for the deferred dev-only
vite/esbuild advisories". It is not ready-made. It was **tested, not guessed
at**, and it fails. The pull request was closed unmerged; its branch is no longer
on origin (checked 2026-10-03). Its successor, PR #33 (vite 8.3.2), is listed at
the end of this file.

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

## Dependabot branches on origin — checked 2026-10-03

`git ls-remote --heads origin` on 2026-10-03 lists three branches: `main` and
two Dependabot branches:

- `dependabot/npm_and_yarn/minor-and-patch-c4dd0af735` — the weekly
  minor-and-patch group, PR #32 (opened 2026-10-01).
- `dependabot/npm_and_yarn/vite-8.3.2` — opened as vite 5.4.21 → 8.3.2, PR #33
  (2026-10-03), against the `main` of that day. `main` now has vite 6.4.3, so from
  here it is a two-major jump. Not tested here. It stays held under the vite 8
  entry above until `vite-plugin-pwa` builds under vite 8.

The branches this file listed on 2026-08-04 (`checkout-7`, `setup-node-7`,
`concurrently-10.0.3`, `inquirer-14.0.2`, `typescript-7.0.2`, `vite-8.1.5` and
an older minor-and-patch group) are gone: the two actions bumps were merged
(above). PRs #2–#5 (concurrently, vite 8, typescript, inquirer) were closed by
hand on 2026-09-14; the older minor-and-patch group (PR #13) was superseded by
Dependabot.

The majors (vite, typescript, inquirer, concurrently) stay held; vite's reason
is above. PR #32 is not security-driven: no advisory in the gate's table is
closed by it.
