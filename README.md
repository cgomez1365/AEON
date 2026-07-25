# AEON 3 — Console

**An AI-native operating system.** Free console. Capabilities as cartridges. Runs on your computer — your data never leaves it unless you connect your own cloud.

> Think Linux, for the AI era: a kernel that discovers self-contained blocks, a nervous system (Settings) every block reports to, a vault that encrypts your keys, and one LLM layer that routes every AI call by role.

---

## 🚀 Start in 2 minutes (no technical skills needed)

1. **Install Node.js** (one time): [nodejs.org](https://nodejs.org) → big green **LTS** button → install with all defaults.
2. **Download AEON**: green **Code** button above → **Download ZIP** → unzip anywhere (Desktop is fine).
3. **Launch it**:
   - **If on Windows, click here to launch** — double-click `LAUNCH.bat`
   - **If on Mac, click here to launch** — double-click `launch.command` (if blocked: open Terminal, type `chmod +x ` , drag the file in, press Enter, try again)
   - **Linux** — run `./launch.sh`

The launcher checks your computer, walks you through setup, and opens AEON in your browser. **Every question can be skipped by pressing Enter** — you can finish everything later inside AEON under **Settings**.

### Free AI, two ways
- **Cloud (free keys)** — grab a free key from [aistudio.google.com](https://aistudio.google.com) (Gemini) or [console.groq.com](https://console.groq.com) (Groq). Paste it when the launcher asks, or later via Settings — or just type `/addkey groq YOUR_KEY` in the terminal.
- **Local (no keys, fully private)** — say **Y** when the launcher offers to install Ollama, or open the **Cookbook** block any time and download a model with one click. No internet needed after download.

---

## 🧠 What's inside

| Part | What it does |
|------|--------------|
| **Neural Terminal** | Talk to AEON in plain English. `/` commands, `>` shell, drag-and-drop files. |
| **Aeon Matrix** | Your documents as a living 2D/3D knowledge graph. Ask, summarize, search, listen. |
| **Vault** | Everything you save, organized automatically. API keys encrypted (AES-256-GCM). |
| **Cookbook** | Download and manage local AI models. Probes your GPU, recommends what fits. |
| **Settings** | The nervous system. Every block declares its needs here; everything is configured in one place. |
| **Blocks** | Dashboard, Council, Deep Research, Files, Fleet Control, Memory, Security, and more — each a self-contained cartridge. |

### Terminal superpowers (God Mode)
- `/open matrix` — open any block by name
- `/data cookbook` — see any block's saved data
- `/addkey gemini AIza...` — add an API key without touching a file
- `/model` — hotswap the chat model from a dropdown, grouped by which keys you have
- `/model-pull qwen3.5:4b` — download a local model
- **Drop any file onto the terminal** — AEON reads it and recommends where it belongs in your Vault

---

## 🧩 Build your own block

A block is a folder. Drop it in `src/blocks/`, restart, it's live — nav, routes, and settings wire themselves from one file:

```
src/blocks/my_block/
  block.manifest.json   ← the DNA: identity, permissions, commands, settings
  index.jsx             ← the UI (default-exported React component)
  api/index.cjs         ← optional Express routes, mounted by the kernel
```

Nothing about a block is hardcoded anywhere else. See `src/blocks/_template/` to start.

## 🔐 Security model
- Keys go in once, get encrypted into the vault, and **never reach the browser**
- Blocks run sandboxed — they only get the permissions their manifest declares
- Shell access is allowlist-gated and fails closed
- No telemetry, no phone-home. Broken Gear Industries runs zero servers on your behalf.

## 🛠 For developers

```bash
npm install
npm run start           # vite dev server + kernel (hot reload)
npm run build           # production frontend → dist/
node server/server.js   # kernel only, serves dist/ at :3001
npm test                # vitest
```

## 📄 License
[AEON Community License](LICENSE) — free to use and modify forever; no resale or redistribution. See [Terms of Use](TERMS_OF_USE.md).

---
*Broken Gear Industries · Build anything. Run anywhere.*
