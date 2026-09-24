/**
 * AEON — context assembly. The ONE recall policy (BO-MEM M1).
 *
 * Second Brain Doctrine R05: one recall policy, in one place. Two copies drift,
 * and the endpoint holding the stale copy quietly stops recalling. That is not
 * a hypothetical here — when this module was written the gate existed THREE
 * times (dashboard/api/chat-stream.cjs, dashboard/api/chat.cjs,
 * aeon_matrix/api/retrieve.cjs), byte-identical in two of them and already
 * drifted in eight ways between the two live copies: which string is gated
 * versus queried, an unguarded `d.metadata.source` that throws, a missing
 * timeout, a Host-header base URL, whether memory is injected at all, and how
 * much of §08's remedy text the model is given.
 *
 * So the gate, the transport, the failure taxonomy and the budget live here,
 * and callers supply only what is genuinely theirs: the message, the caller's
 * credentials, and the window they are spending from.
 *
 * What this module does NOT do: decide which memories rank highest (that is
 * memory-policy.cjs), talk to a model, or hold state. It assembles context and
 * reports honestly what it assembled.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const memoryPolicy = require('./memory-policy.cjs');
const { inputBudgets, estimateTokens } = require('./tokens.cjs');

// ── The recall gate — one copy ──────────────────────────────────────────────
//
// Asking "what's in my notes about X" hit the model's training data and
// nothing else until this gate existed. It stays a gate rather than always-on
// because an ordinary message must not pay for a vault round-trip.
const RECALL_PATTERNS = Object.freeze([
  /\b(remember|told|said|mentioned|last time|earlier|before|yesterday|history|historical|conversation|we discussed|i asked)\b/i,
  // The record-keeping verbs. The named workload is an analyst LOGGING
  // incidents offline; "what did I log about the DocuSign lure" is the exact
  // question the second brain exists to answer, and none of these words were
  // in the gate. A false positive costs one vault round-trip; a miss answers
  // from training data with a straight face.
  /\b(record(?:ed)?|log(?:ged)?|noted|wrote down|filed)\b/i,
  /\b(my notes?|my docs?|my files?|second brain|brain|knowledge base|what do i know)\b/i,
  /\b(find|search|look up|retrieve|recall|pull up)\b/i,
  /\b(aeon )?matrix\b/i,
  /\b(vault|reading library)\b/i,
  /\b(collected|on file|our (data|records|knowledge)|existing (data|notes|documentation))\b/i,
  // How people actually ask about their own material. Measured live: "what
  // did I write about the deletion protocol in the bible" and "how many build
  // orders did I write in my reports" both missed every pattern above, so the
  // vault was never consulted and the model answered from nothing.
  /\b(what|which|when|where|how|why|who) (did|do|have) i\b/i,
  /\b(my|our) (bible|doctrine|reports?|build orders?|eod|session logs?|records?|logs?|memos?|decisions?|documents?)\b/i,
  /\b(in|from|per|according to|based on) (my|the|our) (bible|doctrine|reports?|notes?|vault|build orders?|records?|logs?|files?|docs?|documents?)\b/i,
]);

// A question whose answer is a NUMBER over the corpus. Retrieval returns k of
// N; answering "how many" from k is the silent-wrong-answer class the doctrine
// forbids outright (R02): "3" when the truth is 47, with citations.
const COUNTING_RE = /\b(how many|how much|count|total( number)?|number of|list (all|every)|all (of )?(my|the|our)|every)\b/i;

const FORCE_PREFIX = '/matrix ';

/**
 * How an answer should be SHAPED. One sentence of instruction, one of limit.
 *
 * The operator gets walls of prose because nothing in the prompt ever asked
 * for anything else: "i know ais can format stuff really well but current
 * terminal limits that ability and sometimes i get really large paragraphs
 * instead of well formatted responses, outlines or reports" (2026-09-17). The
 * terminal's side of that is fixed — a table no longer overruns the panel —
 * but a model that is never told it is writing into a 380px column has no
 * reason to write for one.
 *
 * Two constraints on this string, and they are why it is this short:
 *
 *   1. It rides on EVERY turn, so it is two sentences and no examples.
 *   2. It must not compete with the rules that already live in this prompt.
 *      The memory policy, the citation doctrine ("quote the sentence you rely
 *      on and name the file") and the counting rule are claims about TRUTH;
 *      this is a claim about LAYOUT only, and it says so outright — otherwise
 *      "be brief" is exactly the licence a model needs to drop the caveat, the
 *      citation, or the admission that it did not find something. That second
 *      sentence is the whole reason this is safe to add.
 *
 * It belongs with the identity, ahead of memory and of the retrieved passages,
 * so it reads as part of how AEON speaks rather than as an instruction about
 * the operator's documents. Both conversational callers append it to their
 * identity line: src/kernel/routers/ai.cjs (POST /api/ai/converse) and
 * src/blocks/dashboard/api/chat-stream.cjs (POST /api/chat/stream, which is
 * what the terminal and the browser chat actually stream through). One string,
 * two callers — the same reason the recall gate lives here and not in three
 * places.
 */
