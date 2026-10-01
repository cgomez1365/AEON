# Changelog

What changed between tagged releases of AEON, grouped by theme. Each line names the
commit it comes from, so it can be checked. A version is listed here only once it is
tagged; until then its heading says so.

<!-- Range of the 3.1.0 entry: v3.0.0 (e25f5ee, 2026-09-14) to fe93dbf (2026-09-30),
     169 commits; then dc8e3a1, the five launch commits 6defca4, 2b4b364, 801fda5,
     601155b and 0c80a7c, and the two release-prep commits on top of 0c80a7c (7c73e1a and
     its review fixes, "release prep" below), then the failover fix on top of d31ecd8
     and its review fixes ("failover fix" below; 179 commits in all). Anything merged after that and before the v3.1.0 tag
     is added here before tagging, and the heading's "not tagged yet" is replaced by
     the date. -->

## 3.1.1 — 2026-10-01

Same behaviour as 3.1.0; four features rebuilt from written specifications.

- **Re-implemented, behaviour unchanged:** context-window budgeting (the memory budget
  follows each model's real context window), recall and the wake phrase, chat distill to
  Memory Core with the /ask-doc quote hints, and Master → Install from the store
  (f37bbc8, bb5883a, 613c665, f6c3574, 56e7f05). 3.1.0's own tests for these features
  pass unchanged on the new code; new tests were added from the specifications.

## 3.1.0 — 2026-10-01

**Read before upgrading from 3.0.0:** 3.0.0 kept your data inside its own folder; 3.1.0
keeps it in `~/AEON` and moves it there on its first launch, from its own folder only.
Follow *Upgrading from 3.0.0* in the [README](README.md#updating-aeon) — in short, do not
start 3.1.0 from a fresh folder before your 3.0.0 data has been copied into it. Going back
from 3.1.0 to 3.0.0 is not supported.

### Security

- The auth guard judges the path Express actually routes: any letter case, `ALL` and
  `HEAD` methods, and the full mount path. In 3.0.0, with the guard on,
  `GET /API/connections` was answered without a session (3301153).
- `/blocks/*` sits behind the operator gate like `/api/*` (d20957b), and the
  `/block/<id>` copy of a block's API needs the same session as `/api` (273cd0a).
- `/ws` checks the request's origin and the operator session on upgrade (a182006).
- `.env`, which holds the vault master key, is written owner-only (0600) by the
  launcher and by the server, and an existing one is tightened on every launch
  (8fdff78, 02b4acb).
- Remote Access refuses to start a tunnel that no login protects, and says what
  protects it (e66dae2). The tunnel downloads the `cloudflared` build for this platform
  and architecture, extracting the macOS archive; an unsupported platform is refused by
  name (4008905, 5015de1).
- The "Require login" switch now switches the real login guard (8b3079c, cd5c719).
- Failed sign-ins, logout and break-glass recovery reach the audit screen (0b71417).
- Credential export asks for your password each time (1cee797).
- Internal calls forward the operator's session instead of failing with 401: the model
  picker, model swap, terminal key entry and Orion search (1a70d91, fe84009).
- A Guardian rescan no longer logs the operator out (1287db9).
- Supabase sync uses the one shared client, so `AEON_LOCAL_ONLY` and portable mode stop
  it as they stop everything else (4008905).
- Cookbook's model server binds to this computer only, and gets the model file it was
  asked for (5015de1).
- AEON answers only to its own names: `localhost`, `127.x`, `[::1]`, an IP address, the
  running tunnel's name, or a name in `AEON_ALLOWED_ORIGINS`. Any other `Host` is refused
  (421) before a route runs, which stops DNS rebinding (6defca4).
- A browser page is answered only from AEON's own origin, the Vite dev server or
  `AEON_ALLOWED_ORIGINS`. 3.0.0 trusted any localhost port, with credentials, and an
  unused `vercel.app` origin; a refusal is now 403, not 500, and HTTP and `/ws` share
  one rule (6defca4; the dead allowlist code was removed in release prep).
- While Remote Access runs with login off, tunnel requests are refused. The credential
  export before an account exists is refused to the tunnel, to other origins and to
  proxied requests (6defca4).
- File Manager's deny-list (`.ssh`, `.env`, `secrets`, …) matches every spelling the
  disk would open and the path the filesystem resolves (6defca4).
- The dev server (`npm start`) listens on 127.0.0.1 only (6defca4).
- Dependencies: adm-zip 0.6.1 (8d678cc); express, qs, body-parser, multer and
  ip-address updated (fe93dbf). Still open (`npm audit`, 2026-09-30): one high and three
  moderate advisories in vite 5 and its esbuild, all in the Vite *dev server*, which the
  installed app does not run — it serves the built interface through Express; and one
  high and one low in `@grpc/grpc-js`, first reported after fe93dbf, which arrives through
  `firebase`. AEON uses firebase only in the browser interface, whose build does not
  include grpc-js. Reasons and review dates: `docs/DEPENDENCY_DECISIONS.md`.

### Privacy

- Opening AEON contacts nothing but AEON: the fonts ship with it, Quick Links draws a
  letter badge instead of fetching each link's icon from Google, and a saved Deep Research
  report no longer loads Google Fonts (2b4b364).
- **Settings → Models → Local only** (off by default): no cloud model is tried, not even
  as a fallback, and the Vault is embedded only by a model on this computer or your own
  network (2b4b364).
- OCR's language data is read from disk, and downloaded from jsDelivr only with
  `AEON_OCR_DOWNLOAD=1` in `.env`. Without the data, an image or scanned PDF is reported
  as not read, with that remedy (2b4b364).
- The Narrator's default voice runs on this computer; online voices are marked (2b4b364).
- New [PRIVACY.md](PRIVACY.md): what AEON keeps and what it sends, to whom (601155b,
  updated in release prep, which added Orion Search reading its top web results from
  their own sites, packs installed from a link, and the launchers' Node.js install).

### Your data

- **Your data lives in `~/AEON`**, not in the install folder: Vault, `.env`, keyslots,
  models, indexes, logs and settings. An older install's data moves there on its next
  launch, once, root by root; a populated target is refused, never merged (ed02b7d).
- Nothing unreadable is treated as empty any more, so nothing is written over it: the
  keyslots and vault file (eec3f08), block storage, with atomic writes (7b4be1c),
  memories and the Matrix index (065b8d6), the Writer index (5fd86d3), and a damaged
  settings file, which is moved aside before defaults load (34d0fed).
- Provider and search keys written in `.env` move into the encrypted vault at start,
  each verified by reading it back before its `.env` line is commented out (eec3f08,
  ab2641c, efbe6e4). Removing a connection removes its keys from the vault (8e9f469)
  and stops them at once (5ebbf83).
- One AEON per data folder: a second server on the same home refuses to start (b16c479).
- A dead console window no longer turns into a crash loop that filled the disk; the
  crash log is capped (dec85d3).
- The Files editor no longer saves its 8,000-character preview over the real file
  (2be1968).
- The terminal no longer forks a saved chat on every tab switch (1e656d0), and reports
  failed saves instead of claiming them (c5826c4).
- Writer's "Push to Memory" writes to your Vault, not the install folder (51898bf); a
  rewrite the model cut off no longer replaces the document (6a556ff).
- Quick Links persist without Firebase (718b505).
- Building a carried drive refuses to replace the data it is running on (e44058b).
- The vault recovery code can be used: `node launch.js --recover-vault` on any layout,
  and the desktop launchers ask for it when the key in `.env` does not open the vault
  (0c80a7c).
- A portable USB drive (`build-usb.js` without `--carry-home`) keeps its vault key from
  boot to boot; its launchers rebuilt `.env` from the template and dropped the key, so the
  vault was sealed from the second boot on (release prep).

### Models, keys and roles

- Settings decides which provider and model serve each role; an unset role uses Chat
  (3efff20, 5ebbf83, fefde03).
- A connection can hold several keys. When one is rate-limited, out of credit or
  rejected, the call fails over to the next (18c5cea, 93e55f4, fbc6ce0, 4008905). This is
  failover across accounts or projects you are entitled to use, not a way around a
  provider's limits; check each provider's terms.
- When a provider fails, fallback (and Roulette mode, which shuffles the order) uses
  every provider you added, picks chat models, and says what happened in one line
  (5d80f41, 602ff12, 24f3a01).
- A rate limit is reported as a rate limit (66de40c), and "empty response" now names
  which of four failures happened (24bdb78).
- A paid OpenRouter model out of credits rests only the paid models and the same
  connection answers on a free one, asked for at most 1024 tokens on every path so the
  free model is not refused for its reservation; a request too large for a model is retried
  once with less context; Local's failures are named; fallback notices sit above the answer
  (failover fix).
- The model picker lists free models first, then a size guess it labels as a guess
  (3231a73, eb1ace3). Groq's retired Llama 3.x defaults are replaced (4008905).
- Memory spends the model's real context window (ae573f6).
- Default roles name a local model the catalog can install (`qwen3-1.7b-q8`, not
  `qwen3-1.7b-q4`) (0c80a7c).
- With no embedding model, `/ask` names the remedy (install nomic-embed-text in Cookbook)
  instead of sending you to `/index-brain` (0c80a7c).
- A key saved in Settings → Keys joins the running key pool at once, as the reply already
  said; a Gemini key Google rejects reads "key rejected" and hands the turn to the
  connection's next key (Google answers a bad key with 400, not 401, so it had not failed
  over), and the Test button shows Google's reason (release prep).
- Cookbook shows each model's licence before Install; Llama and Gemma rows link Meta's or
  Google's licence and use policy (601155b).

### Blocks and the store (pilot)

- Blocks can be stopped, removed and restored while AEON runs: Settings → Blocks, or
  `aeon block stop|start|remove|restore`. Remove moves the folder to
  `<home>/data/removed-blocks/`; it does not delete it (490947e, ff6cccb, ac0852f).
- A stopped block no longer takes the whole server, or the login, down with it (84ed0de).
- **Store, pilot only — nothing is for sale.** With `AEON_STORE` pointing at a store,
  Settings → Blocks lists it and installs or updates a pack by id, refusing a cartridge
  whose SHA-256 differs from the store's catalog; an update is swapped in only if it
  goes live, and rolled back if not (e3a537a, c3d3f57, 4a60f75, 8df1d78). Also
  `aeon store`, `aeon install <id | file.aeon | https-url>`, `aeon update <id>`.
- Lint and the install gate judge a block by the same rules (e79be34). Scaffolds and the
  Master guide name the real steps that make a block appear — routes, build, rescan — not
  a restart (ef8ffee, c37f82b, 4a7cc4b, ef14045).
- Readiness names a block's missing dependencies (c907243).

### First run and the launcher

- The launcher takes the first port from 3001 to 3020 that nothing answers on, and a
  second launch opens the AEON already running on this data folder instead of starting
  another (0c80a7c).
- An interrupted first install is detected and installed again, instead of reporting
  "Dependencies ready" and failing (0c80a7c).
- First run says plainly that there is no password until you create one, and the cloud
  database is optional; Settings no longer calls Supabase "the one setup that matters",
  and its pointers name tabs that exist (0c80a7c, release prep). The Security page no
  longer claims to protect a stolen laptop (0c80a7c).
- Settings' Get Started strip counts AEON as running once a key or a ready local model
  exists; Supabase, which is optional, no longer holds it back (release prep).
- On macOS older than 13.5, `launch.command` installs Node 22 LTS, which that macOS can
  run, instead of the current LTS, which it cannot (release prep).

### Carry AEON on a drive

- `node scripts/build-usb.js --target <drive> --carry-home` puts the app and its data on
  an exFAT drive with launchers for macOS, Windows and Linux (19cc759, 7afc174, 846dc58).
  Macs older than macOS 13.5 get Node 22 (6905691, 0431204); RESTART works from the drive
  (a88694c); updating the drive keeps its git checkout (5015de1). Only the macOS launcher
  has been run; the drive's Windows and Linux launchers have not yet run on real hardware.

### Second Brain, Matrix and terminal

- `/ask-doc` asks about one document, quickly or in full (4008905, e123caa).
- `/ask` shows its sources, `/recall` counts right, `/doc` opens by name and reads PDFs
  as text (4008905, 687db33, d12ed8b, 2a0b6c7). Scanned PDFs render properly for OCR
  (7f5eb33).
- `/remember` says what it stored and the memory is recallable at once (3225a7b);
  `/memory` matches every word (73a5ae4); distill reads the conversation in view, once
  (d93b19c, f9739bd).
- Complete answers from knowledge commands are shown as written, not re-narrated
  (3b3e9ce).

### Other block fixes

- Council, Writer and Resume Grader bound their streaming calls in time (69bcfd0);
  Council says when an answer was cut off (058e57f); Resume Grader's score is the sum of
  its breakdown and its failures say why (32052a8). Deep Research marks a cut-off report as
  partial (544917a, 2521f86). Orion reads the matching Vault passage and names its
  sources (ed9a877, 47247c6). Activity counts come from the call ledger (e75036c). Host OS
  gets a machine-health screen and a Restart that only offers what works (1143202,
  8facfd8, 10db47e). Cookbook's Stop stops on macOS and Linux (8e47086). Home screens
  report spend, calls and failures as they are, and Quick Links can be edited and
  reordered (4c89f25, 9e78a88, f55aa27).
- A local model's server exits when AEON does (5be3acb).
- Dashboard's Models card: the label sits in the ring's centre and the bar labels are
  readable (dc8e3a1).

### Removed

- 58 files nothing loaded (a88b2f0); 17 unused packages, the never-deployed Vercel
  mirror and a risky patch script (12b0b57); a 10-second poll nothing read (4fa1e2f);
  duplicate and dead routes (3c4c313, 304985e, b20ced0).
- The Google Apps Script service (`VITE_GAS_URL`), whose only consumer was deleted
  earlier, is gone from Settings, `.env.example` and its status route (release prep).

### Docs and licence

- README: the download link is the latest release; requirements, Gatekeeper steps, safe
  updates and the upgrade from 3.0.0 are written out; docs no longer call llama.cpp
  bundled; Backup and recovery is rewritten for the person running AEON (801fda5).
- LICENSE and Terms no longer promise a per-block licence that does not exist; the
  contact is GitHub Issues (601155b). The portable drive's README states the AEON
  Community License (it said Apache-2.0) (release prep).
- The dependency-audit gate covers the whole tree, and its acceptances were re-reviewed,
  to be reviewed again by 2026-10-31 (601155b).

### Known limits

See [RELEASE_NOTES_v3.1.0.md](RELEASE_NOTES_v3.1.0.md#known-limits).

## 3.0.0 — 2026-09-14

First tagged release (`e25f5ee`). **Superseded by 3.1.0; do not install it.** It lacks the
security fixes above and keeps its data inside its own folder.
