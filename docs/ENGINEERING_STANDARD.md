# Engineering standard

How work gets into AEON, and what has to be true before it does.

This is the public form of the standard the project runs under. It is not
aspirational — every rule here exists because its absence caused a specific
defect, and most of those defects are named below.

Companion documents: [`CLAIM_DISCIPLINE.md`](CLAIM_DISCIPLINE.md) (what may be
said about the product), [`GATE_RULES.md`](GATE_RULES.md) (the complexity gate
that governs self-building), [`BLOCK_STANDARD.md`](BLOCK_STANDARD.md) (the
manifest contract).

---

## 1. Standing gates

Every pull request clears all of these. **A gate skipped once stops being a
gate**, so there is no "just this time" path.

| Gate | Command | What it protects |
|---|---|---|
| Suite | `npm test` | Every test passes. The count is a dated reading, not a target |
| Release gate | `npm run scan:release-gate` | No Ollama assumptions · no unauthorized machine-root access · cloud-surface ratchet · declared block filesystem |
| Audit | `npm run scan:audit` | No unreviewed high/critical advisory. Acceptances carry a review date |
| Build | `npm run build` | Manifests regenerate; artifact builds clean |
| CI | 5 legs | Windows 24 · Ubuntu 24 · Ubuntu 22.13 · macOS 24 · security |
| Empty shell | in suite | AEON boots with zero blocks and says so honestly |
| Clean room | in suite | The suite creates no `.env`, `secrets/` or `data/` in the install it runs from |
| Route collision | in suite | No two blocks claim one route |
| Command collision | in suite | No two blocks claim one terminal command |
| Manifest freshness | in suite | Declared routes match the real code |
| Block filesystem | in suite | Every filesystem access beyond a block's namespace is declared, with a scope and a reason |
| Tree integrity | in suite | The block tree after a run matches the tree before it |
| Manifest read safety | in suite | An unreadable manifest is never overwritten |
| Scaffold invariant | in suite | The runtime and build-time skip rules select the same blocks |
| Launcher contract | in suite | Launchers stay executable, parse, and never name a Node version below `engines` |

### The ratchet principle

Where a surface should only ever shrink, a scanner records a baseline and fails
the build if the number rises. Lowering the baseline is a deliberate, visible
commit — never a silent one.

**When a ratchet cannot reach zero, replace it with a declaration.** The
block-filesystem ratchet sat at 24 and could never reach zero: for several
blocks the filesystem *is* the job — a File Manager confined to its own
namespace is not a File Manager. A number nobody can act on is a number people
stop reading. So a block now **declares** the access it needs beyond its
namespace, with a scope and a reason, in the manifest a reader can check:

```json
"contract": { "filesystem": { "beyondNamespace": [
  { "file": "api/fs.cjs", "scope": "workspace",
    "reason": "This IS the File Manager. Browsing the operator's
               workspace is the feature." } ] } }
```

The declaration **grants nothing** — Node hands a block `fs` regardless. It is a
statement, checked against the source. What is measurable is the *undeclared*
surface, and that can reach zero. The scanner refuses a new undeclared require,
a declaration whose file no longer uses `fs`, an unknown scope, and a reason
under twenty characters — because a one-word reason is not a reason.

---

## 2. Definition of done

"Finished" requires evidence, named. Not a green build and a good feeling.

| # | Criterion | Evidence |
|---|---|---|
| 1 | A local model installs and answers on a machine that never had AEON | Clean Ubuntu 24.04, 2026-08-08 (no Node present; the launcher installed it). Closed again on clean **physical** hardware — macOS, 2026-08-12 — answering **with Wi-Fi off** |
| 2 | AEON boots with zero blocks and says so honestly | The empty-shell test |
| 3 | Adding a block adds its widget; removing it removes it cleanly | Empty-shell steps 3–4 |
| 4 | A widget can only reach what its manifest declares | Widget contract suite |
| 5 | Chat answers with the network disconnected | Human at the machine, screenshot + boot log `[CLOUD] Local-only mode` |
| 6 | No route is claimed by two blocks | Collision gate |
| 7 | The cloud surface is countable and only shrinks | Ratchet scanner |