const FORMATTING = 'Your answer is read in a narrow terminal panel, so prefer short paragraphs, headings and tight bullet lists over long prose, keep code in fenced blocks, and use a table only when every column is short. Shape is all this governs: never drop a caveat, a citation, or an admission of uncertainty to make an answer fit.';

// The wake phrase. Was a private const in chat-stream.cjs; the terminal needs
// the same one, and two copies of a trigger phrase drift exactly like two
// copies of a gate do.
//
// It only ever matched "vp", the persona's name before it was renamed to Aeon
// (Agents/vp -> Agents/Aeon, commit 30eea62). The rename never reached here, so
// the one phrase that loads the operator's FULL memory could not be said using
// the product's own name: "aeon come online" did nothing at all, silently,
// which reads as a memory that simply does not work.
//
// An optional agent name sits between the wake word and "online", so
// "aeon shield come online" names who is being called. The name is captured for
// the caller to resolve against the roster; an unknown one still wakes AEON
// itself rather than failing, because the operator's intent to wake is not in
// doubt just because the name was.
const WAKE_RE = /\b(?:aeon|vp)(?:\s+([a-z][a-z0-9 _-]{0,30}?))?[,!]?\s+(?:come\s+)?online\b/i;

/** The agent named in a wake phrase, or null for AEON itself. */
function parseWake(message) {
  const m = WAKE_RE.exec(String(message || ''));
  if (!m) return { wake: false, agent: null };
  const named = (m[1] || '').trim().toLowerCase();
  return { wake: true, agent: named && named !== 'come' ? named : null };
}

/**
 * Everything a single-prompt transport needs, as one string.
 *
 * POST /api/ai takes `{prompt, role}` and nothing else — no messages array, no
 * system turn. So the assembled context has to travel INSIDE the prompt: the
 * standing identity, then working memory, then the recent turns of THIS
 * session (supplied by the caller — the terminal holds session state and
 * nothing else, R04), then the operator's line with any retrieved documents
 * riding beside it. Documents sit with the question, not above it, so they
 * read as material for this turn rather than as instructions that outrank it.
 */
function composePrompt({ identity, memoryText, history = [], query, recallContext = '' }) {
  const turns = (Array.isArray(history) ? history : [])
    .filter(t => t && typeof t.content === 'string' && t.content.trim())
    .slice(-8)
    .map(t => `${t.role === 'assistant' ? 'AEON' : 'Operator'}: ${t.content.trim()}`)
    .join('\n');
  return [
    identity + (memoryText || ''),
    turns ? `\n## RECENT TURNS (this session)\n${turns}` : '',
    `\n## OPERATOR\n${query}${recallContext || ''}`,
  ].join('\n');
}

/** Would this message trigger a vault lookup on its own? */
function isRecallQuery(text) {
  const lower = String(text || '').toLowerCase();
  return RECALL_PATTERNS.some((p) => p.test(lower));
}

