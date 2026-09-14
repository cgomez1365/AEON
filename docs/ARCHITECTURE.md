# AEON — Architecture

AEON is a local-first AI workspace: a Node.js kernel that discovers self-contained blocks,
a React frontend that builds itself from those blocks' manifests, an encrypted vault for
keys, and one LLM layer that routes every AI call by role. It runs on the operator's own
machine; a cloud mirror is optional and off unless configured.

> Every path in this document is checked to exist by `tests/docs-truth.test.js`. It was
> rewritten 2026-09-14 because the previous version described blocks, routes and files
> that had been gone for months.

## Layers

```
┌──────────────────────────────────────────────────────────────┐
│ LAUNCH      launch.js · Desktop icon (tools/desktop-shortcut) │  first-run setup, build, boot
├──────────────────────────────────────────────────────────────┤
│ FRONTEND    Vite + React · nav and routes built from manifests│  src/components, src/kernel/blockRegistry.js
├──────────────────────────────────────────────────────────────┤
│ BLOCKS      src/blocks/<id>/ — manifest + UI + optional API   │  mounted by the block host
├──────────────────────────────────────────────────────────────┤
│ KERNEL      server/server.js — security → routers → blocks    │  commands, retrieval, build, store, console
├──────────────────────────────────────────────────────────────┤
│ SERVICES    services/ — ai, storage, cloud, search, media     │  kernelLLM lives in services/ai.js
├──────────────────────────────────────────────────────────────┤
│ STORAGE     Vault · data/ · secrets/ · .env                   │  every root redirectable by env var
├──────────────────────────────────────────────────────────────┤
│ PROVIDERS   cloud endpoints · bundled llama.cpp runtime       │  resolved per role by endpoints.cjs
└──────────────────────────────────────────────────────────────┘
```

## Launch

`launch.js` is what a double-click runs (`launch.command`, `LAUNCH.bat`, `launch.sh`). It
checks Node, walks a first-run `.env` wizard in which every prompt can be skipped,
bootstraps the vault key, installs dependencies and builds the frontend once, puts an AEON
icon on the Desktop (`tools/desktop-shortcut.cjs`; never on portable media), then starts
`server/server.js` and opens the browser once the port answers.

## Blocks

A block is a folder under `src/blocks/` with `block.manifest.json` (identity, permissions,
commands, settings, routes), `index.jsx` (the UI) and optionally `api/` (Express routes).
The manifest is the block's declaration of itself; `src/kernel/schema.json` defines it and
`src/kernel/staging.cjs` validates it.

- **Server side:** `server/block-loader.js` normalizes every manifest at boot and hands
  each block only the dependencies its manifest declares. `src/kernel/blockHost.cjs`
  mounts block routers at `/api` and `/block/<id>`, and remounts the whole set on rescan
  rather than diffing.
- **Client side:** `src/kernel/blockRegistry.js` discovers every manifest and component
  with Vite's `import.meta.glob`; `src/components/DesktopLayout.jsx` builds nav and routes
  from it. Adding a block needs no edit to the layout.
- **Generated, not hand-kept:** `docs/BLOCKS.md` and each manifest's route list are
  written by `scripts/gen-block-docs.cjs` and `scripts/gen-block-routes.cjs` during
  `npm run build`, so they cannot drift from the code.

Blocks share one Node.js process. The manifest governs what the kernel injects; it is not
a sandbox against hostile code.

## The LLM layer

Blocks never name a provider. They call `kernelLLM(prompt, { role })` (`services/ai.js`),
which asks `src/kernel/endpoints.cjs` which endpoint and model serve that role. Roles
include `chat`, `grading`, `vision`, `research`, `creative`, the agent roles, and `embed`
for the Second Brain. An endpoint is either a cloud provider the operator added a key for,
or the bundled llama.cpp runtime managed inside the data root
(`services/local-runtime/paths.cjs`). Every call is recorded once in the LLM ledger
(`src/kernel/llm-ledger.cjs`).

The kernel's AI routes are `POST /api/ai` (a bare prompt), `POST /api/ai/converse` (a
conversational turn with memory and vault recall, policy in `src/kernel/context.cjs`) and
`POST /api/ai/vision`.

## The terminal

`src/components/Terminal2.jsx` has three verbs in one input: plain text is a conversation,
`/` runs a command, `>` is the shell sigil. Commands are declared in block manifests and
dispatched by `src/kernel/commandRegistry.cjs`; the terminal holds no dispatch logic of its
own.

## Storage

Every writable root defaults to a child of the **AEON home** — `~/AEON` on every OS,
or `AEON_HOME`. The install directory holds code and tracked seeds only, so it can be
read-only and a reinstall is `git pull`.

| Root | Default | Override | Holds |
|---|---|---|---|
| Home | `~/AEON` | `AEON_HOME` (process environment only — `.env` lives inside it) | everything below |
| Vault | `~/AEON/Vault` | `VAULT_PATH` | documents, memories, block memory — durable |
| Data | `~/AEON/data` | `DATA_PATH` | indexes, models, block state — regenerable |
| Secrets | `~/AEON/secrets` (mode 0700) | `AEON_SECRETS_DIR` | keyslots, endpoint registry |
| `.env` | `~/AEON/.env` | `AEON_ENV_FILE` | master key, configuration |
| db | `~/AEON/db` | `AEON_DB_DIR` | chat/audit logs, retrieval indexes, run state (the `*.sql` seeds stay in the install's `db/`) |
| Settings | `aeon-settings.json` in `~/AEON` | `AEON_SETTINGS_FILE` | the nervous system's settings |
| Workspace | `~/AEON` | `AEON_WORKSPACE` | what file tools may open |

`src/kernel/aeonHome.cjs` resolves the home and every root (and is the only module allowed
to ask for the home directory); `services/storage.js` exposes the Vault and Data roots and
`src/kernel/envFile.cjs` the `.env` path — nothing else computes them. A portable install
(`AEON_PORTABLE=true`) keeps every default inside the install: the drive is the home.

An install from before the home existed has its data inside the install directory.
`src/kernel/homeMigration.cjs` moves it on the next launch — once, root by root, refusing a
populated target rather than merging, and recording progress in `home.json` inside `~/AEON` so an
interrupted run resumes. It runs at the top of both `launch.js` and `server/server.js`.

Keys are encrypted at rest (AES-256-GCM, `src/kernel/vault.cjs`). The `.env` master key and
the keyslots file in `~/AEON/secrets` are two halves of one protector: move both or neither
(the migration moves them as a pair).

## Cloud (optional)

`services/cloud.js` creates a Supabase client only when keys are configured, and never when
`AEON_LOCAL_ONLY=1` or `AEON_PORTABLE=true`. Every consumer handles its absence. There is
no cloud deployment of AEON itself; see [`DEPLOYMENT.md`](DEPLOYMENT.md).

## Ports

- `3001` — the kernel. In production it also serves the built frontend from `dist/`.
- `3000` — the Vite dev server during development only (`npm start`), proxying `/api` to `3001`.

## Further reading

[Kernel](KERNEL.md) · [Blocks](BLOCKS.md) · [Block standard](BLOCK_STANDARD.md) ·
[Memory architecture](MEMORY_ARCHITECTURE.md) · [Security](SECURITY.md) ·
[Engineering standard](ENGINEERING_STANDARD.md)
