# AEON Kernel

The kernel is `server/server.js`: the composition root that loads configuration, applies
security, mounts the kernel routers and every block, and listens. It holds no business
logic of its own. `server.cjs` at the repo root is a one-line shim that re-exports it.

> Rewritten 2026-09-14. The previous version documented a `routes/*.js` layer, a trading
> engine and modules that no longer exist. Every path below is checked by
> `tests/docs-truth.test.js`; the order below is the order in `server/server.js`.

## Boot sequence

1. **Configuration.** The `.env` path is resolved once by `src/kernel/envFile.cjs`
   (`AEON_ENV_FILE`, else `.env` in the AEON home — `~/AEON` or `AEON_HOME`; a portable
   install keeps it in the install, see `src/kernel/aeonHome.cjs`) and loaded with dotenv.
2. **Vault.** With no master key, a first-run guard mints one — unless keyslots already
   exist, in which case it refuses and leaves the vault sealed for recovery rather than
   writing a key that unlocks nothing (`src/kernel/vaultBootGuard.cjs`). Keyslots (file +
   recovery) are then ensured (`src/kernel/vault.cjs`).
3. **Security middleware** (`security/security.js`), in order: correlation id, CORS
   allowlist, Helmet, JSON body parsing (10 MB), rate limiting on `/api`, `/core` and
   `/block`, and the tunnel gate on `/api`.
4. **Earlyware** (`server/earlyware.cjs`) — a replace-by-id hook list that drag-in blocks
   such as Security register into before any route runs.
5. **Search** (`/api/search-web` and friends) and **customization** routes
   (`server/routes/customize.cjs`).
6. **Authentication** — login routes and the global guard (`src/kernel/authGate.cjs`).
7. **Blocks** — `server/block-loader.js` normalizes every manifest, gives each block only
   the dependencies its manifest declares, and mounts block routes through
   `src/kernel/blockHost.cjs` at `/api` and `/block/<id>`. A rescan tears down and remounts
   the whole set.
8. **Kernel services**
   - `/api/build` — build pipeline: envelope → gate → staging → approve → promote → rescan
   - `/api/store` — catalog and install through the lint airlock
   - `/api/retrieval` — scoped indexes and the citation gate
   - `/api/commands` — manifest-discovered command dispatch (`src/kernel/commandRegistry.cjs`)
   - `/api/console` — the Operator Console, behind `requireOperator`
9. **Core routers** (`src/kernel/routers/`): `/core`, `/core/telemetry`, `/api/ai`, `/blocks`,
   `/events`, with `/api/system`, `/api/llm-telemetry` and `/api/blocks` as aliases.
10. **Token analytics** and the **Second Brain** routes, then the boot index: an incremental
    Vault scan 15 seconds after start, plus a nightly re-index at 03:00.
11. **Autopilot** (`tools/autopilot-daemon.cjs`).
12. **Frontend.** When `dist/` exists, it is served statically with an SPA fallback for any
    path that is not `/api`, `/core`, `/events`, `/ws` or `/block`.
13. **Listen** on `PORT` (default 3001), then attach the WebSocket at `/ws`
    (`src/kernel/ws.cjs`).

## LLM layer

`kernelLLM(prompt, { role })` in `services/ai.js` is the one way the kernel and blocks call
a model:

1. Resolve the role through the endpoint registry (`src/kernel/endpoints.cjs`, stored in
   `secrets/aeon-endpoints.json`). Roles include `chat`, `grading`, `vision`, `research`,
   `creative`, the agent roles and `embed`.
2. Dispatch to the resolved endpoint — a cloud provider or the local llama.cpp runtime (downloaded by Cookbook, not bundled).
3. Only if the registry cannot resolve the role, fall back to the legacy per-role settings.

HTTP surface (`src/kernel/routers/ai.cjs`):

```
POST /api/ai            { prompt, role?, provider?, model?, background?, advisorModel?, agent? }
                                                     a bare prompt
POST /api/ai/converse   { message, history?, contextTokens?, agent? }
                                                     a conversational turn with memory + vault recall
POST /api/ai/vision     { image, prompt?, provider?, model? }   (model only with provider)
                                                     vision role
```