/**
 * Split a message into { query, forced, manifest }.
 *
 * The force prefix is stripped so the model never sees the command itself —
 * and the SAME string is both gated and queried. The old copies gated on one
 * field and queried with another, which is how one of them ended up unable to
 * fire for any real caller.
 *
 * `/matrix list <query>` asks WHAT MATCHED without paying for the passages. A
 * search result and a document are different things, and treating them as one
 * is what makes a single question cost a whole window: the operator wanting to
 * know whether a PDF is in there does not need the PDF.
 *
 * Only `list` opens that mode. `what` and `which` were tried and are wrong:
 * they open ordinary questions far more often than they request a list, so
 * `/matrix what changed` became a manifest search for "changed" and quietly
 * answered a question nobody asked. A keyword that captures normal speech is
 * not a keyword.
 */
function parseRecallInput(message) {
  const raw = String(message || '');
  const forced = raw.toLowerCase().startsWith(FORCE_PREFIX);
  let query = forced
    ? raw.slice(FORCE_PREFIX.length).trim().replace(/^"(.*)"$/, '$1')
    : raw;
  let manifest = false;
  const listed = /^list\s+(.+)$/is.exec(query);
  if (forced && listed) {
    manifest = true;
    query = listed[1].trim().replace(/^"(.*)"$/, '$1');
  }
  return { query, forced, manifest };
}

/**
 * What matched, without what it says.
 *
 * Costs roughly 25 tokens a document instead of the hundreds a passage costs,
 * so a search over a large vault is affordable on any model — including a
 * local one whose whole window is smaller than a single PDF.
 *
 * The model is told plainly that it has titles and NOT contents, because the
 * failure this invites is obvious and severe: a list of filenames is exactly
 * enough for a model to guess confidently at what is inside them.
 */
function renderManifest({ docs, matched, query, budgetTokens, reason = 'asked' }) {
  const rows = docs.map((d, i) => {
    const title = d?.metadata?.source || d?.id || 'document';
    const p = d?.metadata?.path || d?.metadata?.source_id || d?.id || '';
    const sim = typeof d?.similarity === 'number' ? ` · ${d.similarity.toFixed(2)}` : '';
    return `${i + 1}. ${title}${p && p !== title ? ` — ${p}` : ''}${sim}`;
  });
  const total = Number.isFinite(matched) ? matched : docs.length;
  const why = reason === 'too-large'
    ? `Every match was too large for this turn's ${budgetTokens}-token budget — none fit, so here is what was found instead of nothing.`
    : 'The operator asked what matched, not for the passages.';

  return `\n\n[AEON SECOND BRAIN CONTEXT — SEARCH RESULTS ONLY]\n`
    + `${total} document${total === 1 ? '' : 's'} in the operator's vault match "${query}". `
    + `${why} Showing ${rows.length}.\n\n${rows.join('\n')}\n\n`
    + `You have their TITLES ONLY. You have not read them, and you must not say what any of them `
    + `contains, summarise one, or answer a question from one. Report the list, and tell the `
    + `operator they can name one to open it. If they asked a question these documents might `
    + `answer, say which look relevant and that you need to open one first.`;
}

/**
 * The kernel's own address.
 *
 * Loopback, never the Host header. The retrieve route is served by THIS
 * process, so the address is known; deriving it from a request header would
 * let a caller send `Host: evil.com` and have the kernel POST the operator's
 * query — and their vault content — to that host instead.
 */
function kernelBase() {
  return process.env.AEON_KERNEL_URL || `http://127.0.0.1:${process.env.PORT || 3001}`;
}

/**
 * Forward the caller's credentials onto the internal call.
 *
 * The loopback fetch below is a brand-new request from the server to itself and
 * carries NONE of the caller's session unless it is forwarded explicitly.
 * /api/crn/second-brain/retrieve declares auth:true and is not a pre-auth
 * route, so without this the guard 401s it — and a 401 body carries neither
 * `documents` nor `unavailable`, so the caller fell through every branch and
 * told the operator "no relevant indexed documents were found" for a search
 * that never ran. A locked install reported an empty vault.
 *
 * commandRegistry.cjs learned this exact lesson already (17 of 21 commands
 * silently broken whenever the guard was on). This is the same fix, in the
 * caller that never got it.
 */
