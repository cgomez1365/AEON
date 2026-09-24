/**
 * The token — AEON's unit of account for anything that shares a context window.
 *
 * This lives in the KERNEL, not in services/, because blocks depend on it and
 * a block may only reach into the kernel. The empty-shell test states the
 * contract in its own header: "THE SHELL IS kernel + node_modules. BLOCKS ARE
 * ONLY the folders." A block that requires services/ cannot be dropped into a
 * bare shell and served — it mounts, then 404s, because its require threw.
 *
 * D1f established that memory, skills and output budgets must be denominated
 * in one unit. This is that unit, defined once. services/local-runtime's
 * budget engine consumes it, and so do the blocks — nobody re-implements it,
 * because two estimators disagreeing is how a budget silently overruns and
 * evicts the system prompt.
 */

// Characters per token. Prose averages ~4; code is denser in punctuation and
// identifiers and runs closer to 2.5. The same 4,500-character block is 1,100
// tokens of prose or 1,800 of code, and nothing reconciled that before D1f.
const CHARS_PER_TOKEN = { prose: 4, code: 2.5, mixed: 3.2 };

/** Cheap heuristic — code is punctuation-dense and line-broken. */
function detectKind(s) {
  const sample = String(s || '').slice(0, 4000);
  const symbols = (sample.match(/[{}()[\];=<>|&/\\_$#]/g) || []).length;
  const ratio = symbols / Math.max(1, sample.length);
  if (ratio > 0.06) return 'code';
  if (ratio > 0.03) return 'mixed';
  return 'prose';
}

/**
 * Estimate tokens in a string. Deliberately an over-estimate: budgeting is
 * the one place where guessing low costs you the system prompt.
 *
 * @param {string} text
 * @param {object} [opts] { kind: 'prose'|'code'|'mixed' }
 */
function estimateTokens(text, opts = {}) {
  const s = typeof text === 'string' ? text : String(text ?? '');
  if (!s) return 0;
  const kind = opts.kind || detectKind(s);
  return Math.ceil(s.length / CHARS_PER_TOKEN[kind]);
}

/** Tokens in a chat `messages` array, including per-message framing overhead. */
function estimateMessageTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  // ~4 tokens per message of role/delimiter framing, per the OpenAI-format
  // convention llama-server's /v1/chat/completions follows.
  return messages.reduce((n, m) => n + estimateTokens(m?.content || '') + 4, 0);
}

/**
 * Split the INPUT side of a context window between memory and skills.
 *
 * D1f. These were fixed character counts that knew nothing about the window
 * they were spending from — identical on an 8k window and a 32k one.
 * Expressed as fractions, they scale with whatever the machine can serve.
 *
 * Lives here rather than with the local-runtime budget engine because blocks
 * need it and a block may only reach into the kernel. Dividing a window is
 * arithmetic on the unit; it has nothing to do with llama.cpp.
 *
 * THE CAPS BELOW EXIST BECAUSE A FRACTION ALONE STOPS MAKING SENSE AT SCALE.
 *
 * While describeRole() reported a flat 8k for every cloud model these were
 * small numbers and the fractions were the whole story. Once it started
 * reporting the truth — and a free OpenRouter model turned out to serve a
 * million tokens — 25% of the window became 250,000 tokens of retrieved
 * documents injected into one turn.
 *
 * Nothing about that is an improvement. Attention does not scale with the
 * window: a model reads the middle of an enormous prompt poorly, whatever its
 * advertised size. Neither does latency, and a free tier meets its rate limit
 * long before it meets its context limit. The window says what CAN be sent;
 * it was never an argument for sending it.
 *
 * So the fraction still governs small windows, where it is the right answer,
 * and an absolute ceiling governs large ones. The ceilings are deliberately
 * far above real use — the operator's entire memory core is about 5,400
 * tokens, so a 32,000-token memory cap is six times everything they have —
 * and they only bind above roughly a 266k window. No local model and no
 * modest cloud one ever reaches them, so nothing that worked before changes.
 */
const MAX_MEMORY_TOKENS = 32_000;
const MAX_SKILL_TOKENS = 8_000;
const MAX_RECALL_TOKENS = 32_000;
function inputBudgets(contextTokens, opts = {}) {
  const ctx = Math.max(512, Number(contextTokens) || 4096);
  const memoryFraction = opts.memoryFraction ?? (opts.wake ? 0.25 : 0.12);
  const skillFraction = opts.skillFraction ?? (opts.wake ? 0.12 : 0.06);
  // BO-MEM. Retrieved documents were the ONLY context block outside this
  // split: up to 5 documents x 2000 chars lands ~2,500-4,000 tokens on the
  // user turn, unbudgeted and uncounted — as much as four times the memory
  // budget, in the same window, with no eviction accounting. A budget that
  // does not cover the largest consumer is not a budget.
  //
  // Recall gets the largest share because a cited document is the thing that
  // makes an answer checkable, and it is deliberately NOT raised by `wake`:
  // wake is about loading who the operator is, not about searching harder.
  const recallFraction = opts.recallFraction ?? 0.25;
  return {
    contextTokens: ctx,
    memoryTokens: Math.min(Math.floor(ctx * memoryFraction), opts.maxMemoryTokens ?? MAX_MEMORY_TOKENS),
    skillTokens: Math.min(Math.floor(ctx * skillFraction), opts.maxSkillTokens ?? MAX_SKILL_TOKENS),
    recallTokens: Math.min(Math.floor(ctx * recallFraction), opts.maxRecallTokens ?? MAX_RECALL_TOKENS),
  };
}

module.exports = {
  estimateTokens, estimateMessageTokens, detectKind, inputBudgets, CHARS_PER_TOKEN,
  MAX_MEMORY_TOKENS, MAX_SKILL_TOKENS, MAX_RECALL_TOKENS,
};
