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
 */
function inputBudgets(contextTokens, opts = {}) {
  const ctx = Math.max(512, Number(contextTokens) || 4096);
  const memoryFraction = opts.memoryFraction ?? (opts.wake ? 0.25 : 0.12);
  const skillFraction = opts.skillFraction ?? (opts.wake ? 0.12 : 0.06);
  return {
    contextTokens: ctx,
    memoryTokens: Math.floor(ctx * memoryFraction),
    skillTokens: Math.floor(ctx * skillFraction),
  };
}

module.exports = { estimateTokens, estimateMessageTokens, detectKind, inputBudgets, CHARS_PER_TOKEN };
