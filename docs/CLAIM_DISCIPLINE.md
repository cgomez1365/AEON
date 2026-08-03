# Claim discipline

> Bible p30: **"Build boldly. Describe precisely."** Distinguish implemented
> from designed.

This file exists because the same failure keeps recurring in different clothes:
AEON knows more about its own state than it tells the operator, or claims more
than it delivers. Every build order since 2026-08-01 has found at least one.

## The rule

**A claim in the product must be true of the product, not of the design.**

Concretely, in descending order of how often each has bitten:

1. **A declaration with no consumer is not a feature.** `manifest.widget` was
   passed through the kernel to the registry, and nothing rendered it. "Add a
   block and settings gains a control surface" was true of the data model and
   false of the product for as long as the field existed. (BO-A2a)

2. **State the answer to the question you were asked.** A badge reading
   `Connected` from *configuration* next to a probe reading `Failed` from
   *reachability* answers two different questions and admits neither. Derive
   one status from ability to serve; keep the detail beneath it, never as a
   contradiction beside it. (BO-F3b)

3. **Readiness must reflect ability, not declaration.** Writer left
   `requires.apis` empty and was therefore *always* ready — including when its
   role pointed at a provider with no model. (BO-F3a)

4. **An assignment must name something that exists.** Three roles were mapped
   to models a Groq endpoint does not serve and readiness reported `ok` for all
   three; the router would have 404'd on the first call. (BO-A5b)

5. **An error must name every remedy, cheapest first.** "Install the runtime
   and a model in Cookbook" was true and incomplete — repointing the role at an
   already-working provider was faster and never mentioned. (BO-F3c)

6. **A manifest must describe the code.** 15 of 17 manifests carried a
   scaffold-time placeholder route that matched no mount point. Manifests are
   now GENERATED from the code and staleness-gated: a generated declaration
   cannot go stale, a hand-stamped guess starts wrong and stays wrong. (08-03)

7. **A deployment target must match what actually mounts.** `aeon_matrix`
   declared `any` while returning its router early in cloud, so every route
   below that line never mounted there. (BO-A3a)

8. **Upstream claims are claims too.** `vite-plugin-pwa@1.3.0` declares
   `vite: ^8.0.0` in peerDependencies and fails to build under it. Test the
   upgrade; do not trust the range. (BO-A3d)

## Which product does a number score?

The Bible describes **two** products: the workspace (p4–25) and the business
layer (p26–27 — paid packs, deployments, marketplace). The business layer is
not built.

**Every readiness or confidence figure must say which one it scores.** Counting
an unbuilt commercial layer against engineering readiness is dishonest in both
directions: it understates the engineering and overstates the business.

- In the UI: the settings confidence badge reads *"Workspace confidence"* and
  names the exclusion. (BO-A5c)
- In reports: write "N% ready for consumer release on Windows", not "N% ready".

## The testing corollary

Every gate written before 2026-08-03 checked that something **dangerous was
absent** — no `exec()`, no `shell:true`, no `bash -c`. Not one checked that the
feature still **worked**. That is how `/model/serve` shipped broken by the very
commit that secured it.

**A security fix needs a functional test, not only an absence test.** If a fix
cannot pass a test that drives the happy path and asserts a real result, the fix
is not done.

Related: **a test may observe a live instance; it may not provision one.**
`npm test` locked the operator out of AEON on 2026-08-03 by claiming the only
operator slot and flipping `guardEnabled`. Isolation that covers two of three
write targets reads as isolation and is not.
