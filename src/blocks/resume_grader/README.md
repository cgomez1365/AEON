# Resume Grader

**ID:** `resume_grader`
**Nav route:** `/resume-grader`
**Tier:** `plugin`
**Status:** ACTIVE — **KEPT.** Decision made 2026-08-04 (BO-A3c).

## Fate decision — closed

This block was flagged "CEO may still remove entirely" on 2026-07-24 and stayed
undecided through three build orders. BO-A3c required a decision, on the
grounds that carrying an undecided block costs a manifest, a route, a scanner
pass and a line in every census. **It is kept.** Reasons, so this does not
reopen:

- It is 215 lines total, one route, zero cross-block dependencies, and has
  never produced a defect in any audit or stress round.
- The cost of carrying it is now near zero *because of* BO-A2. The empty-shell
  test proves a block can be added and removed cleanly at any time, so deleting
  this later is a one-command operation with a gate behind it — not a one-way
  door that had to be decided before release.
- R-09, revenue-first: removal has no revenue upside. Retention keeps a
  sellable cartridge — resume grading is exactly the paid-pack shape the
  Bible's business layer describes (p26–27).
- Deleting a working product surface days before a release, to save 215 lines,
  is the wrong trade in the wrong week.

If it is ever removed, apply the deletion protocol (prove dead, gate first,
one scoped commit, drive the surface after) — not an ad-hoc `rm`.

One screen: paste (or upload) a résumé and, optionally, the job posting, and
get a compliance-first fit score. **Nothing is stored** — no candidate
records, no history, no database. (The candidate-pipeline routes this README
used to describe — intake / candidates / grade-all / alert, Supabase storage,
`pdf-parse` — were removed in the 2026-07-24 cleanup; this file described
them until 2026-09-23.)

## What it does

- **Upload** — a PDF or .txt résumé is read into the résumé box
  (`POST /api/resume-grader/extract`, base64 JSON, nothing written to disk).
  The operator sees and can fix the text before grading. A scanned PDF with
  no text layer is refused with a remedy; a Word file is refused with "save
  it as a PDF" (AEON does not read .docx).
- **Grade** — sends résumé + job description to the `grading` role
  (Settings → Model Assignment) through `kernelLLM.stream`, which says whether
  the model stopped at its output limit. The model returns subscores,
  rationale, strengths, gaps and a recommendation as JSON.
- **The score is the breakdown's sum.** The rubric defines the score as the
  weighted sum of the four subscores, and models mis-add (measured: 91 claimed
  over subscores summing to 74). When all four subscores are present they are
  clamped to their maxima and summed here; a mismatch is shown to the
  operator as a note. The letter grade is derived from that score, and a C
  cannot carry RECOMMEND (capped to MAYBE), a D/F is PASS.
- **Failures say what happened** — a cut-off answer ("the model stopped at
  its output limit"), a reply that is not JSON, a rate limit (HTTP 429, retry
  in a minute) and "no model assigned to grading" (503) each have their own
  message. None is a raw JSON parse error.

### EEOC-compliant grading rubric

The prompt instructs the model to score using **only** job-related criteria
and to ignore and never mention age, gender, race, ethnicity, religion,
national origin, disability, health, marital/family/pregnancy status, photos,
name-based inferences, address/zip, or graduation-year-inferred age.
Employment gaps may be noted only as neutral facts.

| Component | Weight |
|---|---|
| Skills match vs. required skills | 40 pts |
| Relevant experience (depth + recency) | 30 pts |
| Scope/seniority fit | 15 pts |
| Role-specific requirements (certs, tooling, domain) | 15 pts |

Grade bands: **A ≥ 85 · B 70–84 · C 55–69 · D 40–54 · F < 40**

## API routes

| Method | Path | File | Purpose |
|---|---|---|---|
| POST | `/api/resume-grader/grade` | `api/grade-resume.js` | Grade `{ resume, jobDescription }` — stateless |
| POST | `/api/resume-grader/extract` | `api/extract-resume.js` | `{ filename, data: base64 }` → `{ text, pages, kind }` |

`/grade` also answers GET/OPTIONS for CORS preflight; a GET returns 405 by
design (a probe that GETs it is not a failure).

## Config

No keys or env vars of its own. Grading needs a model on the `grading` role
(it falls back to the `chat` role's endpoint when `grading` is unassigned).

## Files

- `index.jsx` — the single-screen grader
- `api/grade-resume.js` — grading, score reconciliation, failure messages
- `api/extract-resume.js` — PDF / text résumé upload
- `block.manifest.json` — kernel metadata

## Tests

`tests/resume-grader-grade.test.js`, `tests/resume-grader-extract.test.js`.