Every call crosses one seam, `_trackLLM`, and is appended once to the LLM ledger
(`src/kernel/llm-ledger.cjs`), which the Activity and Fleet Control blocks read.

## Agent turns

A chat turn in the terminal (`src/blocks/dashboard/api/chat-stream.cjs`) runs through six
kernel modules added in 3.3.0. The ones that touch files are given the Vault root by the
caller; none looks up a home directory itself.

| File | What it does |
|---|---|
| `src/kernel/agentTurn.cjs` | The turn: a bounded loop of `kernelLLM.stream` rounds — run a tool between rounds, or continue an answer cut off by the output limit — emitting the SSE events the terminal shows. |
| `src/kernel/toolProtocol.cjs` | The provider-independent text protocol: the `## TOOLS` prompt text, the stream scanner and parser for `aeon-tool` blocks, the data wrapper for results, and the claim check. No I/O. |
| `src/kernel/agentTools.cjs` | The eight tools, their limits (`LIMITS`: 6 calls and 3 writes per turn, size caps, timeouts), argument checks and every privacy refusal. No shell, no code execution, no arbitrary HTTP: outside this computer it reaches only the web search service, the query embedding `vault_search`'s retriever makes, and `ask_agent`'s call to the asked agent's own model (its own provider and privacy, which can differ from the chat's), and the Vault indexing a save starts (it embeds the saved text with the Embedding role's model, a cloud one when no local embedding model is installed); `memory_save` and `vault_search` call AEON's own routes over loopback. No tool reads or lists an agent's memory folder, saved chats or security records (`vaultPrivacy.inMemoryFolder`, `neverShared`). |
| `src/kernel/continuation.cjs` | The prompt that asks a model to carry on, and the seam that drops a repeated overlap (12 characters or more), a restarted sentence or line (4 or more), or a preamble. No I/O. |
| `src/kernel/vaultPath.cjs` | Resolves a model-supplied Vault path or refuses it: traversal, absolute paths, hidden files and OS junk, symlink escapes. |
| `src/kernel/agentWorkspace.cjs` | An agent's scratchpad, handoffs and artifacts in `Vault/Agents/<Folder>/`, and the block of them injected into its prompt. |

## Kernel routers

| Mount | File | What it serves |
|---|---|---|
| `/core` | `src/kernel/routers/core.cjs` | state, health, provider health, audit |
| `/core/telemetry` | `src/kernel/routers/telemetry.cjs` | LLM telemetry |
| `/api/ai` | `src/kernel/routers/ai.cjs` | model calls (above) |
| `/blocks` | `src/kernel/routers/blocks.cjs` | registry, widgets, block state |
| `/events` | `src/kernel/routers/events.cjs` | server-sent events |
| `/api/console` | `src/kernel/routers/console.cjs` | block list, data reader, vault drops, model swap, key adds |
| `/api/build` | `src/kernel/routers/build.cjs` | block build pipeline |
| `/api/store` | `src/kernel/routers/store.cjs` | store catalog and install |
| `/api/retrieval` | `src/kernel/routers/retrieval.cjs` | scoped retrieval + citation gate |

## Security layers

1. **CORS allowlist** — localhost plus configured origins.
2. **Bearer auth** — headless callers present `AEON_MOBILE_SECRET`.
3. **Global auth guard** — once an operator account exists, requests need a session.
4. **Read gates vs execution gates** — reads, reports and syncs use `requireOperator`
   (`src/kernel/server-utils/requireOperator.cjs`); privileged OS operations use
   `requireShellAuth`, which requires an operator session from every origin, loopback
   included, and fails closed.
5. **No shell execution surface** — `POST /api/os/action` runs named operations with a fixed
   executable and argument array; no caller-supplied string reaches a shell.
6. **Path containment** — filesystem access is limited to `ALLOWED_ROOTS` and each block's
   declared scope; undeclared access is caught by `npm run scan:block-fs`.
7. **Audit** — OS actions and key events are appended to the audit log.

Keys never reach the browser. Blocks share one Node.js process: the manifest governs what a
block is given, and is not a sandbox against hostile code.
