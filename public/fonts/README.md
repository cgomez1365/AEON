# Fonts

The interface's three typefaces, served from this install so loading the UI
contacts no font service. `src/aurora.css` declares them with `@font-face`.

| Family | File | Licence |
|---|---|---|
| Space Grotesk | `space-grotesk/space-grotesk-latin-wght.woff2` | SIL OFL 1.1 — `space-grotesk/OFL.txt` |
| JetBrains Mono | `jetbrains-mono/jetbrains-mono-latin-wght.woff2` | SIL OFL 1.1 — `jetbrains-mono/OFL.txt` |
| Inter | `inter/inter-latin-wght.woff2` | SIL OFL 1.1 — `inter/OFL.txt` |

Each file is the Latin subset with a variable weight axis covering 400–700, as
Google Fonts serves it (fetched 2026-09-30: Space Grotesk v22, JetBrains Mono
v24, Inter v20). Text in other scripts falls back to the system fonts in each
stack. The `OFL.txt` files are copied from `github.com/google/fonts` (`ofl/`).
