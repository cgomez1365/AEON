# 🏛️ AEON Block: Council

**ID:** `council`
**Route:** `/council`
**Status:** `ACTIVE` (rebuilt 2026-07-18)

Multi-model **deliberation**, not a side-by-side A/B compare. A persistent,
operator-built roster of "councilors" (each a persona + a model AEON can
reach) answers a question independently, reads each other's answers and may
revise, then a designated **chair** synthesizes a verdict with attribution.
Every debate is auto-saved to the Second Brain vault as searchable history.

Runs entirely through `/api/ai` (frontend) and `kernelLLM` (backend legacy
routes), so it works with whatever providers are actually alive — it needs
**no cloud API keys** to function: the roster is seeded with local
models out of the box.

## Files
- `index.jsx` — UI: Debate / Roster / History tabs, client-orchestrates the
  3-phase debate loop (see below).
- `api/index.cjs` — Express router (dual-mounted at `/api`, so its routes
  answer at `/api/council/...`). Also still contains the legacy blind
  compare/vote "Arena" routes (`/compare/*`) from before the rebuild.
- `data/members.json` — the roster (created + seeded on first read if
  missing).
- `block.manifest.json` — kernel contract (permissions, requires, routes).

## Roster / member system
Each member is `{id, label, persona, provider, model, color, chair}`.
Members are **fully heterogeneous** — they do not inherit from Settings
roles; a council is meant to mix models/providers. `chair: true` marks the
member who writes the final verdict (falls back to the first councilor if
no chair is set).

On first run (no `data/members.json` yet), the roster is seeded with 4
councilors + 1 chair, all `provider: "local"`, so the block works with zero
configuration:

| Member | Persona | Model |
|---|---|---|
| Qwen 3.5 | pragmatic generalist | `qwen3.5:4b` |
| Second Brain | skeptic, stress-tests claims | `second-brain:latest` |
| Granite 4 | systems thinker | `granite4:3b` |
| Phi-4 | first-principles reasoner | `phi4-mini-reasoning:3.8b` |
| Qwen 3.5 (chair) | synthesizes the verdict | `qwen3.5:4b` |

Manage the roster from the **Roster** tab: add a member (name + optional
persona + assign any model from `/council/models`), reassign a member's
model, or delete a member. The UI blocks deleting below 2 members
client-side; see *Known limitations* below.

## Debate lifecycle (client-orchestrated in `index.jsx`)
1. **Opening** — each councilor answers independently via `/api/ai`
   (`role: 'chat'`, explicit `provider`/`model`), persona text prepended to
   the prompt. 150-word cap.
2. **Deliberation** — each councilor sees every other councilor's opening
   and gives a final position (may revise or defend). 120-word cap.
3. **Verdict** — the chair sees the full record (openings + finals) and
   writes: the verdict, where the council agreed, where it split, and a
   confidence rating.
4. **Save** — auto-POSTs `{question, verdict, opinions[]}` to
   `/council/debate/save`, which writes a markdown file to the vault.

If a councilor's model is unreachable, its opinion is recorded as
`(unavailable: <error>)` rather than aborting the whole debate.

## API routes (`api/index.cjs`, effective path `/api/council/...`)
| Method | Path | Purpose |
|---|---|---|
| GET | `/council/members` | List the roster (seeds it if `members.json` is missing). |
| POST | `/council/members` | Add a member `{label, persona, provider, model, chair?}`. |
| PUT | `/council/members/:id` | Edit a member (any of `label/persona/provider/model/chair`). |
| DELETE | `/council/members/:id` | Remove a member. |
| GET | `/council/models` | Live models AEON can reach right now (Settings roles + endpoint registry + live cloud env keys + installed local models). |
| POST | `/council/debate/save` | Persist a completed debate `{question, verdict, opinions[]}` to the vault as markdown. |
| GET | `/council/debates` | History list (newest 50, from the vault). |
| GET | `/council/debate/:id` | Full transcript for one saved debate. |

Legacy Arena routes still mounted (not used by the current UI, kept for
compatibility): `GET /compare/models`, `POST /compare/start`,
`POST /compare/:compId/vote`, `POST /compare/record`,
`GET /compare/history`, `DELETE /compare/:compId`, `GET /compare/scoreboard`.

## Storage
- **Roster**: `src/blocks/council/data/members.json` (plain JSON, block-scoped).
- **Debate history**: `<VAULT_ROOT>/Agents/council/debates/<iso-timestamp>.md`
  — one markdown file per debate, inside the `aeon_matrix` vault, so it's
  searchable by Second Brain and syncs across devices.
- **On Vercel** (`process.env.VERCEL` set): the filesystem is read-only
  outside `/tmp`, so both the compare-history file and the debate markdown
  files fall back to `/tmp` — durable copies live in the vault mirror when
  running locally/self-hosted; on Vercel they're ephemeral for the life of
  the instance.

## Config / settings / env keys
None are required — the seeded roster runs entirely on the bundled local runtime. These
are read opportunistically to widen the model menu in `/council/models`,
never to gate whether the block boots:
- `GROQ_API_KEY` — adds Groq models (Llama 3.3 70B, Llama 3.1 8B) to the menu.
- `GEMINI_FREE_KEY_1` / `GEMINI_PAID_KEY` — adds Gemini models (2.0/2.5 Flash, 2.5 Pro) to the menu.
- Local inference needs no host or port configuration: AEON manages the llama.cpp runtime and its models inside its own data root.
- `aeon-settings.json` (repo root, operator-generated by the Settings block) and the endpoint registry (`kernel/endpoints.cjs`) are also read, contributing whatever models the operator has already assigned to Settings roles.

## Known limitations (judgment calls, not fixed here)
- The "keep at least 2 members" rule is enforced **client-side only**
  (`RosterPanel`'s delete button is hidden when `members.length <= 2`); the
  `DELETE /council/members/:id` route itself has no floor, so a direct API
  call (or a second client) can still delete the roster down to 0/1 and
  break `convene()`. Left as-is since hardening it changes API behavior
  beyond this pass's scope — flagged for a follow-up if desired.
- Legacy `/compare/*` Arena endpoints are dead from the current UI's
  perspective (no `fetch` call in `index.jsx` targets them) but are kept
  mounted for backward compatibility; nothing currently calls them.
