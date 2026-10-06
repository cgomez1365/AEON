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

## 3.3.3 — update of 2026-10-05 (the number stays 3.3.3; the tag was moved to this)

<!-- From the first v3.3.3 tag (18dcaed, 2026-10-04) to a26af72: 18 commits (`git rev-list --count 18dcaed..a26af72`),
     11 of them code (5840dc9, 4227d9a, 2a69606, 50dacc1, fe45e34, 8b54f42, e56c75e, 9f81181, 61877ae, eac9a47,
     5b4e2ab) and 7 changelog or docs only. On top of a26af72, the same-day terminal and rate-limit work: 33 commits
     named here (d02a98c, 869d913, cac4868, 756f856, de764cc, 81b493a, 985ef04, 8ac92cd, 12e19a3, a3c731c, 8e3bbff,
     583d020, 7734563, 7c086bc, 4647906, 58586fc: terminal bugs and their review fixes; 24964eb, 72fc893, a8ce8c0,
     e3bc8d6, 67d73ee, fd7ace6, 4196884, 104537a, d32b30a, f5c1e27, 9ea53cd: the rate-limit control; 3d4e411, 6f26f5d,
     42a774b, 5be5748, d04f857, bf6567b: gap closures and docs), then four fixes from the final review (0975f5d,
     1099f91, d4f0657, 9c07925), the lockfile refresh for two new advisories (e859fa6) and three changelog commits
     (ace26f1, 721d484 and the one holding this note): 41 commits in `git rev-list --count a26af72..HEAD`. History is not squashed. By the owner's choice the version number stays
     3.3.3 and the v3.3.3 tag and release were moved to include them, because the first 3.3.3 could not install the
     first paid block (it dropped a block's declared engine) and shipped Supabase SQL open to the public key. Anyone
     holding the 2026-10-04 3.3.3 should update (README, "Updating AEON"). -->

**You set each connection's requests-per-minute limit (Settings → Keys).** AEON paced only the generic custom
endpoint, so a Gemini key whose free tier allows a handful of calls a minute could only be discovered by hitting
the 429. Every connection card now shows how it is paced (*Paced to N requests/min*, *Not paced*, *Default: N/min*)
and a **Change** button; the Add form takes the number too. The number is yours: AEON ships none for any named
provider (only the generic custom connection starts at 30), because a provider's limit is your account's policy
and changes — type the one from your provider's own rate-limits page. 0 turns pacing off, whole numbers to 600.
It takes effect on the next request, is counted per key, is written to the audit log (whether changed with the
Change button or by re-saving the connection), and applies to every hosted transport (OpenAI-compatible, Gemini,
Claude, streamed or not), to a call that names its provider (a Council seat) as well as one routed by role, to
image reads, and to indexing. When the limit makes AEON
wait, the chat shows one line (`pacing: waiting 12s for gemini (your limit: 8/min)`); past a minute AEON stops
waiting, tries the next provider and names the setting instead of calling your provider down or telling you to add
a key. Not enforced, and said so in the README: a daily-request cap, tokens per minute, and the on-device Local
connection (nothing to stay under, so a limit on it is refused). Indexing and search draw on the same limit as
chat for that key; an indexing wait goes to the system log, not the chat. Also fixed on the way: re-saving a
connection (a label edit, an added key) no longer resets its limit or empties its model list. After review: Claude
assigned in Settings is not called a second time, unpaced, once the limit has stopped it; the closing step of the
error leads with the limit; a background call with no chat no longer swallows the chat's pacing line; the rule that
the limit never rotates your keys now has a test. After the final review: a call that names groq, gemini,
openrouter or claude, and every image read, had skipped the limit (three named Groq calls at a limit of 1 went out
in 28 ms) and now wait on it (d4f0657; with one key on the connection they share that key's budget with calls routed
by role, with several they are counted together on their own); a limit of exactly 429 or 402 was read back out of
AEON's own message as an HTTP status and rested the provider (0975f5d); the Save button showed "Failed to save
settings" instead of the server's sentence naming the model and the remedy (1099f91); re-saving a connection with a
new limit was not audited (9c07925). Commits: 24964eb, 72fc893, a8ce8c0, e3bc8d6, 67d73ee, fd7ace6, 4196884, 104537a,
d32b30a, f5c1e27, 9ea53cd, and the four above. Tests: `tests/connection-rpm.test.js`, `tests/pacing-failover.test.js`,
`tests/pacing-named-providers.test.js`, `tests/pacing.test.js`, `tests/embed-shares-pacing-bucket.test.js`,
`tests/rate-limit-docs-claims.test.js`, `tests/settings-save-model-guard.test.js`, `tests/role-refusal-revert.test.js`. The Settings
screens (the card, the Change button, the Add form) are covered by source-level tests and a clean build; the author
of these changes did not drive them in a browser.

**Terminal bugs from the owner's live session (d02a98c to 58586fc, and the gap closures below).** Each was traced to a
cause before it was changed, most from the drive's own call log and audit log. Where a line says "not verified", the
only proof is a test against a stand-in for the outside service; CI cannot prove what a live provider does.

- **A long message no longer fails the local embedder (cac4868).** Embedding mode started `llama-server` with a batch
  size but no `--ubatch-size`, and an embedding input must fit one physical batch (512 tokens), so any input over about
  510 tokens came back HTTP 500. Seen as "vault: embed failed" under a reply whose text tripped auto-recall, because the
  recall query is the whole message. Now `--ubatch-size` matches the window, and an input past the window itself is cut
  to its head and embedded with a warning instead of failing. Proven on the real shipped llama.cpp b10216 binary and the
  nomic-embed-text v1.5 Q8 model, run with the old and the new setting: an input of 513 tokens or more was refused with
  HTTP 500 before and answered with HTTP 200 and a 768-dimension vector after; stub-server tests
  (`tests/local-runtime/embed-batch.test.js`) prove the arguments and the retry in CI. For inputs of 512 tokens or fewer
  (counting the begin and end markers) the vectors from the old and the new setting were identical, exact equality,
  largest difference 0, cosine 1.0, at about 22, 102, 302, 482 and 512 tokens, so those need no re-indexing; that was
  measured on one machine with one model, and the cut-and-retry past the window was not run on the real binary. A
  document whose chunk embeddings failed while the bug was live keeps its summary vector and is repaired by the next
  index pass (`/index-brain`, Matrix Index or the nightly run), with no re-index: a document whose summary vector also
  failed gets its vector on the first pass and its chunks on the second. The index status counts document vectors only,
  so it does not show missing chunks; the repair does not depend on it. Repair is covered by
  `tests/embed-failed-chunks-recover.test.js` (d04f857) against a stub embedder, not llama-server, and not against a real
  vault. It takes effect when AEON is restarted.
- **A fallback says why (d02a98c, 869d913).** Only the OpenAI-compatible transports recorded the cause of a failed call;
  a Gemini, Groq or Claude failure wrote `success:false` and nothing else, every audit line read code 500, and the
  terminal said "gemini unavailable -> groq" for a 400, a 404 and a 500 alike. The call log now keeps the status and a
  one-line reason (keys redacted, 160 characters), and the notice reads "gemini unavailable (HTTP 400) -> groq". Tests:
  `tests/failure-cause-recorded.test.js`, `tests/chat-stream-through-kernel.test.js`.
- **Gemini 3.x replies are read from every non-thought part, and an empty reply says why (8ac92cd, 583d020).** The reply
  is now the non-thought text parts, not the first part; a reply with no text says why (output budget spent on thinking,
  blocked prompt, finish reason) instead of "check the model name"; an error inside an HTTP 200 carries its status; the
  non-streaming call throws rather than returning an empty string as success. This covers the registry transports, the
  `GEMINI_*_KEY` environment path and Gemini vision. This does not make Gemini 3.x work: AEON still sends no thinking
  setting, so a 3.x turn that spends its whole output budget on thinking still comes back empty and falls through to the
  next provider, now with its reason in the call log. A 5xx from Google is still not retried. Not verified against live
  Gemini: run one turn on a 3.x model and read the call log. Tests: `tests/gemini-thinking-responses.test.js`,
  `tests/gemini-legacy-thinking.test.js` (4647906 pins the spent-budget message).
- **Groq's native tool call is retried once, and the refusal is remembered (985ef04, 3d4e411).** `gpt-oss-120b` answered
  some turns with a native tool call, which Groq refuses when none are offered. The refusal read as "groq unavailable",
  counted toward the rest after three failures and sent the turn to the 2,048-token local model, which could not hold
  it. A refused native call is now the model's format, not the provider being down: the same model is asked once more
  with a note, without a failure strike. The refusal is then remembered per provider and model for 30 minutes (in
  memory only, forgotten on restart and by the provider-health reset), and the note goes on the first request, so later
  rounds no longer spend a request on an attempt known to fail; no model name is written into the code. A model that
  still refuses with the note already sent counts toward resting the provider and fails over. The 30 minutes is a
  fixed constant, not a setting. Not verified against Groq's real wire format or the live service, and not verified
  that a model stops refusing once the note is up front; if Groq rewords the error, behaviour is as before. Tests:
  `tests/groq-native-tool-call.test.js`.
- **A prompt too big for the local window no longer costs a model load (8e3bbff).** A 4,402-token prompt read as HTTP 402
  (and 4,429 as 429) because the failure check matched digits in the message, so Local was rested for 30 minutes and the
  operator read "out of credits". The window is now checked before the model is started and a cut that still cannot
  fit queues no retry. Tests: `tests/failover-paid-free-too-large.test.js`.
- **A size in an error message is no longer read as an HTTP status (6f26f5d).** A message with no status that quoted a
  size ("Requested 14290", "4,429 tokens") could still read as 429 or 402 and rest a cloud provider. A bare 429 or 402
  now counts only when it stands alone: not inside a longer number and not before a size unit. "HTTP 429", "error 429"
  and a bare "429" are read as before. Tested on the status reader directly; no full failover chain was driven with such
  an error.
- **Pressing Stop is recorded as a Stop, not a failure (6f26f5d).** A Stop was logged as a failed call with no cause, so
  the call log, the audit line (a made-up 500) and the error counts all showed a failure. It is now recorded as
  "cancelled by operator", marked cancelled, audited as 499 and left out of the error counts in the call ledger and the
  Activity block; it never struck or rested a provider, and still does not. It covers the stream Stop and the local
  runtime's own cancel. Old rows in an existing call log keep their old shape. Not run against a real llama-server Stop,
  and other code that counts `success: false` directly was found by search only, not audited. Separately, the local
  runtime's queue has no wait limit: a call can sit behind a long generation with no reason shown. That is not
  changed. Tests: `tests/operator-stop-recorded.test.js`.
- **Switching a role's provider no longer saves the old provider's model (756f856, de764cc).** Settings saved the
  previous provider's model against the new provider's connection (chat to openrouter with a Gemini model, four times
  in sixteen minutes on the drive). A hosted provider's connection now refuses a model its stored list does not name, in
  the readiness badge's own words, and the Provider select changes provider and model together, keeping the model if the
  new provider lists it. Tests: `tests/model-refusal.test.js`, `tests/assign-role-model-guard.test.js`,
  `tests/nl-model-guard.test.js`, `tests/model-after-provider-switch.test.js`, `tests/rolecard-provider-switch.test.js`.
- **The Save button refuses a stale model too, and a refused role goes back (42a774b, 5be5748).** Saving Settings →
  Models wrote whatever the page held. `POST /api/settings` (patch or full replace) now applies the same check to every
  role it would change and answers 400, writing nothing, with a sentence naming the remedy; providers with an empty or
  never-scanned model list, local and custom endpoints, the embed role and saves that leave a model unchanged still
  save. The check uses the connection's stored list, so a model a provider added since the last model scan is refused
  until the list is re-scanned. When the Model Assignment change is refused, the role now returns to its previous model
  in the page instead of leaving the refused pair unsaved on screen. The screens were not driven in a browser: the
  server route is tested by driving it; the page revert is covered by tests of its pure helpers and a clean build
  only. Tests: `tests/settings-save-model-guard.test.js`, `tests/role-refusal-revert.test.js` (7c086bc and 7734563 are
  the README and test-order follow-ups).
- **"Same as Chat" no longer warns (81b493a).** A role set to Same as Chat showed "No models available from this
  provider" under a picker that already said Same as Chat. Routing was never wrong; it now reads "Uses the Chat model
  (provider / model)". Not looked at in a browser. Tests: `tests/sweep-routing-rolecard.test.js`.
- **A model that writes its own tool-result marker no longer shows it (12e19a3, a3c731c).** A live answer began with
  `<<<AEON-TOOL-RESULT ... >>>` around the text of a failed recall, as if a tool had returned it; no tool had, the model
  copied the shape printed in the `## TOOLS` rules. Markers in the model's own text are now dropped before they reach the
  screen, the saved feed or the history, and one `result-marker` notice is raised per turn; the rules also tell the model
  not to write one (not measured to lower how often it does). Not covered: a marker split across an auto-continue seam,
  and turns with tools off. Tests: `tests/result-marker-echo.test.js` (58586fc adds tests for the Claude notice, the
  native-tool remedy and the embed cut warning).
- **Two new dependency advisories cleared (e859fa6).** `npm audit` began reporting two advisories published after the
  last green run: `proxy-addr` (critical, IP spoofing through an IPv4-mapped IPv6 trust subnet; it arrives through
  `express`) and `source-map-js` (high, denial of service through source-map section offsets; a build-time
  dependency). Both have non-breaking fixes, so the lockfile now pins `proxy-addr` 2.0.8 and `source-map-js` 1.2.2.
  `package.json` and the version are untouched. `npm run scan:audit` passes with only the reviewed `@grpc/grpc-js`
  acceptance (review by 2026-10-31).

**A new block costs one rebuild, not two.** AEON rewrites a block's `block.manifest.json` the first time it
boots (routes written in, keys re-ordered), so the same manifest had two byte forms and a block's first restart
rebuilt twice. The build stamp now compares manifests by content (sorted keys). Found by running the customer path
end to end on a fresh clone. Tests: `tests/build-stamp.test.js`.

**The terminal no longer says a working embedding model is "not installed" (5b4e2ab).** Reported live: Cookbook listed
Nomic Embed Text as ready, the registry and a running embedder agreed, and a real embed took 22 ms warm — yet an agent
told the operator "Embedding model not installed". Retrieval answered every embedding failure that was not a
structured kernel error with a fixed "needs an embedding model, and none is available", and the local embedder's own
failures (server would not start, timeout, HTTP error) carried no error code, so a failed attempt always read as a
missing model. Now `kernel/embed.cjs` `explainEmbedFailure` says "not installed" only when the readiness check
agrees; otherwise it says the model is installed and gives the real cause and a remedy. The local embedder retries
once. `/ask`, `/recall` and `/ask-doc` all use it. Tests: `tests/embed-honest-errors.test.js`. Also: the Windows
CI flake in `tests/engine-install.test.js` (a worker still held its temp folder), and a README section on adding a
block from the store.

**The carried drive now rebuilds too (61877ae).** Found live on the owner's drive: the drive's launchers start
`server.cjs` themselves, so the stale-build check in `launch.js` never ran there — a block installed on the
drive stayed screenless through every restart, and the dashboard's own warning told a customer to run
`npm run build`, which a customer cannot. The check is now `tools/ensure-interface.cjs`, shared by
`launch.js` and all three drive launchers (before the first start and after every Restart); the drive points it
at its own npm via `AEON_NPM_CLI`. An install with no build tools (installed with `--omit=dev`) keeps its
interface and says how to fix it. The warning now says to close and reopen AEON. Tests: `tests/build-stamp.test.js`.

**Close and reopen AEON to load a new block.** A block's routes mount live, but its screen is compiled
into the interface, and the launcher rebuilt that only when `dist/` was missing — so closing and reopening
AEON, or Settings → Restart, left a freshly installed block without a screen. `npm run build` now ends by
stamping `dist/` with a hash of what it was built from (`tools/build-stamp.cjs`); the launcher compares it on
every start and on every Restart (exit 75) and rebuilds when blocks changed. A failed rebuild keeps the
previous interface and says so. Every post-install notice now says to close and open AEON instead of
"no restart needed". Tests: `tests/build-stamp.test.js` (e56c75e).

Install a block without a terminal, approve a shell block without leaving the app, blocks that
bring their own engine, and a database lockdown. One of these is a security fix you should
apply to an existing Supabase project.

- **Security — your Supabase tables answered the public key** (fe45e34). The schemas AEON shipped (and
  that Settings → Cloud applied) created policies such as `"Allow service role full access"
  … FOR ALL USING (true)` with no `TO` clause. A policy with no `TO` applies to everyone,
  including the `anon` role whose key ships in every browser app, so the name changed
  nothing. Measured on real Postgres with Supabase-style roles, 9 of 10 AEON tables were
  readable with that key and 6 writable, among them your notes, block data, mirrored
  document text and the relay's `desktop_commands` queue. `001_enable_rls.sql` did not close
  it (permissive policies are OR-ed together) and added an `authed_all` policy for
  `authenticated`, a role anyone can join by signing up on a project that allows sign-ups.
  Now: every shipped schema enables RLS and creates no policy for anyone but `service_role`
  (the server's key, which bypasses RLS); **`db/migrations/002_lock_down_anon.sql`** drops
  every other policy on the AEON tables and revokes the public roles' privileges, so the
  public key is refused outright (idempotent; Settings → Cloud now applies it last). **If you
  connected Supabase before this, run 002 on that project.** `node tools/rls-canary.cjs`
  now reports LOCKED (Postgres said permission denied), UNPROVEN (answered but empty, which an
  empty list cannot tell from an open policy), EXPOSED, or REJECTED (the key itself was refused,
  so the table was not tested), covers all 19 AEON tables, and only prints PASS when a table
  positively answered "permission denied" and nothing went untested — a first version printed
  PASS after every request had failed (8b54f42). The relay's re-opening
  `db/fix_relay_rls.sql` is removed. Tests: every policy in `db/` must be `TO service_role`
  (`tests/sql-policy-lint.test.js`; the old files fail it with 18 violations in 9 files).
  The server now warns at boot when it has only an anon key.
- **The browser no longer talks to those tables.** Deep Research (including saving research
  to the cloud), Activity, the Dashboard heatmap, the Second Brain visualizer's "cloud index"
  and a legacy clients/inventory/scheduler mirror read and wrote Supabase directly with the
  anon key. They are removed; cloud sync is the server's job (`/api/sync`, service role), and
  `tests/no-browser-anon-supabase.test.js` keeps it that way. The Files block's optional
  Supabase **Storage** mode is unchanged: keep its bucket private.
- **Drag a downloaded block into AEON.** Master → Install from the store takes a `.aeon`
  file you drop or browse to; it goes through the same pipeline as a link or a name, so a paid
  block never needs a public URL (5840dc9).
- **IDE mode is reachable, password-gated, and one-shot.** Approving a shell (Tier 3) block
  needed IDE mode, which had no switch anywhere. Settings → Agent now shows one when such a
  block waits: it needs your password (the same one-use token as the credential export),
  refuses with no account, and turns itself off the moment the block is approved (4227d9a).
- **A failed install no longer blocks the retry.** A leftover `staging/<id>` with no
  approval waiting is cleared and re-staged; one still awaiting approval is protected
  (2a69606).
- **A block can declare an engine.** `contract.engine` names npm packages (exact versions)
  and a worker; AEON installs exactly those into the block's own folder (scripts off) and
  starts that one worker without provider keys, so the block needs no shell access. An engine
  is never auto-built: the approval card lists every package. The boot sync used to erase the
  declaration, which only an end-to-end install caught (50dacc1).
- **Store, site and README claims corrected** (fe45e34). The README no longer says nothing in the store
  is for sale (it sells only blocks Broken Gear Industries wrote), and now states that AEON
  binds to loopback by default and that the tunnel refuses to start without an account.

## 3.3.3 — 2026-10-04

<!-- Range: v3.3.0 (f353caa) to f3b31f4, two commits, plus "Release 3.3.3". The number
     skips 3.3.1 and 3.3.2 by the owner's choice; no release was published under them. -->

A contact address and the README's banners. Nothing in how AEON runs changes.

- **A private way to ask for help.** AEON now has its own address,
  **aeon@brokengearindustries.com**. First-run setup and the README's "Need help?" offer it
  beside the public install-help form, and SECURITY.md and the code of conduct name it as
  the fallback to GitHub's private report. It is one constant, `HELP_EMAIL` in
  `src/utils/help.js`, and a test checks every place names the same address (f3b31f4).
- **README:** the animated banner is back on top, with the working-terminal picture
  below the intro (d12d0cb).

## 3.3.0 — 2026-10-04

<!-- 3.3.0 was built in local branches and lands as one commit, 25a66cd, plus the
     commit that points these lines at it and the review fixes on top of it (same
     branch, release/3.3.0: round 3 is 4aafe70, round 4 is c805e4a,
     round 5 is 6d414c7, round 6 is f5e406e,
     round 7 is ff707d3,
     round 8 is 75db814). Every entry below
     except "Not included in 3.3.0" names the commit or commits its behaviour comes
     from. These hashes hold only if the branch reaches main by a merge commit or a
     fast-forward, never a squash or rebase. -->

Agents that can work. In a chat, your AEON and your agents can use AEON's own tools —
search and read your Vault, search the web, save to their own memory and folder, ask
another agent — and every tool use is shown in the terminal with its real result. An
answer a model cut off at its output limit is continued automatically. Each agent keeps
a scratchpad and can write a handoff note it sees until it writes a newer one. Your
data in `~/AEON` is untouched; upgrade as for 3.2.0.

### Agent tools in chat

- **Eight tools**, in the terminal's chat turns (within the limits below; `web_search`
  and `ask_agent` only where allowed): `vault_search` (the same Second
  Brain search `/ask` uses), `vault_read` (one Vault file — text, Markdown, PDF or
  HTML, long files in parts), `vault_list` (a Vault folder), `web_search` (your search
  provider; DuckDuckGo needs no key), `memory_save` (one fact to the agent's **own**
  memory; Settings' "New memories start on" applies), `artifact_save` (a Markdown
  document in `Agents/<Folder>/artifacts/`), `scratchpad_write` (its scratchpad, below)
  and `ask_agent` (one question to another of your agents). (25a66cd)
- **Needs no provider function-calling**, so every provider AEON supports can use it —
  free OpenRouter models, Groq, Gemini, OpenAI-compatible endpoints and local llama.cpp
  models: the model asks for a tool in plain text (a fenced `aeon-tool` block) and AEON
  runs it. How reliably a model writes the block depends on the model; it was tested
  against a scripted model, not yet against each provider. (25a66cd)
- **On screen, as it happens.** Each tool use is a TOOL line above the answer; open it
  to see what the tool returned (a long result is shortened there, and says how much
  more went to the model). Each save adds a ✎ line saying what changed and where. AEON
  also checks the answer for common phrasings such as "I searched your Vault", "I read
  the file", "I saved it to my memory" or "I asked <agent>", and warns under it when no
  tool of that kind succeeded in that reply (a Vault search does not back "I searched
  the web"); other wordings are not caught. "I asked <agent>" is checked against every
  agent you have, including ones that agent may not ask. (25a66cd, 4aafe70, c805e4a)
- **Limits per reply:** at most 6 tool uses, 3 of them saves; each result is capped in
  size, the results together are capped, and each tool has a time limit. When the chat
  role's model has a context window under 4,096 tokens, tools are off for that turn and
  the terminal says why. (25a66cd)
- **What a tool returns is data, not instructions.** Results reach the model marked as
  data, between markers that carry a random tag for that reply, and a tool call written
  inside a document is never run — in a tool result, in a passage the Second Brain
  recalled into the turn, or in a saved memory. A document's text can still sway a model, so every
  save is shown, and one reply can make at most 3. A model that streams a very long line
  of backticks can no longer stall AEON: what the terminal holds back while it decides
  whether a line is a tool call is bounded. (25a66cd, c805e4a)
- **A reply after a tool result is never retried in shortened form.** A shortened retry
  would keep only the start of the instructions and drop the tool rules. Your next
  provider is asked with the full request instead; if none can take the result (too
  large, or out of output budget), the answer so far stays and a notice says why.
  (6d414c7, f5e406e)
- **Vault paths stay in the Vault:** no `..`, no absolute paths, no hidden files or OS
  junk, and no way out through a symlink — also for an agent's own scratchpad,
  handoffs and artifacts, which are never opened through a link. (25a66cd)
- **Settings → Blocks → Memory Core:** "Let agents use AEON's tools in chat" and
  "Agents may search the web", both on by default. (25a66cd)
- **Not included in 3.3.0:** no shell, no code execution and no arbitrary web
  requests. Apart from the model calls a chat already makes (and `vault_search`'s query
  embedding, and `ask_agent`'s call to the asked agent's own model and provider), the
  only outside service a tool contacts is your search provider, through `web_search`;
  and a save starts the usual Vault indexing, which embeds the saved text with your
  Embedding model (a cloud one if no local embedding model is installed).

### Privacy

- **An agent set to Local only** keeps every model call of its turn on local models —
  each tool round, each continuation, its handoffs and the questions it is asked by
  another agent. It is never offered `web_search`, and a `web_search` it writes
  anyway is refused. Settings → Models → **Local only** turns `web_search` off for
  every agent. (25a66cd)
- **A Local only agent's folder** — its memory, scratchpad, handoffs and artifacts —
  cannot be searched, read or listed from a Roulette agent's turn, and a model that can
  be in the cloud cannot tell it exists: the tool list does not name it, a read or list
  of its folder answers like a missing path, and `ask_agent` answers like an unknown
  name. A Local only agent asking a Roulette agent is refused with the reason. Neither
  model is called. An agent whose `agent.json` cannot be read is treated as Local only
  until it is fixed. (25a66cd)
- **Switched-off memories, Local only agents' folders, saved chats and the security
  block's records** cannot be read, listed or searched through any agent's tools (a
  Local only agent may read its own folder, except memories switched off), also when a
  link elsewhere in the Vault leads to them; saved chats and security records reached
  through a link are not indexed either. No tool reads or lists an agent's memory
  files: the memories that are on are already in its prompt, and `vault_search` finds
  them. A `memory_save` of the same words as a switched-off memory is answered like a
  new save, so a model cannot learn it exists. (25a66cd, 4aafe70, c805e4a)
- **A removed agent set to Local only stays private.** Removing an agent moves its
  folder to `Agents/.removed/`; any folder whose `agent.json` says Local only (or cannot
  be read), and any folder in `Agents/.removed/` without one, is withheld from tools,
  indexing and recall wherever it is — reached through a link, or moved elsewhere in
  the Vault by hand. (c805e4a)
- **A memory store is never read or written through a link.** When an agent's
  `memory/` folder (or the shared one, `Agents/Aeon/memory`) is a link, its prompt gets
  no memories and Memory Core refuses to show or change that store, with the reason; a
  link to a Local only agent's memory would otherwise have put it in a cloud prompt.
  (4aafe70)
- **Turns from an agent you removed** stay out of every later prompt that may go to a
  cloud model: a turn tagged with an agent that is no longer listed counts as Local
  only, since whether it was private can no longer be told. A new agent given a removed
  agent's name gets a new id, so it never inherits those turns. (25a66cd, 4aafe70, ff707d3)
- **An agent reference lands on the agent it was saved for.** What the terminal and
  saved chats keep is an agent's id, and an id or folder wins over another agent's
  name — so a renamed Local only agent's id cannot reach a Roulette agent that took its
  old name. A new or changed name may not be another agent's name, id or folder, and
  neither may the folder a new name gets ("José" gets `jose`). A saved reference that no
  longer names exactly one agent is answered by your own AEON on this computer only, with
  a notice, never by a cloud model, and that turn stays out of later cloud turns and of
  the mission log. When one agent's name is another's id (a clash made
  before 3.3.0 or by hand), a name you type picks the Local only one if exactly one is,
  and the terminal otherwise asks which. (6d414c7, f5e406e, ff707d3, 75db814)
- **A Local only agent's folder inside a folder named Vault** (an older Vault copied
  in) stays private: that folder is no longer read as the Vault itself. (6d414c7)
- **Your own AEON set to Local only:** an agent set to Roulette no longer gets the
  shared memory (which is your AEON's memory) in its prompt. 3.2.1 listed this as not
  covered. (25a66cd)
- **Images in an answer are not loaded.** A Markdown image in a model's answer or a
  tool result that points to an address is shown as a line you can open yourself,
  never fetched by the browser on its own (an image embedded in the text as `data:` or
  `blob:` is shown): a document the model read could otherwise put private text in the image's
  address. AEON's pages also limit images to AEON itself, `data:` and `blob:` images,
  and Google's sign-in avatar host (`img-src`).
  (25a66cd)
- **Errors a model reads name a Vault path, never this computer's paths** (they carry
  your user name), `file://` addresses and quoted paths with spaces included, whichever
  slash Windows uses. (25a66cd, 4aafe70, 5098239)
- Scratchpads and handoffs are the model's own words, so they are not indexed into
  the Second Brain; artifacts are documents and are indexed. Scratchpads and handoffs
  are shown to the agent as its notes, not as instructions. (25a66cd)

### Answers continue past the output limit

- When a model stops because it reached its output limit — free OpenRouter models stop
  at 1,024 tokens — AEON asks the same model to carry on and joins the parts into one
  answer. At each join it removes a repeated overlap of 12 characters or more, a
  restarted sentence or line (a list item too) of 4 characters or more, a restart that
  runs on to the end of the previous part however long it is (a model that begins the
  section or the whole answer again), and a preamble such as "Continuing:" or "Here is
  the continuation:". A part that ended at a line break and starts again with that same
  line keeps it (a checklist can repeat a line), so a model that restarts a whole line
  there can still show it twice; an overlap that is a short repeating pattern ("0 0 0
  0") is kept too, since repetitive data can rightly go on with more of the same. A
  tool call whose first line the limit cut is completed in the next part and run; one
  cut later is refused as cut off, and the model is asked to send a shorter call.
  The terminal shows "continuing… part 2 of up to 5" while it works and "Continued
  automatically, N parts." under the answer. (25a66cd, 4aafe70, c805e4a)
- Later parts resolve the chat role the same way the first did (its address, key pool
  and pacing), and stay on a fallback model once one has served a part; a provider
  failure on a later part can still fall back. (25a66cd)
- Up to 4 extra parts by default (Settings → Blocks → Memory Core, 0 to 8; each part is
  another model call), or off. An answer still cut after the last part says so and
  that you can type "continue". A provider that does not report why it stopped is
  never continued on a guess. A later part is never sent with less context: when the
  question and the answer so far are more than the model accepts, or a later part comes
  back empty (a reasoning model that spent its budget thinking), the answer ends where
  it stopped, says why, and you can type "continue". (25a66cd, c805e4a)

### Scratchpad and handoffs

- **Scratchpad:** `Agents/<Folder>/scratchpad.md`, at most 2,000 characters, shown to
  the agent every turn. The agent changes it with its tool; you change it in Memory
  Core → agent settings. A change that would take it over 2,000 characters is refused,
  never cut. (25a66cd)
- **`/handoff`:** the agent you are talking to writes a short note — what it was working
  on, what was decided, what is open, the next step — to
  `Agents/<Folder>/handoffs/`. The first 1,500 characters of the newest one are shown
  to it on every turn until it writes a newer one. Older ones are kept; nothing is deleted or overwritten. "Write a
  handoff when you save a chat" (off by default) does the same when you save a chat
  with an agent. (25a66cd)
- Memory Core's agent settings show the scratchpad (editable, with its character
  count) and the handoffs, newest first. (25a66cd)

### Smaller

- The New agent persona example is a bookkeeping helper. (25a66cd)

## 3.2.1 — 2026-10-03

Fixes from the 2026-10-03 audit of the public repository: the privacy switches now do
what they say, a Supabase setup function is locked to the service role, the launchers
install the right Node, and the docs match the code. Your data in `~/AEON` is
untouched; upgrade as for 3.2.0.

### If you connected your own Supabase project

- **`exec_sql` is locked to the service role.** The SQL that Settings → Cloud and
  `tools/migrate.cjs` asked you to paste created `exec_sql`, a function that runs any
  SQL as its owner, and left it callable with the public anon key. The text AEON shows
  now revokes it from `PUBLIC`, `anon` and `authenticated`, grants it to
  `service_role` only and pins its `search_path` (95ac5bb). **If you created
  `exec_sql` with an earlier AEON:** run Settings → Cloud setup once, or
  `node tools/migrate.cjs`; AEON now runs the revoke through `exec_sql` itself before
  it applies anything, and stops with the SQL to paste if that fails (1e76efb). Or
  paste this in the Supabase SQL Editor yourself:
  `REVOKE ALL ON FUNCTION public.exec_sql(text) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.exec_sql(text) TO service_role;`
- `match_second_brain` in `db/migrations/second_brain_chunks.sql` is revoked from
  `PUBLIC` the same way, and a test now fails on any SQL function AEON ships for you to
  run that is not revoked from `PUBLIC` (95ac5bb, 1e76efb).

### Privacy: Local only and Off

- **Local only, per agent.** For an agent you set to Local only in Memory Core, its
  chats, the chat titles and distils made from them and, while it is the terminal's
  agent, `/ask`, `/recall`, `/ask-doc`, `/read` and the sentence that reads a
  command's result back go only to a model on this computer or your own network.
  For an agent you created, that includes its own memory, which is no longer indexed
  with a cloud embedder or recalled into another agent's prompt. Its turns are no
  longer sent to another agent's model after an `/agent` switch, and an image sent
  in its chat is refused, since images are read only by cloud models
  (ddfd30c, ba87a8e).
- **Still not covered:** other slash commands use the models set in Settings → Models;
  your own AEON's memory is the shared memory, so an agent set to Roulette that reads
  it still sends it to its own model (ddfd30c, ba87a8e).
- **Off.** A switched-off memory is kept and listed, and is not sent to a model or
  recalled: it is left out of indexing (the next scan takes it out if it was in), and
  never comes back from `/recall`, `/ask`, `/ask-doc` or chat recall. `/memory`,
  `/doc` and `/read` show it to you without passing it to a model. Aeon Matrix's own
  search box still lists it, to you only (ddfd30c, ba87a8e).
- A path typed in another letter case, or through a symlink, is judged as the disk
  resolves it, so it cannot get round either switch (ba87a8e).
- Cloud sync of the Vault skips switched-off memories and Local only agents' folders,
  and deletes the copies of them it had uploaded (ba87a8e).
- A memory with no `<id>.md` copy on disk gets one written when Memory Core loads, so
  it can still be found (ba87a8e).

### Corrections to the 3.2.0 notes

- 3.2.0 said an agent set to Local only "is refused a cloud model — for chat, distil
  and automatic capture alike". That was true of those three calls only. In 3.2.0 the
  same agent's chat titles, image reading, history carried over after switching
  agents, slash commands, and the indexing and recall of its memory folder could
  still reach a cloud model. 3.2.1 closes those, with the exceptions listed above.
- 3.2.0 said Off "keeps a memory saved and searchable but never sends it to the
  model". In 3.2.0 a switched-off memory was still indexed, which sends its text to a
  cloud embedding model when that is what serves the Embedding role, and `/recall`,
  `/ask` and chat recall could still put it into a model's prompt. From 3.2.1 it is
  kept and listed, not sent to a model or recalled.

### Install and launch

- `launch.command` installs `node@24` from Homebrew (`node@22` below macOS 13.5)
  instead of the unpinned `node`, which is now 26; launch.js's "Node too old" message
  names Node 22 LTS on macOS below 13.5 (80ba301).
- The Desktop `AEON.app` takes its version from `package.json` (it said 3.0), and an
  older one is updated (80ba301).
- `LAUNCH.bat` can now actually offer to install Node with winget, and says "installed"
  only when winget succeeded (b1f22f3).
- `ACE-Step-Launcher.bat`, a personal music-generator launcher that nothing in AEON
  uses, is gone from the download (09f86cc).
- `package-lock.json` is accepted, and left unchanged, by both npm 10 (Node 22) and
  npm 11 (Node 24 and 26), so a first launch no longer rewrites a tracked file and
  blocks the next `git pull`; npm 10 refused the 3.2.0 lockfile (a41ab59, c9a9c32).
- A drive built with `scripts/build-usb.js` carries `THIRD_PARTY_NOTICES.txt` naming
  the licenses of FFmpeg, Node.js, llama.cpp and the catalogue models on it (affe245,
  be15e97).

### Dependencies and CI

- vite 6.4.3 (was 5.4.21) closes the dev-server advisory the audit gate had accepted;
  the acceptance is removed. `@vitest/coverage-v8` added (a41ab59).
- CI runs on pushes to `main`, `v*` tags, pull requests to `main`, weekly, and by hand
  — no longer on every branch push. Six legs: a Node 26 leg is added, and the Node
  22.13 floor now installs with `npm ci`. Read-only token, actions pinned to commit
  SHAs, 20-minute timeouts, and a check that `npm install` leaves the lockfile as
  committed (49fb717, bfd7aab, fc22bde).
- A Windows-only timing test retries once (7c4d942).

### Docs and licenses

- `THIRD_PARTY_NOTICES.md` names what ships with or is fetched by AEON and under which
  license, and the graph bundle in Aeon Matrix carries its 35 packages' license texts
  (942216a, be15e97).
- Welcome screen: the cloud-key indexing line says what happens, and it links the
  Terms of Use, License and Privacy notice. `PRIVACY.md` says Local only and Off as the
  code does them; block secret settings are stated as plain text in
  `aeon-settings.json`, owner-only (cdde378, 1d8b2b7).
- Resume Grader no longer calls itself EEOC-safe or EEOC-compliant (cdde378).
- Developer docs say what the code does: the terminal's two verbs, `/api/os/action`,
  the `/api/ai` request bodies, where `.env` lives, what `aeon lint` checks, the
  Fleet Control, Settings and Memory Core READMEs (593b8c9, ddfd30c, be15e97).
- README: what AEON is for, a screenshot, Agents, *Privacy, in short*, and *Updating
  AEON* (558837c); its images moved out of `public/` (59badfd). New
  `CODE_OF_CONDUCT.md`; the security policy asks for the release you downloaded and
  lists supported versions; the install-help form says the issue is public (558837c,
  d9dd9e8).
- `.claude/` is left out of release archives (593b8c9). A test fixture that looked
  like a real OpenAI key is now built at runtime (95ac5bb).

## 3.2.0 — 2026-10-02

Agents with memory of their own, a switch on every memory, and blocks you can build on.
Your data in `~/AEON` is untouched; upgrade as for 3.1.x.

### Agents and memory

- **Agents.** Create them in Memory Core: a name, a persona, an optional model of their
  own, and their own memory in `Vault/Agents/<Name>/memory`. Every agent also reads the
  shared memory (`Vault/Agents/Aeon/memory`, where it always was) unless told not to.
  Removing an agent moves its folder to `Vault/Agents/.removed`; nothing is deleted
  (bd7c9d9).
- **Local only, per agent.** An agent set to Local only is refused a cloud model — for
  chat, distil and automatic capture alike — even with the global switch off (bd7c9d9).
  *Overstated: other calls still reached a cloud model; see 3.2.1.*
- **A switch on every memory.** Off keeps a memory saved and searchable but never sends
  it to the model; Memory Core shows what the switched-on memories cost every turn, with
  all on / all off. New setting: *New memories start on* (bd7c9d9). *Overstated: an Off
  memory was still indexed and recalled; see 3.2.1.*
- **Calling an agent:** `/agent` lists them, `/agent <name>` switches, `/agent off`
  returns. Any wake-up call works — "aeon - come online" did nothing before, because only
  a space, a comma or "!" could separate the words — and an agent wakes by its own name
  ("scout come online", "wake up, scout") (bd7c9d9).
- Fleet Control's *VP missions* panel is now **Recent Agent Missions**: every agent, with
  what it was last asked; a click loads it into the terminal (bd7c9d9).
- Your own AEON can be renamed and given a persona, and the wake message no longer calls
  every install "VP" (bd7c9d9).
- `POST /api/ai` takes `agent`, so a block can run its own jobs as an agent — its model
  and its privacy (bd7c9d9).

### Blocks

- Stopping a block pauses its timers and listeners; it used to stop only its routes while
  its jobs kept running, even after a restart (6ea8e34).
- A block's secret settings are no longer sent to the browser, and a block's own AI role
  appears in Settings → Models under the block's name (a0d5110, 4609391).
- An error in a block's timer is logged with the block's id instead of stopping AEON
  (fbc6642).
- Scheduled tasks run at the interval they name: "every 15 min" ran every 5 minutes and
  "every 6 hours" hourly (11a467f).
- `aeon dev` listens on this computer only, gives a block its real storage, settings and
  timers, and reloads on save; `aeon new` writes a clean manifest (10889cb).
- One block-building guide — the Master README — checked against the code (8bd2adf).

### Fixes

- Quick Links load again after you sign in: a load before sign-in showed "HTTP 401" for
  the whole session. A save made meanwhile merges with the saved links instead of
  replacing them (1706a32).
- The version AEON shows is the release's own; it said "v5.0" (da0f6b5).
- The streaming chat no longer keeps answering with a reloaded block's old settings
  (bd7c9d9).

### Help

- **Install help is free:** the welcome screen and the README link an *Install help*
  form; setup and custom blocks are offered as paid services (7d132ec).

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
