# Retrieval Scope Boundaries (R3 — Ship Plan v2)

> RAG over scoped vector indexes, not fine-tuning.
> Fine-tuning teaches behavior. It does not give a model recall of specific documents.
> A doctor cannot afford a model that "learned the gist" of patient history.

**Engine:** `src/kernel/retrieval.cjs` · `src/kernel/citationGate.cjs`
**Router:** `/api/retrieval/*` · **Test suites:** `node tools/test-retrieval.cjs` (13/13) · `node tools/test-citation.cjs` (30/30)

---

## Scope model

Every indexed document belongs to exactly **one scope**. A scope has:
- An `id` (e.g. `patient_history`, `personal_notes`, `hr_investigations`)
- A `domain` (medical | hr | legal | financial | general)
- An `ownerBlock` — the block that registered and owns this index

Scopes are registered in `db/retrieval/_scopes.json`. The name `global`, `all`, or `*` is **structurally rejected** — there is no cross-scope search primitive. Privacy boundaries are structural, not policy.

### Scope operations

```
POST /api/retrieval/:scope/ingest   { documents: [{id, content, meta}] }
POST /api/retrieval/:scope/search   { query, topK? }
POST /api/retrieval/:scope/query    { query }   ← full citation-gated response
GET  /api/retrieval/scopes          list registered scopes
GET  /api/retrieval/receipts        audit trail (Class 3/4 outcomes)
```

---

## Access gates (dual-layer — R3)

The R3 gate is enforced **inside** `retrieval.cjs` on every search and ingest call, not in the router. Two independent checks:

### Layer 1 — block identity

Caller identity from `x-aeon-block` header. If absent, treated as operator (passes).

| Caller | Access |
|---|---|
| Owner block | ✅ Always allowed |
| Operator (no header / UI) | ✅ Always allowed |
| Kernel internal | ✅ Always allowed |
| Foreign block | ❌ Denied unless Layer 2 passes |

### Layer 2 — Tier 1.5 declaration (cross-block read)

A foreign block may READ (not write) another block's scope if:
1. Its manifest declares `contract.permissions.crossBlockRead: ["<ownerBlockId>"]`
2. The declaration is **per-owner**, not blanket — declaring `second_brain` does not grant access to `medical_intake`'s scope

**Cross-block WRITE always requires Tier 2 approval** — a block cannot ingest into another block's scope even with a declaration.

---

## Citation doctrine (kernel gate — not a prompt)

Three independent systems. The model does not decide whether to cite.

### Class 1 — Generative
Produce something new: "Fix this email." "Refactor this." Model answers from capability. **No retrieval.** Default class.

### Class 2 — General knowledge
Answerable from training: "What is FMLA?" "How does TCP work?" Model answers. **Exception:** if the answer contradicts the user's indexed corpus, corpus wins and gets cited.

### Class 3 — Retrieval-required ⚠
References the user's own data: a specific person, case, patient, file. Tells: "employee X", "patient Y", "my notes on", "our policy". **Retrieval fires BEFORE kernelLLM.** Every specific factual claim must cite `[doc name, chunk ref]`. Empty retrieval = hardcoded "not indexed" refusal — the LLM is never called on this path.

### Class 4 — Knowledge gap
Not in training reliably AND not in corpus: current events, recent case law, newly approved drugs. **Scraper fires first.** Answer built from scraped result, fully cited. Model NOT permitted to answer from training on Class 4.

### Domain escalation rule

These phrases **always** escalate to Class 3 regardless of how the query is phrased:

| Domain | Escalation trigger |
|---|---|
| Medical | Named patient in query |
| HR / Legal | Named employee or active/past case |
| Financial | Specific transaction, account, or filing |

Even "just draft a note about John's case" → Class 3 (named person in HR domain → retrieval fires).

### Bypass surface

**There is no bypass.** No `skipCitations`, no `forceClass`, no prompt phrasing that lowers the class. Junk options are ignored. Tested in `test-citation.cjs` cases 29-30.

---

## Audit trail

Every Class 3 and Class 4 outcome (answered / refused / denied) writes a receipt to `db/retrieval/receipts.jsonl`:

```jsonc
{
  "correlationId": "uuid",
  "class": 3,
  "query": "...",
  "scope": "hr_investigations",
  "hitsReturned": 2,
  "chunks": ["martinez_file#1", "martinez_file#3"],
  "citations": ["martinez_file#1"],
  "outcome": "answered",    // answered | refused | denied
  "timestamp": "..."
}
```

This is how an HR department or medical practice defends their AEON usage if a response is ever challenged.

---

## Seeding / reseeding

```bash
node tools/reseed-retrieval.cjs
```

Deterministic ops bot — zero LLM tokens. Reads `vault_index.json`, filters tooling paths, ingests into `personal_notes` (owner: `second_brain`). Rerunnable at any time. Run with Ollama active for cosine embeddings on top of the BM25 floor.

BM25 is the deterministic fallback: always works, zero tokens, survives Ollama being down. The doctrine holds on the BM25 floor alone.
