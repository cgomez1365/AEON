# Contributing to AEON

Thanks for looking. AEON has one maintainer, so small, well-evidenced changes land fastest.

## Before you start

- **Read [`LICENSE`](../LICENSE).** The AEON Community License lets you use and modify
  AEON; it does not let you resell or redistribute it. A fork you publish elsewhere is
  redistribution.
- **Open an issue first** for anything bigger than a fix, so the change and its evidence
  can be agreed before you write it.
- **Security problems go through [the security policy](SECURITY.md),** never a public issue.

## Set up

```bash
git clone https://github.com/cgomez1365/AEON.git
cd AEON
npm ci                 # Node.js 22.13 or newer
npm start              # Vite dev server + kernel, hot reload
```

## What a pull request must pass

Every one of these runs in CI on Windows, macOS, Ubuntu 24, the Ubuntu 22.13 floor and a
security leg. Run them locally first:

```bash
npm test                    # the full suite
npm run scan:release-gate   # runtime purity · path authority · cloud ratchet · block filesystem
npm run scan:audit          # no unreviewed high/critical advisories
```

And three rules that are reviewed, not just scanned:

1. **Every claim must be true of the product.** A UI string, a doc line or a manifest
   field that describes something the code does not do is a defect.
   → [`docs/CLAIM_DISCIPLINE.md`](../docs/CLAIM_DISCIPLINE.md)
2. **A fix ships with a test that failed before it.** Say so in the PR.
3. **Deleting something follows the protocol:** prove it is dead, add the gate before the
   deletion, one scoped commit, then drive the real surface.
   → [`docs/ENGINEERING_STANDARD.md`](../docs/ENGINEERING_STANDARD.md)

## Building a block

A block is a folder in `src/blocks/`. Copy `src/blocks/_template/`, rename it, and edit
`block.manifest.json` — the manifest is the block's declaration of itself, and the kernel
and gates check the code against it. Lint before opening a PR:

```bash
npm run aeon -- lint my_block
```

→ [`docs/BLOCK_STANDARD.md`](../docs/BLOCK_STANDARD.md)

## Commit messages

Say what changed and **why**, with the evidence: the failing test, the measurement, the
CI run. A reader six months from now should not need the PR thread to understand it.
