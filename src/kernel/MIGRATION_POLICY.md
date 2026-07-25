# Manifest Schema Migration Policy (K1 — Ship Plan v2)

Schema: `src/kernel/schema.json` · Current: **manifestVersion 1.1.0** · Frozen 2026-07-01
Owner of freeze: the operator. Every "can we add one field" request goes through them.

## Rules

1. **No silent extension.** A field not in `schema.json` does not exist. The kernel,
   UI, and gate all read the schema — adding a field means bumping the version here first.
2. **Minor bump (1.0 → 1.1): additive only.** New OPTIONAL fields with defaults applied
   by the normalizer (`blockStandard.cjs`). A v1.0 manifest MUST load unchanged under a
   v1.1 kernel. The normalizer supplies the default; the block author does nothing.
3. **Major bump (1.x → 2.0): breaking.** Renamed/removed/retyped fields. Requires:
   - a `migrateManifest(old)` function in `blockStandard.cjs` that upgrades v1 → v2 in
     memory at load time (installed blocks keep working without file edits),
   - a deprecation window of one full minor release where both shapes load,
   - a BUILD_LOG.md entry listing every field changed and why.
4. **Grandfathering.** Manifests without `manifestVersion` are treated as 1.0.0.
   The normalizer already coerces legacy shapes (string `deployment`, missing `contract`)
   — that pattern IS the migration mechanism going forward.
5. **Store rule.** Once BGI Store blocks exist, a breaking change breaks every installed
   instance on every user's machine. From that point, major bumps require the in-memory
   migration path (rule 3) to be tested against every store-published manifest before ship.

## Version log

| manifestVersion | Date | Change |
|---|---|---|
| 1.1.0 | 2026-07-23 | Added `contract.storage.local` and `contract.memory`. Local block data is operational/unindexed; declared durable memory is Vault-only and Matrix-indexed. New and installed v1.1 blocks receive only the scoped `blockStorage` API. |
| 1.0.0 | 2026-07-01 | Initial freeze. Canonical shape = BLOCK_STANDARD.md + blockStandard.cjs normalizer output. Added `contract.permissions.crossBlockRead` (Tier 1.5 declaration, Ship Plan GAP 1). |
