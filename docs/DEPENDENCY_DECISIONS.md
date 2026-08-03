# Dependency decisions

Deferred or refused dependency upgrades, each with a reason and a **review
date**. A deferral with no date is how an advisory becomes permanent; this file
exists so "we looked at it" is a fact with an expiry rather than a memory.

Companion to `tools/scan/audit-gate.cjs`, which enforces the same discipline for
security advisories.

---

## vite 5.4.21 → 8.x — **DEFERRED**

**Decided:** 2026-08-04 (BO-A3d) · **Review by:** 2026-10-01

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
`npm run scan:audit` already carries them as reviewed acceptances with the same
2026-10-01 date, so nothing is silently ignored.

**Unblocked when:** `vite-plugin-pwa` ships a release that genuinely builds
under rolldown. Re-test with `npm run build`; if it produces `dist/sw.js`, take
the upgrade.

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
