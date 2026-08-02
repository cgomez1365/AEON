# ⚙️ AEON Block: Settings

**ID:** `settings`
**Route:** `/settings`
**Tier:** `core` (always shipped, always mounted)
**Nav group:** `system`, order `0`

Settings is the nervous system of AEON. Every other block that calls an LLM
reads its model from here (`kernelLLM(..., { role })` → endpoint-registry →
`aeon-settings.json`); every provider key, every Supabase/Firebase toggle,
and every block's own declared settings live behind this one screen. It is
the single most load-bearing surface in the app — if you break the
save-patch contract or the manifest-read path here, every other block that
reads a model assignment or a preference silently degrades.

This file documents `index.jsx` (large, ~3200 lines — see below for why),
the four files under `api/`, and the contracts other blocks rely on.

## The single-source-of-truth model (read this first)

Settings does not hardcode per-block dials. It **reads manifests** and
renders itself from what it finds. Three concerns, three sources of truth,
never a fourth place to set the same thing:

| Concern | Source of truth | Dead / removed |
|---|---|---|
| Secrets/keys | vault (`secrets/aeon-vault.json`, mirrored to Supabase) | `.env` for *shared* keys — `.env` is still used for the first-run wizard and provider keys, but the vault is preferred once "Add connection" is used |
| Model per role | endpoint-registry `roles` (primary, `src/kernel/endpoints.cjs`) + `aeon-settings.json`'s `settings.models` (fallback) | `settings.blockConfig` — the old per-block dual-dial. See "Known dead surface" below; the backend routes still exist but nothing calls them |
| A block's AI usage | `block.manifest.json` → `contract.ai.role` + `contract.ai.blurb` | hardcoded per-block panels — deleted in the 2026-07-16 rebuild (was 12 stacked accordions) |

`kernelLLM` resolves a role as: endpoint-registry `resolveForRole(role)`
**first**, then `settings.models[role]` as fallback. `updateRole()` in
`index.jsx` and `POST /api/settings/nl` both write **both** stores on every
change specifically so they never drift apart — if you add a new way to set
a role's model, it must write both too.

## The tabs

`index.jsx`'s `SystemSettings` component renders nine tabs
(`TABS` array, ~line 2298). Each tab owns exactly one concern — the
2026-07-16 rebuild's explicit goal was "a setting lives in exactly one
place," replacing an older 12-accordion layout that had the same control
reachable two different ways.

1. **Get Started** (`tab === 'start'`) — `GetStartedStrip` (three-step
   status: key added, Supabase connected, blocks ready) plus
   `BlocksNeedsPanel` (see SCI below). This is the CEO-simple landing view:
   two real actions, live status, zero jargon.

2. **Models** — the **only** place model-per-role is set. Renders one
   `RoleCard` per key in `settings.models` (roles are derived from whatever
   the settings file actually contains — `deriveRoles()`, no hardcoded
   list, so a new role key just needs an entry in `ROLE_DEFAULTS` for a
   nice label or it falls back to an auto-derived one). Each `RoleCard` has
   a Provider `<select>` and a searchable `ModelPicker`. Below the role
   cards: an "Automation (advanced)" `<details>` for Roulette mode
   (auto-rotate free API keys) and agent step-review, then Vision
   settings. **Every block that declares `contract.ai.role` inherits
   whichever model is set for that role here** — there is deliberately no
   second per-block model dial.

3. **Blocks** — `blocks-grid` of every installed block (from
   `GET /api/settings/blocks`, which is manifests + `blockStandard`
   readiness merged) as a ready/not-ready chip, followed by
   `BlockSettingsPanel` — see "How a new block's settings appear
   automatically" below.

4. **Services** — `ServicesPanel`: Supabase setup (three numbered steps:
   save & test credentials, provision tables, sync), the Firebase config
   paste box + the honest tracking toggle (Firebase is optional
   analytics, **not** the login gate — see Account below), the Cloudflare
   Tunnel panel, and `DeployCard` (the export-bundle link).