function forwardedAuth(auth) {
  const headers = { 'Content-Type': 'application/json' };
  if (!auth) return headers;
  const authorization = auth.authorization || auth.Authorization;
  const cookie = auth.cookie || auth.Cookie;
  if (authorization) headers.Authorization = authorization;
  if (cookie) headers.Cookie = cookie;
  return headers;
}

/**
 * Trim retrieved documents to a token budget, and say what was left out.
 *
 * R03: state what was dropped. Whole documents are dropped rather than being
 * cut mid-sentence — half a document quoted as a source is worse than one
 * document fewer, because the model cites it as if it read the whole thing.
 */
function fitDocuments(docs, budgetTokens) {
  const kept = [];
  let used = 0;
  let dropped = 0;
  for (const d of docs) {
    const title = d?.metadata?.source || d?.id || 'document';
    const p = d?.metadata?.path || d?.metadata?.source_id || d?.id || '';
    // Title AND path: two files with the same heading were rendering as
    // identical citations, and the model could not tell them apart either.
    const line = `[${title}${p && p !== title ? ` — ${p}` : ''}] ${d?.content || ''}`;
    const cost = estimateTokens(line);
    // `continue`, not `break` — one long document must not evict every
    // shorter one behind it.
    if (used + cost > budgetTokens) { dropped++; continue; }
    kept.push({ line, doc: d });
    used += cost;
  }
  return { kept, dropped, tokensUsed: used };
}

/**
 * Look the operator's own record up, if this turn warrants it.
 *
 * Every return carries `ran` — whether a search actually happened — so no
 * caller can report an absence of documents that were never consulted.
 *
 * @returns {Promise<{query,forced,ran,ok,count,dropped,citations,context,unavailable,error}>}
 */
