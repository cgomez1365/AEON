# Third-party notices

AEON itself is under the AEON Community License ([`LICENSE`](LICENSE)). It also
ships, installs or downloads software and data that other people wrote, each under
its own license. This file lists them and where each license is. It was written
2026-10-03 from the repository at v3.2.0.

## In the download

| What | Where | License | License text |
|---|---|---|---|
| Space Grotesk, JetBrains Mono and Inter typefaces | `public/fonts/` | SIL Open Font License 1.1 | `OFL.txt` in each font's folder; see [`public/fonts/README.md`](public/fonts/README.md) |
| three.js, 3d-force-graph and their dependencies (ngraph, kapsule, float-tooltip, d3-force-3d, d3 modules, polished, tween.js, preact and others), bundled into one prebuilt file for the Second Brain graph | `src/blocks/aeon_matrix/public/vendor/graph-bundle.mjs` | MIT, ISC and BSD-3-Clause | `THIRD_PARTY_LICENSES.txt` in the same folder, with each package's copyright notice and full license text |

## Installed when you set AEON up

The npm packages in [`package.json`](package.json) are not in the download.
`launch.js` installs them into `node_modules/` on first run (`npm install`, or
`npm ci` after an install that did not finish), and each package's license comes
with it, in its own folder. [`package-lock.json`](package-lock.json) records the
versions.

One of them deserves a note. **`ffmpeg-static`** is licensed GPL-3.0-or-later, and
its install step downloads a static FFmpeg binary for your OS from the
[ffmpeg-static GitHub releases](https://github.com/eugeneware/ffmpeg-static/releases).
That build's license and build record are `ffmpeg.LICENSE` and `ffmpeg.README` in
`node_modules/ffmpeg-static/`. FFmpeg's source code:
<https://ffmpeg.org/download.html#get-sources>.

## Downloaded only when you use a feature

| What | When | From | License |
|---|---|---|---|
| llama.cpp runtime | The first time you install a local model (Cookbook or `/model-pull`) | The pinned release in [`services/local-runtime/runtime-assets.json`](services/local-runtime/runtime-assets.json), from GitHub | MIT — <https://github.com/ggml-org/llama.cpp/blob/master/LICENSE> |
| Model weights | When you install a model | Hugging Face | Each model's own license. For the catalogue models: Apache-2.0, MIT, the Llama 3.1 and 3.2 Community Licenses, or the Gemma Terms of Use; [`services/local-runtime/model-catalog.json`](services/local-runtime/model-catalog.json) records each one, and Cookbook shows it before the download starts. A model pulled by Hugging Face repo name comes under the license that repo states. The weights are not under the AEON Community License. |
| cloudflared | The first time you start a Remote Access tunnel | Cloudflare's GitHub releases | Its own license: <https://github.com/cloudflare/cloudflared/blob/master/LICENSE> |
| OCR language data for tesseract.js | Only with `AEON_OCR_DOWNLOAD=1` in `.env` | cdn.jsdelivr.net (`@tesseract.js-data/eng`) | Its own license, published with that package |

Downloads land in AEON's data folder (`~/AEON/data` by default), `node_modules/`
or `tools/bin/`. They are not part of the download from GitHub.

## On a portable drive

A drive built with `scripts/build-usb.js` also carries `node_modules/` (with the
FFmpeg binary), portable Node.js, and any model you seed. The builder writes
`THIRD_PARTY_NOTICES.txt` at the drive's root for those, and a `.LICENSE.txt` file
beside each seeded model that points to that model's license.