5. **Keys** (tab id `connections`, badge shows `connected/total` providers)
   — `UnifiedConnectionsPanel`, itself four sub-tabs: **LLM Keys**
   (`KeyScanner` — paste any key, AEON detects the provider by prefix
   then confirms with a real list-models call, plus `ConnectionsPanel` for
   the vault-backed endpoint registry), **Search Keys** (Tavily → Serper →
   Brave → DuckDuckGo priority chain), **Services & Cloud** (infra/service
   provider status + Supabase/Firebase, reusing the same panel as the
   Services tab), **Remote Access** (the Cloudflare Tunnel panel again —
   intentionally reachable from both here and Services, since a user
   might land on either tab looking for it).

6. **Account** — `AccountPanel` (login/profile/change-password against the
   security block's session API) plus the `require_login` preference
   toggle. **Read the "Known dead surface" section below before touching
   this tab** — two of its three write actions call routes that do not
   exist in the current kernel.

7. **Agent** — `BuildQueuePanel` (pending block-build approvals from the
   Build Pipeline, `/api/build/*` — HIGH-score items require reviewing the
   diff before Approve unlocks) plus tool-permission toggles
   (`tool_filesystem`, `tool_shell`, `tool_web_search`, etc. — these are
   preferences read by the agent/mission runner elsewhere, not enforced by
   Settings itself).

8. **Appearance** — theme/accent/font-size/sidebar-width
   (`AppearancePanel`), plus an "Advanced theme colors" `<details>`
   (`ThemeBuilder` — full color picker with complementary/analogous/triadic
   harmony generation).

9. **System** — general preferences (auto-sync, telemetry, sound, auto-
   backup), the Second Brain index status card, and an "Environment
   variables" `<details>` showing every detected `.env` key's status
   (`configured` / `vault` / `missing`) without ever showing a value.

## SCI — Settings Confidence Index

`sciFor(block, models, health, supabaseOk)` (in `index.jsx`, used by
`BlocksNeedsPanel` on the Get Started tab) scores each AI-capable block
0–100 from **observed state, never hope**:

- **+40** — a model is actually assigned to the block's declared role
  (`contract.ai.role`) in `settings.models`.
- **+40** — that role's provider is actually reachable right now. The local
  runtime counts as alive unless `health.localConfirmed === false`; every other
  provider needs `health.providers[provider].healthy` from
  `GET /core/provider-health`.
- **+20** — if the block also declares `supabase` in `requires.apis`, it
  only earns these points when the Services tab reports `attached: true`
  from `GET /api/settings/connectivity`. Blocks that don't need Supabase
  get these points for free.

80+ is the "deploy-ready" threshold shown in the badge tooltip. The
aggregate score at the top of `BlocksNeedsPanel` is the mean SCI across
every block that declares `contract.ai.role` — it is computed client-side
from three fetches (`/api/settings/blocks`, `/api/settings`,
`/core/provider-health`, `/api/settings/connectivity`); there is no
dedicated SCI server endpoint.

## Manifest-as-truth: how block cards render themselves

`BlocksNeedsPanel` does not know about ATS Engine, Deep Research, or any
other block by name. It fetches `GET /api/settings/blocks` (every
`block.manifest.json` in `src/blocks/*`, readiness-checked), filters to
`blocks.filter(b => b.contract?.ai?.role)`, and renders one row per match:
icon, label, `contract.ai.blurb`, an SCI badge, and "USES YOUR
`<ROLE>` MODEL → `<current model>` ✎" that jumps straight to the Models
tab. **Install a new block that sets `contract.ai.role` and `contract.ai
.blurb` in its manifest, and its card appears here with zero changes to
this file.** Remove the block, and the card disappears on the next
`GET /api/settings/blocks` — nothing to clean up.

The same manifest field powers `GET /api/settings/export-bundle`
(`api/settings.js`) — it walks every manifest's `contract.ai.role` to
compute which provider keys a client deployment needs, and lists every
block's id/label/role in the exported bundle.

## The save contract: PATCH-merge vs. full POST

`POST /api/settings` (`api/settings.js`) accepts two different bodies and
they are **not interchangeable**:

```
{ patch: {...} }     → deep-merged into the file on disk (read-modify-write)
{ settings: {...} }  → full replace of the entire settings file
```

`index.jsx`'s save flow (`patchRef`, `addPatch()`, `save()`) **only ever
sends `{ patch }`**. Every control on every tab — `updateRole`,
`updateBlockSetting`, the Roulette toggle, all of it — calls `addPatch()`,
which deep-merges into a `useRef` accumulator, not into local React state
directly. `save()` POSTs only that accumulated patch and clears it after a
successful write. This exists specifically to fix a "settings never save"
bug: if two tabs (or two browser sessions) both read the settings file,
then one saves a full-object POST, the second save silently clobbers
whatever the first one wrote in between — last-writer-wins data loss.
Deep-merge patches don't have that failure mode; they only touch the keys
that actually changed.

**`{ settings: {...} }` (full replace) exists for exactly one legitimate
case: explicit import/restore of an entire settings file the user
downloaded or is migrating from another machine.** No control in
`index.jsx` uses it today. If you add a feature to this block, use `patch`
— a full-object POST from a partial-edit UI reintroduces the exact bug the
patch system was built to close.

`PrefToggle`/`savePref()` and `PUT /api/prefs/:key` are a separate, simpler
single-key write path (used for things like `require_login`,
`vision_enabled`, appearance) — no patch/merge concern there since each
call only ever touches one key.

## How a new block's settings contract gets picked up automatically

A block declares its own settings controls in its manifest:

```json
"contract": {
  "settings": [
    { "key": "widget_enabled", "label": "Dashboard widget",
      "desc": "Show this block's quick-view card on the dashboard",
      "type": "toggle", "default": true }
  ]
}
```

`BlockSettingsPanel` (in `index.jsx`, rendered on the Blocks tab) reads
`INSTALLED_BLOCKS` from the frontend's own block registry
(`src/kernel/blockRegistry.js` — the same source nav uses, so this list is
always exactly what's mounted) and filters to
`b.manifest?.contract?.settings?.length > 0`. For every match it renders
one card with one control per declared setting
(`type: toggle|select|number|text|secret` — see `BlockSettingControl`).
Values live at `aeon-settings.json → blockSettings.<blockId>.<key>`, saved
through the same patch-merge path as everything else
(`updateBlockSetting` → `addPatch({ blockSettings: { [blockId]: { [key]:
value } } })`).

**A block that adds `contract.settings` gets a working settings card with
zero changes to this file.** Remove the block (or its `contract.settings`
array), and its card disappears on next load. A block reads its own
resolved settings (manifest defaults merged with saved overrides) via
`GET /api/settings/block/:id` — `api/settings.js`'s handler for that route
merges `contract.settings[].default` with `settings.blockSettings[id]` and
returns one flat `values` object; the block never has to know or care
whether a value came from a default or a user override.

## Files

- **`index.jsx`** (~3200 lines) — the entire UI. One default export,
  `SystemSettings`. Deliberately not split into multiple files despite the
  size: every sub-component here (role cards, connection forms, the setup
  wizard, the theme builder) shares the same toast system, the same
  `loadPref`/`savePref` helpers, and the same patch-accumulator save flow,
  and splitting them across files would make that shared state harder to
  audit, not easier. If you're adding a new tab, add it as a new function
  component in this file next to its siblings, following the existing
  pattern (fetch its own data in a `useEffect`, degrade gracefully with
  `.catch(() => {})`, and never call an endpoint this README (or a grep of
  the actual backend routers) can't confirm exists).
- **`api/settings.js`** — the core CRUD surface: `GET`/`POST
  /api/settings` (load/patch-merge/replace), `POST /api/settings/nl`
  (deterministic natural-language `/set` parser for the terminal),
  `GET /api/settings/export-bundle` (client-ready config, secrets
  stripped), `GET /api/settings/block/:id` (a block's resolved settings),
  `GET`/`PUT /api/prefs/:key`, `GET /api/settings/blocks`
  (manifests + readiness), the "nervous system" provider builder
  (`GET /api/settings/providers`, `/nervous-system`, `/provider-details`,
  `/provider-blocks`), `POST /api/settings/test-provider/:id` (live
  connection test against the real provider API), the legacy
  `block-config*` routes (see "Known dead surface"), `GET
  /api/settings/resolve-endpoint`, and the first-run onboarding surface
  (`GET /api/settings/setup-status`, `POST /api/settings/env`,
  `POST /api/settings/restart`).
- **`api/connections.js`** — the endpoint registry + vault: `GET`/`POST
  /api/connections`, `POST /api/connections/discover` (probe a base URL
  for models), `DELETE /api/connections/:id`, `POST
  /api/connections/assign-role`, `GET /api/connections/resolve/:role`
  (debug — never leaks the key, only reports presence), `POST
  /api/connections/sync` (force-push the local registry + vault to the
  Supabase mirror).
- **`api/connectivity.js`** — Supabase cloud mirror (test/save/setup
  tables/sync-now) and the Cloudflare Quick Tunnel (downloads
  `cloudflared.exe` on first use, spawns it, parses the `*.trycloudflare
  .com` URL from stdout). **Windows-specific** — see "Known gaps" below.
- **`api/model-scan.js`** — `POST /api/connections/detect` (paste a key,
  guess the provider from its prefix, confirm with a real list-models
  call against each candidate in order) and `GET
  /api/connections/scan-all` (re-probe every saved connection and refresh
  its cached model list).
- **`block.manifest.json`** — kernel metadata, auto-normalized on boot.
- **`.aeon.runtime.json`** — **auto-generated on boot, do not hand-edit.**

## API routes this block calls (frontend → backend)

Every `fetch()` in `index.jsx` was checked against the actual backend
route tables (this block's own four `api/*` files, plus a whole-repo grep
for kernel and other-block routers) as part of this audit. Summary by
owner:

- **This block's own routes** (`/api/settings/*`, `/api/connections*`,
  `/api/prefs/*`) — all confirmed present in the four files above.
- **Kernel routes** — `/core/provider-health` (`src/kernel/routers/core
  .cjs`, mounted at `/core`), `/api/build/queue*`, `/api/build/blocks*`
  (`src/kernel/routers/build.cjs`, mounted at `/api/build`), `/api/auth
  /status`, `/api/auth/login`, `/api/auth/logout`
  (`src/kernel/authGate.cjs`) — all confirmed.
- **Other blocks' routes** — `/api/crn/second-brain/index-status`
  (`src/blocks/aeon_matrix/api/ingest.cjs`, a `(deps) => router` factory
  mounted at `/api` by the block host, so its internal `/crn/second-brain
  /index-status` route lands at `/api/crn/second-brain/index-status` —
  confirmed, matches).

### Confirmed dead calls — do not treat as working

Three calls in `AccountPanel` and the Setup Wizard's account step target
routes that **do not exist anywhere in the current kernel**. The only auth
routes implemented are `GET /api/auth/status`, `POST /api/auth/login`,
`POST /api/auth/logout` (`src/kernel/authGate.cjs`) — confirmed by
grepping the whole repository, not just this folder.

| Dead call | Caller | What happens today |
|---|---|---|
| `POST /api/auth/setup` | `SetupWizard`'s account step (`index.jsx`), and `src/kernel/auth.js`'s exported `setupAccount()` | 404 |
| `POST /api/auth/profile` | `AccountPanel.saveProfile` (`index.jsx`) | 404 |
| `POST /api/auth/change-password` | `AccountPanel.changePw` (`index.jsx`) | 404 |

Unlike `GET /api/auth/status` — which both `AuthGate.jsx` and
`AccountPanel.refresh()` explicitly guard for a 404 and fall back to an
honest "Operator auth is not installed in this build" empty state — these
three call sites call `r.json()` on the response with no 404 guard. A 404
comes back as an HTML error page, `r.json()` throws, and the button's
`busy` state never clears: Save Profile / Change Password / the wizard's
account step hang in a stuck "Saving…" state with an unhandled rejection
in the console instead of a clean error toast.

This is a real gap, not a guess — it's independently documented in
`src/blocks/security/README.md` (which this audit cross-checked and
matches exactly, including the caller list). It was **not fixed by this
audit**: fixing it means either (a) implementing `/api/auth/setup`,
`/profile`, `/change-password` in `authGate.cjs` — a real design decision
about whether the new stateless single-operator-password gate should grow
a multi-field account model at all, since it currently has no concept of
a display name, email, or per-account password separate from
`AEON_OPERATOR_PASSWORD` — or (b) removing the three dead call sites and
the UI that triggers them. Both are judgment calls outside a settings-only
audit's scope; flagging here so the same gap isn't rediscovered as a
mystery in a future session.

## Manifest honesty (`contract.permissions`)

Spot-checked against real code as part of this audit:

- **`filesystem: "write"`** — accurate. `api/settings.js` writes
  `aeon-settings.json` (`saveSettings`) and `.env` (`writeEnvVars`,
  `POST /api/settings/env`); `api/connectivity.js` also writes `.env`
  (`upsertEnv`) for Supabase credentials.
- **`shell: true`** — accurate. `api/settings.js`'s `POST
  /api/settings/restart` and `api/connectivity.js`'s Cloudflare Tunnel
  both use `child_process.spawn`.
- **`secrets: true`** (fixed by this audit — was `false`) — `api
  /connections.js` and `api/settings.js`'s `test-provider` route both call
  `vault.getSecret` / `vault.setSecret` / `vault.listRefs` directly; this
  block **is** the vault's primary UI. `secrets: false` would strip the
  vault dependency from this block's scoped deps and break every "Add
  connection" and "Test" flow.
- **`network: "external"`** (fixed by this audit — was `"internal"`,
  which per `src/kernel/schema.json`'s enum specifically means
  same-origin-only calls). This block makes outbound calls to
  `api.groq.com`, `generativelanguage.googleapis.com`, `api.openai.com`,
  `api.anthropic.com`, `api.x.ai`, `openrouter.ai` (provider tests +
  model discovery), `github.com` (downloading `cloudflared.exe`), and
  whatever Supabase project URL the operator pastes in — all clearly
  third-party, not same-origin.
- **`ai: true`**, **`contract.ai.role: "chat"`**, **`contract.ai.blurb`**
  — present, verified in place (fixed in an earlier pass; this audit only
  confirmed, did not change). Note this block never calls `kernelLLM`
  directly itself — the role/blurb pair exists so `BlocksNeedsPanel`'s own
  aggregate SCI and the Blocks tab can represent "this is the block that
  resolves per-role models for everyone else," per the existing
  `blurb` text ("Powers per-role model resolution for `/set` and
  connection tests").

**Reviewed and left as-is:** `requires.apis: []` / `requires.env: []`.
Settings can call out to any provider a user configures, but it does not
*require* any specific one to be present to load or to be useful — every
panel degrades to an honest "not configured" state with zero keys set.
That's a different contract than "this block requires `groq`" (which
would make the block report not-ready with no keys at all), so leaving
both empty is correct, not an oversight.

**Judgment call, not changed:** `contract.storage.scope: "block"`.
`aeon-settings.json` is genuinely shared — `prefs`, `blockSettings.<id>`,
and `models` in that one file are read and written by many other blocks
(`GET /api/settings/block/:id`, `GET`/`PUT /api/prefs/:key`), not scoped
to Settings alone. `"global"` might describe the actual file more
accurately than `"block"`. Not changed here because re-scoping storage
metadata could have effects on tooling that reads this field that a
settings-only audit can't fully verify — flagging for a follow-up pass
with wider context.

## Known dead backend surface (safe leftover, not urgent)

`api/settings.js` still implements `GET`/`POST /api/settings/block-config`
and `POST /api/settings/block-config/auto`, reading and writing
`settings.blockConfig`. Nothing in `index.jsx` calls any of them — no
`fetch('/api/settings/block-config...')` anywhere in this file — and the
CSS classes that used to style that panel (`.block-config-panel`,
`.block-config-row`, etc., still present near the end of the `<style>`
block) have no matching JSX either. This matches the project skill's own
note that `settings.blockConfig` was "DELETED, was a placebo nothing
read" from the *UI* side; the *backend* routes were simply never removed
in the same pass. They're inert — nothing calls them, they can't corrupt
the live `settings.models`/endpoint-registry path — but a future cleanup
could delete both the two backend routes and the dead CSS rules together.

## Cross-platform note (not fixed — flagging)

`api/connectivity.js`'s Cloudflare Tunnel feature hardcodes
`cloudflared-windows-amd64.exe` and spawns it via `cmd.exe`-style
Windows process semantics, with no `os.platform()` check and no
mac/Linux binary fallback. `contract.targets` claims `docker: true` and
`cloudflare: true` for this block; on a Linux Docker image or non-Windows
host, "Start tunnel" would download a Windows PE binary that cannot
execute, and the failure would surface as an opaque spawn error rather
than a clear "not supported on this platform" message. Not fixed here —
a real cross-platform fix means detecting the OS/arch and fetching the
matching `cloudflared` release asset (Linux, macOS-arm64, macOS-amd64),
which is a small feature in its own right and risks getting the download
URLs wrong without a non-Windows machine to test against. `POST
/api/settings/restart`'s `cmd.exe`/`restart.bat` path has the same
Windows lean, but it already has a non-Windows-safe fallback
(`process.exit(0)` when `restart.bat` doesn't exist, with a comment
noting a supervisor/launcher is expected to relaunch it) — that one is
deliberately handled, the tunnel is not.

## Accessibility patterns in `index.jsx`

This is the most-used screen in the app, so it got a dedicated pass. What
to expect if you're extending it:

- **Every toggle switch** (`PrefToggle`, the block-settings boolean
  control, the Firebase tracking toggle, Roulette mode, the theme
  builder's Frosted toggle) is `role="switch"` with `aria-checked` and an
  `aria-label` — not just a colored `<button>` with no semantics.
- **Icon-only buttons** (remove-connection `×`, the accent-color swatches,
  the copy-tunnel-URL button) all carry `aria-label`; color swatches also
  get `aria-pressed` to reflect the current selection.
- **The main tab rail and the Keys sub-tab rail** are `role="tablist"` /
  `role="tab"` with `aria-selected` and roving `tabIndex` (selected tab
  gets `0`, the rest `-1`) — not a bare row of `<button>`s with only
  visual active-state styling. The setup wizard's stepper got the same
  treatment plus `aria-current="step"`.
- **Every input that had a visible `<label>` with no `htmlFor`** (account
  fields, service-account edit fields, role provider/model selects,
  the "Add connection" form) now has a matching `id`/`htmlFor` pair — the
  visible label was already there, it just wasn't programmatically wired
  to its control.
- **Inputs with no visible label at all** (login form, password-change
  fields, the key scanner, search-provider keys, Supabase/Firebase paste
  fields, the setup wizard) got `aria-label` from their existing
  placeholder text — chosen specifically because it adds zero visible
  layout change; a real `<label>` would have required redesigning those
  compact rows.
- **The two custom dropdown "combobox" list patterns** (`ModelPicker`'s
  search dropdown, `BlockAssignPicker`'s block-search dropdown) were
  plain `<div onClick>` rows with no keyboard path — a mouse-only user
  could select a model or a block, a keyboard-only user could not. Both
  now use `role="listbox"`/`role="option"`, `aria-selected`, `tabIndex={0}`,
  and an `onKeyDown` handler for Enter/Space. The single expandable
  service-account row (`AccountIdentities`) had the identical gap — a
  `<div onClick>` accordion trigger — and got the same treatment
  (`role="button"`, `tabIndex={0}`, `aria-expanded`, keyboard handler).
- **`outline: none` without a replacement** — found in three places
  (`.settings-select`, `.model-picker-search`, `.conn-block-search`).
  `.settings-select` already had a `:focus` border-color change; it was
  strengthened with a `box-shadow` ring (box-shadow never affects layout,
  so this was a safe non-layout change). The other two had **no**
  replacement at all — a keyboard user tabbing into either search box got
  no visible focus indicator whatsoever. Both now get a
  `:focus-visible` outline.

**Not done — deliberately, layout risk:** wiring `aria-controls`/`id` from
each tab button to a `role="tabpanel"` wrapper around its content. The tab
*buttons* have full `role="tab"`/`aria-selected` semantics now, but several
tab bodies are React fragments (`<>...</>`) rather than a single wrapped
element, and several tabs render more than one top-level `admin-card`.
Wrapping each in a labeled `tabpanel` div is the fuller-correct pattern,
but doing it for nine tabs' worth of already-fragment-based JSX is a
bigger, riskier edit than this audit's "don't change visible layout"
constraint allows for a mechanical pass — flagging as a good follow-up,
not attempting it blind.

## Self-test

```bash
node --check src/blocks/settings/api/settings.js
node --check src/blocks/settings/api/connections.js
node --check src/blocks/settings/api/connectivity.js
node --check src/blocks/settings/api/model-scan.js
node -e "JSON.parse(require('fs').readFileSync('src/blocks/settings/block.manifest.json','utf8'))"
```

`index.jsx` is JSX, not plain JS — `node --check` cannot parse it directly;
it is exercised by the app's normal Vite build/dev-server transform
instead.

## Activation

Auto-detected by the block host on boot — no manual registration. This is
a `tier: "core"` block; it ships and mounts unconditionally, unlike
optional plugin-tier blocks.