async function buildRecallContext(message, {
  auth = null,
  budgetTokens = 2048,
  timeoutMs = 8000,
  fetchImpl = null,
  manifest = false,
} = {}) {
  const { query, forced, manifest: wantsManifest } = parseRecallInput(message);
  const manifestMode = manifest || wantsManifest;
  const base = {
    query, forced, ran: false, ok: true, count: 0, dropped: 0,
    citations: [], context: '',
  };

  if (!forced && !isRecallQuery(query)) return base;

  const doFetch = fetchImpl || globalThis.fetch;
  let data;
  let status = 0;
  try {
    const r = await doFetch(`${kernelBase()}/api/crn/second-brain/retrieve`, {
      method: 'POST',
      headers: forwardedAuth(auth),
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = r.status;
    data = await r.json().catch(() => ({}));
    // `null`, an array, a bare string — all valid JSON, none an object. Reading
    // `.documents` off null throws into the catch below and reports the index
    // as unreachable, which is a different claim from "answered nonsense".
    if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};

    // A non-200 is NOT an empty result. This is the distinction whose absence
    // turned a 401 into "your vault has nothing in it" (§08, R-05).
    if (!r.ok) {
      const isAuth = status === 401 || status === 403;
      return {
        ...base,
        ran: false,
        ok: false,
        error: isAuth ? 'recall_unauthorized' : `recall_failed_${status}`,
        context: `\n\n[AEON SECOND BRAIN CONTEXT]\nThe operator's document index COULD NOT BE SEARCHED for this request. `
          + (isAuth
            ? 'The search was refused because this request carried no unlocked session. '
              + 'Remedy: unlock the vault, or sign in, and ask again.'
            : `The index service answered ${status}. Remedy: check that AEON's server is running and the Aeon Matrix block is mounted.`)
          + '\nTell the operator this plainly before answering. Do NOT claim their documents are irrelevant or missing — they were never searched.',
      };
    }
  } catch (e) {
    // Best-effort: a chat turn is never blocked on the index being down. But
    // the failure is reported, not swallowed — the old copy caught and
    // discarded, so a wedged index was indistinguishable from an empty vault.
    return {
      ...base,
      ran: false,
      ok: false,
      error: e?.name === 'TimeoutError' ? 'recall_timeout' : 'recall_unreachable',
      context: forced
        ? `\n\n[AEON SECOND BRAIN CONTEXT]\nThe operator's document index could not be reached for this request (${e?.message || 'no response'}). Say so plainly; do not answer as though their documents were searched.`
        : '',
    };
  }

  const docs = Array.isArray(data.documents) ? data.documents : [];

  if (docs.length) {
    const matchedTotal = Number.isFinite(data.matched) ? Number(data.matched) : docs.length;

    // Asked for the list: hand back the list. This is the cheap half of a
    // two-step read — find out what is there, then open the one that matters —
    // and it costs about 25 tokens a document instead of the hundreds a
    // passage costs.
    if (manifestMode) {
      return {
        query, forced, ran: true, ok: true, manifest: true,
        count: docs.length, dropped: 0, matched: matchedTotal,
        citations: docs.map((d, i) => ({
          n: i + 1,
          title: d?.metadata?.source || d?.id || 'document',
          path: d?.metadata?.path || d?.metadata?.source_id || d?.id || null,
          similarity: typeof d?.similarity === 'number' ? Number(d.similarity.toFixed(3)) : null,
        })),
        context: renderManifest({ docs, matched: matchedTotal, query, budgetTokens, reason: 'asked' }),
      };
    }

    const { kept, dropped, tokensUsed } = fitDocuments(docs, budgetTokens);

    // Every match was too large for this window — a real case on a small local
    // model. Rendering the "relevant knowledge" header above an empty list
    // would read as "searched, found nothing", which is the opposite of true.
    // Nothing fit. This used to be a dead end: an apology, and an operator none
    // the wiser about what had actually matched. But a list of titles is a
    // fraction of the cost of one passage, so the budget that could not afford
    // the documents can always afford their names. A narrower question is far
    // easier to ask when you can see what is there.
    if (!kept.length) {
      return {
        query, forced, ran: true, ok: true, manifest: true,
        count: 0, dropped, matched: matchedTotal, tokensUsed: 0,
        citations: docs.map((d, i) => ({
          n: i + 1,
          title: d?.metadata?.source || d?.id || 'document',
          path: d?.metadata?.path || d?.metadata?.source_id || d?.id || null,
          similarity: typeof d?.similarity === 'number' ? Number(d.similarity.toFixed(3)) : null,
        })),
        context: renderManifest({ docs, matched: matchedTotal, query, budgetTokens, reason: 'too-large' }),
      };
    }
    const citations = kept.map((k, i) => ({
      n: i + 1,
      title: k.doc?.metadata?.source || k.doc?.id || 'document',
      path: k.doc?.metadata?.path || k.doc?.metadata?.source_id || k.doc?.id || null,
      similarity: typeof k.doc?.similarity === 'number' ? Number(k.doc.similarity.toFixed(3)) : null,
    }));
    // R03 — when the budget truncates, the model is told, so it cannot present
    // a partial read as a complete one.
    const truncationNote = dropped
      ? `\n\n${dropped} further matching document${dropped === 1 ? ' was' : 's were'} found but did not fit this turn's context budget. If the answer depends on completeness, say so rather than answering from the documents below alone.`
      : '';
    // How many cleared the floor versus how many are shown. The retriever cuts
    // to k; the model must know it is looking at a sample.
    const matched = matchedTotal;
    const subsetNote = matched > kept.length
      ? `\n\nShowing ${kept.length} of ${matched} matching documents.`
      : '';
    // R02 — never answer a counting question from a subset. Said to the model
    // in so many words, because the alternative is "3" with citations when the
    // truth is 47.
    const countingNote = COUNTING_RE.test(query)
      ? `\n\nThis is a COUNTING question. You were given ${kept.length} of ${matched} matching documents — a sample, not the whole record. Do NOT state a total or an exact number. Say the count cannot be determined from a sample, name what you did see, and suggest the operator narrow the question or use a filter over the index.`
      : '';
    return {
      query, forced, ran: true, ok: true,
      count: kept.length, dropped, matched, citations, tokensUsed,
      // The instruction is stronger than "cite the source" because a cited
      // source did not stop this: given the Bible with the wrong window, the
      // model INVENTED a principle and attributed it to §07. A claim about what
      // a document says must be a quotation from a passage below, or an
      // admission that the passage does not contain it (R01, §08).
      context: `\n\n[AEON SECOND BRAIN CONTEXT]\nRelevant passages from the operator's own documents. Answer ONLY from these passages. When you state what a document says, quote the sentence you rely on and name the file. If the passages do not contain the answer, say so plainly — never reconstruct it from a document's title, from memory of what such a document usually says, or from general knowledge. If nothing here is relevant, ignore it:\n\n${kept.map(k => k.line).join('\n\n')}${subsetNote}${truncationNote}${countingNote}`,
    };
  }

  // The index could not be searched — no embedding model, nothing indexed yet,
  // or an index built in a different vector space. The model is handed the
  // remedy verbatim so the operator gets something to DO, rather than an
  // absence of documents that were never actually consulted.
  if (data.unavailable) {
    return {
      ...base,
      ran: false,
      unavailable: data.unavailable.reason,
      context: `\n\n[AEON SECOND BRAIN CONTEXT]\nThe operator's document index COULD NOT BE SEARCHED for this request. Reason: ${data.unavailable.message} Remedy: ${data.unavailable.action || data.unavailable.remedy}\nTell the operator this plainly before answering. Do not claim their documents are irrelevant or missing — they were never searched. Answer from general knowledge only if that is still useful, and say that is what you are doing.`,
    };
  }

  // A real, completed search that matched nothing. Only worth saying when the
  // operator explicitly asked: on a pattern-triggered lookup they did not ask
  // for a search, so reporting an empty one is noise.
  return {
    ...base,
    ran: true,
    context: forced
      ? `\n\n[AEON SECOND BRAIN CONTEXT]\nNo relevant indexed documents were found for this request — say so plainly rather than inventing sources.`
      : '',
  };
}

// ── Working memory ──────────────────────────────────────────────────────────

/**
 * Where memory_core keeps the store. Resolved the same way in every caller so
 * the terminal and the browser cannot read two different files — which has
 * happened before: injection silently read an empty store for weeks after the
 * block was renamed.
 */
function memoryFile(vaultRoot) {
  const root = vaultRoot
    || path.join(__dirname, '..', 'blocks', 'aeon_matrix', 'data', 'Vault');
  return path.join(root, 'Agents', 'Aeon', 'memory', 'memories.json');
}

function readMemories(vaultRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(memoryFile(vaultRoot), 'utf8'));
    return Array.isArray(raw) ? raw : (Array.isArray(raw?.memories) ? raw.memories : []);
  } catch { return []; }
}