**Seven of seven closed.** Stated precisely, because that is the point: closing
#1 on Linux found that local models had **never been installable on Linux at
all** — three defects, each hiding the next. That is what closing a criterion
with evidence is for.

Still open and said out loud: a clean *Windows* machine that has never had Node
has not been tested.

---

## 3. Deletion protocol

Removing code is where products quietly break. The path matters more than the
thing deleted.

1. **Prove it is dead.** No callers, no manifest declaring it, no traffic on a
   running instance. Grep is evidence; a running probe is proof.
2. **Add the gate before the deletion.** A test that fails if the thing returns
   — written first, *seen failing*, then passing.
3. **Delete in one scoped commit.** Not folded into a feature. Reversible by
   revert.
4. **Drive the surface afterwards.** Not "the suite is green" — actually use the
   paths that touched it.

Step 4 exists because every gate written before 2026-08-03 checked that
something *dangerous was absent* and not one checked that the feature still
*worked*. That is how a route shipped broken by the very commit that secured it.

A deletion gate must assert the **survivor**, not only the absence. An
absence-only test passes just as happily on a product with the whole feature
removed.

---

## 4. Lessons paid for

Recorded so each costs full price only once. These are real incidents in this
codebase.

**A read failure became a destructive write.** `readManifest()` returned the
same value — `null` — for two different facts: *no such file* and *the file is
there but I could not parse it*. The caller did `readManifest(folder) || {}`, so
an unreadable manifest became an empty one, was rebuilt from scaffold defaults,
and written straight back over the real file. A block's route table, AI roles
and permissions were wiped by the code whose job is to *heal drift*. **Two
states that look alike must never share a return value when one of them
authorises a write.**

**"Not reproduced since" describes the method, not the defect.** That same
incident sat unreproducible for ten days, because the reproduction attempts were
a normal boot, a build and a test run — none of which can produce a half-written
file. Once the mechanism was named it reproduced deterministically in a test.

**Green for the wrong reason.** Nine tests asserting a runtime path never
reached it: the test runner injected a developer's real `.env` and a build-time
branch short-circuited first. CI stayed green only because CI has no
credentials. A suite that passes because of what the machine is *missing* has
not been run.

**A gate blind to its own target.** A route-collision gate prefixed every block
route in a way that was correct for only one module shape. It reported green
over a live collision for its entire existence. Separately, a regex written with
a doubled backslash made another gate unable to fail. **A gate never seen red is
not a gate.**

**The scaffold was teaching the defect.** The template every new block is cloned
from opened with `require('fs')` and persisted inside its own source folder.
Every block copied from it inherited both habits. A scaffold is not an example;
it is the instruction most of the codebase will follow.

**Prefixes are not boundaries.** `C:\Users\Alexandra` passed a containment check
against `C:\Users\Alex`.

**The comment recorded the intent while the code drifted.** Two modules
disagreed about where a block's documents lived, so version history could only
ever return an empty list. The comment above it read *"Must match exactly — same
store, same folder."* That is the hardest kind to catch, because the file tells
you it is correct.

**Reading the code and running it are different instruments.** A fourteen-agent
audit found seven P0 defects by reading. Then *using* the product found eleven
more that the audit, the suite and 1,094 tests had all missed — including three
commands that had never worked once since the day they shipped. Neither method
substitutes for the other.

---

## 5. Numbers are dated readings

Every figure published about this project carries the commit and date it was
measured at. A reference that carries stale numbers teaches people to distrust
all of it.

This is enforced by example: an earlier revision of the project's own
documentation reported the suite as "1,100 / 1,106" — it had taken 1,100 as the
*passing* count and added the 6 platform-skipped tests on top. 1,100 was the
total. The correction was published rather than quietly patched, because a
number that was never right must be re-taken, not carried forward.

**Current reading — 2026-08-16, `e5185a8`:** 1,133 passing of 1,139 tests across
100 files (6 POSIX-only, skipped on Windows), 0 failures. 17 blocks. 0
undeclared block filesystem access, 23 declared and audited. Cloud conditionals
94 with 0 raw environment reads. 7 of 7 Definition-of-Done criteria closed.

Re-measure before quoting.
