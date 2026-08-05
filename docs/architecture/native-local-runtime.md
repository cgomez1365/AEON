# Native Local Runtime — Architecture Decision

**Status:** Adopted 2026-07-30
**Supersedes:** Ollama-as-local-provider (HTTP daemon on `localhost:11434`)

---

## Decision

AEON runs local inference through a **version-pinned, self-bundled `llama.cpp`**
executed as a child process by absolute path. No machine-wide service, no TCP
listener, no PATH lookup, no external installer.

| Axis | Target |
|---|---|
| Provider ID | `local` |
| Runtime ID | `llama.cpp` |
| Model format | GGUF |
| Transport | Node IPC / stdio to a supervised worker — **never HTTP** |
| Registry ownership | `services/local-runtime/registry.cjs` — single writer |
| Path authority | `services/local-runtime/paths.cjs` — single resolver |
| Lifecycle authority | Cookbook block only |

### Why not keep Ollama

Ollama is a machine-wide daemon the user installs separately, listening on a
fixed TCP port, owning its own model store under `~/.ollama`. That means:

- AEON cannot claim zero-install; the consumer must install a second product.
- Model data lives outside AEON's data root, so portable/USB mode cannot carry it.
- A port conflict or a stopped daemon is an AEON failure the user must debug.
- AEON has no version control over the inference engine it depends on.

The native runtime removes all four. AEON owns the binary, owns the models,
owns the lifecycle, and moves with its data root.

---

## Boundaries (the part two engineers must build identically)

### 1. Path authority

`services/local-runtime/paths.cjs` is the **only** module permitted to read
`os.homedir()`, `process.env.DATA_PATH`, or any environment-derived root for
runtime/model/registry/log paths. Every other module receives resolved paths
or asks the resolver. Drive-letter literals and hardcoded model roots outside
this module fail CI.

Registry entries store paths **relative to dataRoot**. Moving a portable
install to a different drive letter must not invalidate the registry.

### 2. Registry ownership

`data/local-runtime/local-runtime.json` is **generated state**, not
configuration. It is gitignored and never shipped. One module writes it,
transactionally:
temp-write → flush → atomic replace, with the prior valid copy retained as
backup. A crash at any write boundary leaves either the old valid registry or
the new valid registry — never a partial one.

Settings and the kernel read *ready* models from the registry, through
`services/local-runtime/index.cjs` `listReadyModels()` — the single named read
path. Neither probes folders nor processes to discover models, and no consumer
indexes `status()` by hand.

> **Corrected 2026-08-04 (BO-C).** This section previously named
> `data/local-runtime.json`. That path held a *different* file — a HuggingFace
> cache scan written by the Cookbook block — while the real registry lived one
> directory down. Two writers existed where this record specifies one, and
> Settings read the wrong one, so local models were invisible to every picker.
> The legacy file and its writer were retired; the path is now free and the
> record names the registry that actually exists.

A HuggingFace cache scan is still offered alongside the registry as
**discovered** models, derived on read and never persisted. Discovered entries
carry `servable` and a stated reason; they are never merged into the managed
list, because a cached repo may hold weights the runtime cannot open.

### 3. No model HTTP transport

The worker communicates over Node IPC or stdio with request envelopes. There
is no localhost HTTP server for inference, so there is no port to conflict, no
port to firewall, and no port to leak onto a network interface. `netstat`
during inference is part of the release evidence.

### 4. Worker privacy boundary

The worker process receives: the absolute verified model path, generation
parameters, and the prompt. It receives **nothing else** — no cloud provider
keys, no Vault path, no user profile, no inherited full `process.env`.

The worker logs timings and token counts. It never logs prompts, outputs,
embeddings, or raw model paths.

### 5. Verification before ready

A runtime or model reaches `ready` state only after **all** of: exact byte
count, SHA-256 match against a pinned manifest, format probe (GGUF header /
binary version), capability + license metadata recorded, final atomic rename,
and registry commit. A bad hash or unexpected layout can never become `ready` —
it becomes `quarantined` with a stated reason.

---

## Compatibility policy

The following are **frozen** across the migration. Changing any of them is a
separate, deliberate, versioned change — never a side effect of the transport swap.

| Surface | Contract |
|---|---|
| `kernelLLM(prompt, opts)` | Returns `string`; returns `{text, provider, model, fallback?}` when `opts.returnMeta` |
| Role vocabulary | `opts.role` defaults to `'chat'`; existing role names unchanged |
| Terminal SSE events | `token` `{t}` · `done` `{text,tokens,latencyMs,provider,model}` · `error` `{error}` |
| Embedding response | `{vector, model}` — model tag identifies the vector space |
| Cloud fallback | Provider chain, health marking, and roulette behavior unchanged |
| Block dependency injection | Blocks receive `kernelLLM` only when the manifest grants AI capability |

Blocks never receive `localRuntime`, the runner, the registry writer, or a
model path. A block that switches between `local` and a cloud provider by
Settings role must require **zero** block-code changes.

---

## Migration stance toward existing Ollama installs

AEON detects a legacy Ollama configuration **only** to explain the change or to
map a role preference forward. AEON never reads, moves, imports, deletes, or
mutates `~/.ollama` or any user-owned model data. An existing Ollama install on
the machine is untouched and irrelevant to AEON's operation.

---

## Non-goals

- Replacing OpenAI-compatible *remote* endpoint support. That is unrelated
  and stays.
- Shipping model weights inside the AEON package. Models are user-installed
  through Cookbook with explicit consent, byte counts, and license display.
- Silent downloads. Probing shipped assets on first start is permitted;
  any network fetch of a runtime or model requires a user action.