/**
 * Assemble the working-memory block for a turn.
 *
 * Ranking and budget accounting belong to memory-policy.cjs; this only reads
 * the store, applies the caller's budget, and formats. `wake` loads everything
 * the budget allows and tells the model it is being woken.
 */
function buildMemoryContext(message, {
  vaultRoot = null,
  budgetTokens = 983,
  skillTokens = 0,
  skills = [],
  wake = false,
  maxCount = 0,
  enabled = true,
  autoMemoryEnabled = false,
  memories = null,
} = {}) {
  if (!enabled) {
    return { text: '', count: 0, considered: 0, dropped: 0, skillsDropped: 0, wake: false, autoMemoryEnabled };
  }

  const all = Array.isArray(memories) ? memories : readMemories(vaultRoot);
  const selection = memoryPolicy.selectForInjection({
    memories: all,
    budgetTokens,
    wake,
    query: message,
    maxCount,
  });

  // Standing procedures the operator approved, capped by count and budget.
  let skillText = '';
  let skillBudget = skillTokens;
  let skillsDropped = 0;
  for (const sk of (Array.isArray(skills) ? skills : [])) {
    const block = `\n### ${sk.title}\n${String(sk.body).slice(0, 1500)}`;
    const cost = estimateTokens(block);
    if (cost > skillBudget) { skillsDropped++; continue; }
    skillText += block;
    skillBudget -= cost;
  }

  let text = selection.text || '';
  if (skillText) text += `\n\n## SKILLS (standing procedures — follow these)${skillText}`;
  if (text && wake) {
    // The count stated here is the count actually INJECTED. The old wake block
    // announced the raw store length and then appended the real numbers two
    // lines later — two contradictory counts in one system prompt, with the
    // model explicitly ordered to state one of them.
    text += `\n\n## WAKE\nThe operator just said the wake phrase. You are VP, AEON's operations agent. `
      + `${selection.injected} of ${selection.considered} stored memories are loaded above`
      + `${selection.dropped ? `; ${selection.dropped} did not fit this turn's budget` : ''}. `
      + `Confirm you are online, state that count, restate the prime directive, and ask for the mission. Do not ask what "VP" means.`;
  }

  if (text) {
    text += `\n\n## MEMORY RULES\n${memoryPolicy.describeMemoryState({
      autoMemoryEnabled,
      injected: selection.injected,
      dropped: selection.dropped,
    })}`;
  }

  return {
    text,
    // memory-policy names this `injected`; it is surfaced as `count` because
    // that is what every caller's meta payload already calls it.
    count: selection.injected,
    considered: selection.considered,
    dropped: selection.dropped,
    skillsDropped,
    wake,
    autoMemoryEnabled,
  };
}

