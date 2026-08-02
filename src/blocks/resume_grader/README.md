# Resume Grader

**ID:** `resume_grader`
**Nav route:** `/resume-grader`
**Tier:** `plugin`
**Status:** ACTIVE

Résumé and candidate intake/grading pipeline. A recruiter pastes a job
description, uploads a candidate's PDF résumé, and the block extracts the
résumé text, grades the candidate against the JD with an EEOC-compliant
rubric via `kernelLLM`, and can draft an internal hiring-alert email for
top picks. Pipeline: **Intake → AI Grade → Alert**.

## What it does

- **Intake** — form captures name/email/phone/role + pasted job description,
  and a PDF résumé upload. The PDF is parsed server-side (`pdf-parse`) to
  plain text; image-only PDFs with no extractable text are rejected (422).
- **Grade** — sends the JD + résumé text to `kernelLLM` (contract role
  `"grading"`) with a fixed compliance-first prompt. The model returns a
  0-100 score, subscores, rationale, strengths, red flags, and an interview
  recommendation. The score is the source of truth; the letter grade is
  derived server-side from the score band (never trusted from the model).
- **Grade All** — batch-grades every ungraded candidate in one call.
- **Alert** — for a graded candidate, calls Gemini directly (not through
  `kernelLLM`) to draft a short internal hiring-alert email (subject + body)
  that the recruiter can copy to clipboard.
- **Candidates** — list/delete candidates; local dev mirrors to Supabase in
  the background, Vercel/cloud reads and writes Supabase directly.

### EEOC-compliant grading rubric

Used by both `grade.js` and `grade-all.js`. The prompt instructs the model
to score using **only** job-related criteria and to ignore and never
mention age, gender, race, ethnicity, religion, national origin, disability,
health, marital/family/pregnancy status, photos, name-based inferences,
address/zip, or graduation-year-inferred age. Employment gaps may be noted
only as neutral facts.

| Component | Weight |
|---|---|
| Skills match vs. required skills | 40 pts |
| Relevant experience (depth + recency) | 30 pts |
| Scope/seniority fit | 15 pts |
| Role-specific requirements (certs, tooling, domain) | 15 pts |

Grade bands: **A ≥ 85 · B 70–84 · C 55–69 · D 40–54 · F < 40**
Recommendation: `RECOMMEND` (A/B, no critical gap) · `MAYBE` (C, or B with
one critical gap) · `PASS` (otherwise).

## API routes

All routes live under `/api/resume-grader/*` and are registered by the "plugin
pattern" (each `api/*.js` file calls `app[method](...)` directly against
the block's scoped sub-router — see `src/kernel/blockHost.cjs`). Every
route also technically accepts all of GET/POST/PUT/DELETE/OPTIONS (CORS
preflight support) but the handler itself enforces the real verb and
returns `405` for anything else.

| Method | Path | File | Purpose |
|---|---|---|---|
| POST | `/api/resume-grader/grade` | `api/grade-resume.js` | Grade a résumé against a job description via `kernelLLM` — stateless, nothing stored |

The frontend (`index.jsx`) is a single-screen **Resume Grader**: paste a
résumé + (optional) job description, `POST /api/resume-grader/grade`, render the
grade. No candidate records, no storage. The legacy candidate-pipeline
endpoints — `intake` / `candidates` / `grade` / `grade-all` / `alert` — were
removed in the 2026-07-24 cleanup.

## Storage

- **Local/dev** (`process.env.VERCEL` unset): source of truth is
  `db/aeon_ats.json` at the repo root (resolved relative to this file, no
  hardcoded paths). Writes also fire-and-forget mirror to the Supabase
  `aeon_candidates` table.
- **Cloud/Vercel** (`process.env.VERCEL` set): Supabase `aeon_candidates`
  table is read/written directly — there's no writable local filesystem in
  that runtime.

## Config keys / env vars

| Var | Required | Used by |
|---|---|---|
| `GEMINI_PAID_KEY` / `GEMINI_FREE_KEY_1` (`GEMINI_API_KEY` as an extra fallback) | Yes (one of) | `api/alert.js` — direct Gemini call for the alert email draft |
| `SUPABASE_URL` (or `VITE_SUPABASE_URL`) | Yes | all `api/*.js` — Supabase client |
| `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_ANON_KEY` / `VITE_SUPABASE_ANON_KEY`) | Yes | all `api/*.js` — Supabase client |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | Yes (browser) | `index.jsx` — direct-to-Supabase fallback fetches |

Grading (`grade.js`, `grade-all.js`) does **not** call Groq or Gemini
directly — it goes through the injected `kernelLLM(prompt, { role: 'grading' })`,
which is provider-agnostic and resolves to whichever provider/model is
currently assigned to the `grading` role (the bundled local runtime by
default, per `.aeon.runtime.json`). Because of that, `GROQ_API_KEY` was
removed from this block's declared requirements — nothing in this block's
code reads it or calls Groq directly.

## Dependencies

- `@supabase/supabase-js` — candidate storage/sync
- `@google/generative-ai` — direct Gemini call for alert-email drafting
- `pdf-parse` — résumé PDF → plain text extraction
- `kernelLLM` (injected via block host `deps`, requires `contract.permissions.ai: true`) — grading

## Files

- `index.jsx` — `ATSPanel` UI: stats row, intake modal, candidate table, AI grade-dossier modal, alert-dispatch modal
- `api/intake.js` — candidate creation + PDF parsing
- `api/candidates.js` — list/delete
- `api/grade.js` — single-candidate grading
- `api/grade-all.js` — batch grading
- `api/alert.js` — hiring-alert email draft
- `block.manifest.json` — kernel metadata (auto-loaded by the block host)

## Known routing note

`/api/resume-grader/*` is served exclusively by this block. A prior cross-block bug
had `aeon_matrix`'s `api/sync.cjs` shadowing these routes; that router now
only registers `/sync/*` and `/logistics/*` paths, so no collision exists
today. If you add new `/api/resume-grader/*` routes, grep the repo for the path
first — this block previously had a route-collision incident.
