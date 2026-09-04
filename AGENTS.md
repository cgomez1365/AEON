# AEON 3 — AI Assistant Briefing

AEON is an AI-native operating system: kernel + self-contained block cartridges + a Settings nervous system + an encrypted vault + one LLM service layer.

## Founding principles (never violate)
1. **Manifest is truth** — a block declares everything in `block.manifest.json`; nothing about a block is hardcoded elsewhere.
2. **Settings is the nervous system** — blocks declare needs upward, read config back down. One source of truth.
3. **Self-contained cartridges** — a block ships UI + API + assets + data. Drop the folder in `src/blocks/`, restart, it works.

## Map
| Path | What |
|------|------|
| `server/server.js` | Composition root — security → services → block loader → routers → listen |
| `server/block-loader.js` | Cartridge discovery, manifest validation, sandbox |
| `src/kernel/` | vault.cjs (AES-256-GCM), endpoints.cjs (model registry), commandRegistry.cjs (Terminal 2.0 bus), routers/ |
| `src/kernel/routers/god.cjs` | God mode: /open, /data reader, vault file drops, model hotswap, key adds |
| `src/blocks/*/` | Cartridges — manifest + index.jsx + api/index.cjs |
| `src/components/Terminal2.jsx` | The terminal: 3 verbs (chat, /command, >shell) |
| `services/storage.js` | VAULT_ROOT / DATA_ROOT seam — never hand-roll vault paths |
| `launch.js` | Consumer launcher: env detect, .env wizard, vault bootstrap, build, boot |

## Route namespaces
`/core/*` kernel · `/api/ai` LLM dispatch · `/blocks` registry · `/api/god/*` god mode (desktop only) · `/block/:id/*` + `/api/*` block routes · `/events` SSE · `/ws` WebSocket.

## Rules
- Patch, don't rewrite. Minimal diffs.
- Keys never reach the browser; no `VITE_` secrets; all AI calls via kernel.
- New capability? Make it a block with a manifest, not a kernel edit.
- The audience includes non-technical users — every UI string must be self-explanatory.