/**
 * Both tiers for one turn, budgeted from one window.
 *
 * The caller supplies the window and its credentials; everything else is
 * policy and lives here. Returns the blocks separately — a caller decides
 * whether memory goes on a system turn and documents on the user turn (which
 * is what the streaming path does) or whether both are concatenated (which is
 * all a single-prompt transport like /api/ai can do).
 */
async function assembleContext(message, {
  auth = null,
  vaultRoot = null,
  contextTokens = 8192,
  wake = false,
  memoryEnabled = true,
  autoMemoryEnabled = false,
  maxCount = 0,
  skills = [],
  memories = null,
  fetchImpl = null,
} = {}) {
  const budgets = inputBudgets(contextTokens, { wake });

  const memory = buildMemoryContext(message, {
    vaultRoot,
    budgetTokens: budgets.memoryTokens,
    skillTokens: budgets.skillTokens,
    skills,
    wake,
    maxCount,
    enabled: memoryEnabled,
    autoMemoryEnabled,
    memories,
  });

  const recall = await buildRecallContext(message, {
    auth,
    budgetTokens: budgets.recallTokens,
    fetchImpl,
  });

  return {
    query: recall.query,
    memory,
    recall,
    budgets,
    // One flat block, for transports that take a single prompt string.
    combined: `${memory.text || ''}${recall.context || ''}`,
    // Everything a caller needs to report what this turn actually consulted.
    meta: {
      memory: memory.count,
      memoryConsidered: memory.considered,
      memoryDropped: memory.dropped,
      skillsDropped: memory.skillsDropped,
      wake: memory.wake,
      autoMemory: memory.autoMemoryEnabled,
      recall: recall.count,
      recallMatched: recall.matched ?? null,
      recallDropped: recall.dropped,
      recallRan: recall.ran,
      recallOk: recall.ok,
      recallForced: recall.forced,
      recallUnavailable: recall.unavailable || null,
      recallError: recall.error || null,
      citations: recall.citations,
    },
  };
}

module.exports = {
  RECALL_PATTERNS,
  COUNTING_RE,
  FORCE_PREFIX,
  FORMATTING,
  WAKE_RE,
  composePrompt,
  isRecallQuery,
  parseRecallInput,
  buildRecallContext,
  buildMemoryContext,
  assembleContext,
  memoryFile,
  // Test seams.
  fitDocuments,
  forwardedAuth,
};
