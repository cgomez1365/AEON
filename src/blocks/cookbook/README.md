# 🧱 AEON Block: Cookbook

**ID:** `cookbook`
**Route:** `/cookbook`
**Tier:** `plugin`
**Status:** `ACTIVE` — local-only (`deployment.target: local_required`, runs on the Windows host via `child_process`, no Docker/tmux/SSH)

Local AI model management: probe GPU/CPU/RAM hardware, browse and download models
from HuggingFace, launch a serving process (vLLM / llama.cpp /
SGLang), and track running/queued tasks with live log tails and error diagnosis.

## Files
- `index.jsx` — UI: 5 tabs (Hardware, What Fits, Models, Download, Active)
- `api/index.cjs` — Express router: GPU probing, model cache scan, download,
  serve, and task lifecycle (all via `child_process`/`exec`/`spawn`)
- `block.manifest.json` — Block contract (auto-loaded by the kernel)
- `.aeon.runtime.json` — Auto-generated on boot; do not hand-edit

## What it does

- **Hardware tab** — runs `nvidia-smi` to list GPUs (VRAM used/free, utilization,
  per-GPU processes with a Kill button), plus a CPU/RAM/hostname summary card.
  Reports no GPU when `nvidia-smi` is absent; CPU inference still works.
- **What Fits tab** — ranks candidate models by whether they fit the detected
  (or manually-simulated) hardware at a given quantization/context length, with
  a "What if I had..." hardware simulator (GPU count, VRAM/GPU, RAM, backend).
  **This tab is served by the `fleet_control` block's `/api/hwfit/*` routes,
  not by anything in this block** — see "Cross-block dependency" below.
- **Models tab** — scans the local HuggingFace cache (`~/.cache/huggingface/hub`,
  or `HF_HOME` if set), shows size/file count/format (GGUF/diffusion), and
  lets you Serve or delete a cached model.
- **Local models** — AEON's own catalogue, downloaded and SHA-256 verified by
  the app itself with no external tooling required. This is the recommended
  path and the only one that works on a machine without Python.
- **Download tab** — direct download by HuggingFace repo id or URL. Requires
  the `hf` CLI or a real Python on PATH, and says so plainly when neither is
  present; also surfaces HuggingFace trending models to
  click-to-fill the download box.
- **Active tab** — polls running/finished download & serve tasks every 5s, shows
  a log tail, lets you stop a task or kill a GPU process by PID, and runs
  pattern-based error diagnosis (OOM, port in use, missing GGUF, gated repo,
  missing vLLM/llama.cpp/torch, etc.) with suggested retry flags.

## API routes (this block, mounted at `/api/*` and `/block/cookbook/*`)

| Method | Route | Purpose |
|---|---|---|
| GET | `/cookbook/gpus` | Probe NVIDIA GPUs via `nvidia-smi` |
| GET | `/model/cached` | Scan HF cache (+ optional extra `model_dir` list) |
| POST | `/model/download` | Start a HuggingFace download (`hf` CLI or `huggingface_hub`); 503 with a reason when neither is installed |
| POST | `/model/serve` | Start a serve process (allow-listed binaries only) |
| GET | `/cookbook/tasks/status` | Poll all active/finished tasks, with log tail + diagnosis |
| GET | `/cookbook/task-stream/:sessionId` | SSE tail of a task's log file (not currently used by the UI) |
| POST | `/cookbook/task-stop/:sessionId` | Kill a running task by session id |
| POST | `/cookbook/kill-pid` | `taskkill` a GPU process by PID |
| POST | `/cookbook/delete-cache` | Delete a cached HF repo from disk |
| GET | `/cookbook/hf-latest` | Cached (10 min TTL) HuggingFace trending-models query |
| GET/POST | `/cookbook/state` | Read/write a small persisted JSON blob (not currently used by the UI) |

## Cross-block dependency: `fleet_control`

The **What Fits** tab calls `/api/hwfit/system`, `/api/hwfit/models`, and
`/api/hwfit/profiles` — these are defined in
`src/blocks/fleet_control/api/hwfit.cjs`, not in this block. This is a real,
intentional dependency (hardware-fitness scoring lives with Fleet Control), and
`block.manifest.json` now declares it via `requires.blocks: ["fleet_control"]`.
If `fleet_control` is ever removed, the What Fits tab will fail to load data
(the rest of Cookbook is unaffected).

## Config / storage

- State, download logs (`<session>.log`), and PID files live under
  `getDataFile('cookbook')` → `<repo root>/data/cookbook/` (created on first
  use). This block **does** read/write the filesystem — it creates directories,
  writes log/pid/state files, and deletes HF cache folders on request; the
  manifest's `contract.permissions.filesystem` is `"write"` to reflect that.
- No block-specific env vars are required. `HF_HOME` (optional) redirects the
  HuggingFace cache scan/download location; `HF_TOKEN` can be supplied
  per-request from the Download tab for gated repos.
- Reaches the open internet: fetches `https://huggingface.co/api/models` for
  trending models, and spawns `hf download` / model servers
  that themselves fetch over the network — `contract.permissions.network` is
  `"external"`.
- Does not call any AEON-managed AI/LLM provider (no `kernelLLM`, no vault
  keys) — it only manages *other* local inference processes — so
  `contract.permissions.ai` is `false`.
- The built-in local-model catalogue requires nothing external. The
  HuggingFace download tab needs the `hf` CLI or Python on PATH; GPU probing
  needs `nvidia-smi` (NVIDIA
  driver install), and everything degrades gracefully (empty/CPU-only
  responses, never a crash) when either is missing.
- `contract.permissions.shell` is `true` — this block's entire job is spawning
  `child_process` calls (`nvidia-smi`, `hf`/`python`, `taskkill`,
  and the serve command itself via Git Bash on Windows or a direct spawn).

## Terminal commands (`contract.commands`)

- `/gpu` → `GET /api/cookbook/gpus`
- `/models` → `GET /api/model/cached`

## Not available in the cloud

`GET /cookbook/gpus` and `GET /model/cached` return a friendly
`{ ok: false, ... }` / `{ models: [], host: 'cloud' }` stub when
`process.env.VERCEL` is set, instead of crashing — but real functionality
(GPU probing, model download, serving) requires the local desktop, hence
`deployment.target: "local_required"` and `contract.targets.vercel: false`.

## To activate

Automatically detected by the AEON kernel. Drop this folder into
`src/blocks/` and restart the Command Center.
