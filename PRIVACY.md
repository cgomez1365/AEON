# AEON — Privacy notice

*Last changed 2026-09-30 · applies to AEON · Broken Gear Industries*

This notice covers the AEON software: what it keeps on your machine, and what it sends over the network and to whom. It does not cover any website. The block store is not open, and nothing is for sale; if a store or website collects anything from you, it will need its own notice.

## The short version

- **AEON sends nothing to Broken Gear Industries.** The software has no telemetry, no analytics that report to us, no account with us and no license check.
- **What AEON keeps stays on your machine**, in one folder (the AEON home, below).
- **AEON talks to other services when you set them up or use a feature that needs them.** Each of those services sees what AEON sends it and handles it under its own terms. Adding a cloud provider's key can be enough for AEON to send your Vault's documents to that provider to index them — see [Indexing your Vault](#services-you-set-up). **Settings → Models → Local only** keeps every model call, indexing included, on this computer or your own network.
- **Opening AEON sends nothing by itself.** The interface's fonts and icons are served by AEON (see [Things the interface loads](#things-the-interface-loads)).

## What AEON keeps, and where

By default everything lives in one folder, the **AEON home**: a folder named `AEON` in your home folder (`~/AEON`). If AEON itself was installed into `~/AEON`, the home is `~/AEON Data` instead. Setting `AEON_HOME` moves it, and a portable or carried drive keeps it on the drive.

| In the AEON home | What it holds |
|---|---|
| `Vault/` | the documents, memories and notes you add |
| `data/` | search indexes, local models, block data, Cookbook logs |
| `db/` | runtime state: chat log, audit log, retrieval indexes |
| `secrets/` | your API keys, encrypted |
| `.env` | the master key that unlocks `secrets/`, and configuration |
| `aeon-settings.json` | your settings |

Both halves of the key store — `secrets/` and `.env` — sit in the same folder, so anyone who can read the whole AEON home can read your keys. Protect it like a password file.

A block's own secret settings (a field of type `secret` in Settings → Blocks) are not in that encrypted store: they are saved in plain text in `aeon-settings.json`, a file only your account can read (mode 0600 on macOS and Linux).

Your browser also keeps a few things for the AEON page in its own storage: your login session token, layout preferences, quick links and Orion search history.

Cookbook's Download tab uses Hugging Face's own tools, which save models in the Hugging Face cache (`~/.cache/huggingface/hub`, or wherever `HF_HOME` points).

## What AEON sends, and to whom

### Services you set up

- **AI model providers** (for example OpenAI, Anthropic, Google, Groq, OpenRouter, xAI, or an endpoint you add). When you use a cloud model, AEON sends that provider your prompt and what goes with it: the conversation so far, files you attach, and passages AEON pulls from your Vault to answer you, along with your API key. Local models run on your machine and send nothing. With **Local only** off (the default), a local model that cannot answer hands the prompt to a cloud provider you added a key for, and the chat says so in one line; with it on (Settings → Models), no cloud model is tried, not even as a fallback. An agent you set to **Local only** in Memory Core works the same way for its own calls, whatever that switch says: its chats, the titles and distils made from them and, while it is the terminal's agent, the `/ask`, `/recall`, `/ask-doc` and `/read` commands and the sentence that reads a command's result back go only to a model on this computer or your own network; other slash commands use the models set in Settings → Models. For an agent you created, that includes its own memory. Your own AEON's memory is the shared memory: set to Local only, it stays out of indexing and search, but an agent set to Roulette that reads the shared memory still sends it to its own model.
- **Indexing your Vault (the Embedding role).** To make your Vault searchable by meaning, AEON sends the text of every document it indexes there to whichever model serves the Embedding role — a short summary of each document and, for a longer one, its whole text, piece by piece. It does this at startup, once a night, and whenever you add or change a file or memory; the questions you search your Vault with go to the same model. With a local embedding model installed, all of this stays on your machine. **If no local embedding model is installed and you have not assigned the Embedding role yourself, AEON picks the first provider you have added a key for and, if that provider offers an embedding model, uses it without asking — so adding a key (for example OpenAI's or Google's) can be enough to send your whole Vault to that provider in the background.** To keep indexing on your machine, install a local embedding model in Cookbook (nomic-embed-text, about 150 MB) before you add cloud keys, or assign the Embedding role in Settings → Models. With **Local only** on, AEON indexes only with an embedding model on this computer or your own network. A memory you switch off in Memory Core, and the folder of an agent set to Local only there, are not indexed (if they already were, the next scan takes them out) and never come back from `/recall`, `/ask`, `/ask-doc` or chat recall (Aeon Matrix's own search box still lists them, to you); a recall made for that agent — in its chat, or by those commands while it is the terminal's agent — embeds the question with a local embedding model or does not run.
- **Web search.** With a Tavily, Serper or Brave key, your search query goes to that service. **With no search key, or when those services fail, the query goes to DuckDuckGo.** A search in Orion Search then opens the top three web results from their own sites to read them for its answer; each of those sites sees your IP address and a request that names AEON.
- **Supabase** — only if you connect your own Supabase project. The features you turn on there, such as cloud sync, send that data to your project. Cloud sync of the Vault skips a switched-off memory and a Local only agent's folder, and on its next push deletes the copies of them it uploaded earlier.
- **Firebase** — only if AEON is built with your own Firebase project's settings. The page then talks to your project for sign-in and session records, and Firebase Analytics reports to your project unless you switch tracking off in Settings.
- **YouTube** — only if you add YouTube credentials and ask the media pipeline to upload a video.
- **Cloudflare** — only if you turn on remote access (Quick Tunnel) in Settings. AEON downloads Cloudflare's `cloudflared` program from GitHub, and traffic to your AEON then passes through Cloudflare.
- **A block store** — only if you set `AEON_STORE` to a web address. AEON then downloads the catalog and packs from that address.

### Downloads you start

These send no personal data, but like any download they show your IP address to the server.

- **Local AI engine and models.** When you install a local model (Cookbook, or `/model-pull` in the terminal), AEON downloads the llama.cpp engine from GitHub and the model from Hugging Face. If you give Cookbook a Hugging Face token for a gated model, it goes to Hugging Face.
- **Popular-model list.** Opening Cookbook's Download tab asks Hugging Face for a list of popular models.
- **First launch.** The launcher runs `npm install`, which downloads AEON's open-source dependencies from the npm registry.
- **Node.js, if the launcher installs it.** When Node.js is missing and you answer yes, the launcher installs it with Homebrew (macOS), winget (Windows) or your Linux package manager (through NodeSource's setup script on apt and dnf systems), which download it from their own servers.
- **Packs from a link.** If you install a pack from an `https` link (the Master block's Install panel accepts one), AEON downloads it from that address.
- **Text recognition.** To read text in an image or a scanned PDF, AEON needs English language data (`eng.traineddata`). It reads it from its own cache or the `@tesseract.js-data/eng` package; it downloads it from the jsDelivr CDN only if you set `AEON_OCR_DOWNLOAD=1` in `.env`. Without either, the image is reported as not read, with that remedy. The image itself is always read on your machine.

### Things the interface loads

- **Fonts.** The interface's typefaces ship with AEON and are served by AEON itself; nothing is fetched from Google Fonts. Saved Deep Research reports use your system's fonts.
- **Quick Links icons.** Quick Links draws a letter badge for each link and fetches no icons, so the domains you save are not sent anywhere.
- **Narrator voices.** The Narrator's default voice runs on this computer. Voices marked "online" in its picker (Chrome's "Google …" voices, Edge's "Online (Natural)" voices) send each sentence to your browser's speech service.
- **Deep Research sources.** When a report cites a web page, AEON asks archive.org whether an archived copy exists, which sends that page's address to archive.org.

## Free provider tiers

Some providers use what you send on their free tiers to improve their products. For example, Google's terms for unpaid use of the Gemini API, including Google AI Studio, say Google uses the content you submit and the responses to improve its products, and that human reviewers may read them. Other providers have their own rules. Read the terms of any provider you use before sending anything private through a free tier; a paid tier or a local model avoids this.

## Broken Gear Industries

The AEON software sends Broken Gear Industries nothing, so we hold no data about you from it. AEON's own usage counters (model calls, tokens) stay on your machine. If you contact us through GitHub Issues, GitHub's terms and privacy policy apply to what you post there, and issues are public.

## Questions and changes

Questions: open an issue at [github.com/cgomez1365/AEON/issues](https://github.com/cgomez1365/AEON/issues). Never post keys or personal data there.

This notice applies per version, like the [Terms of Use](TERMS_OF_USE.md). A version that changes what AEON sends will change this notice.
