/**
 * Context budget — one unit, and arithmetic instead of constants.
 *
 * BO-D1a and D1f. Before this module three separate numbers decided how long
 * an answer could be, none of them aware of the others:
 *
 *   max_tokens        hardcoded 512 in both inference paths
 *   wall-clock        180s, which capped real output at ~750 tokens
 *   n_ctx             clamped to 8192 against a 131,072 model ceiling
 *
 * and two more decided what got INTO the context, counted in characters
 * against a window measured in tokens:
 *
 *   memory            CHAR_BUDGET 4500 / 10000
 *   skills            2500 / 5000
 *
 * A context window is a single pot. Input and output share it. Every number
 * above has to be denominated in the same unit and subtracted from the same
 * total, or they cannot be reconciled at all — which is why the operator saw
 * every long answer stop at 701, 730, 743 tokens and no setting changed it.
 *
 * WHY THE MARGIN IS NOT TIMIDITY
 * On overflow llama.cpp evicts from the FRONT of the context. The front is
 * exactly where the system prompt and the MEMORY block live. Overflow does
 * not error — it silently deletes the operator's pinned memory and the reply
 * just quietly gets worse. The margin buys the one thing we must not lose.
 */

// Characters per token. Prose averages ~4; code is denser in punctuation and
// identifiers and runs closer to 2.5. The same 4,500-character block is 1,100
// tokens of prose or 1,800 of code, and nothing reconciled that before.
const CHARS_PER_TOKEN = { prose: 4, code: 2.5, mixed: 3.2 };

// Reserved at the front of the window for the system prompt and the MEMORY
// block — the region llama.cpp evicts first.
const DEFAULT_MARGIN_TOKENS = 512;

// A normal turn should not silently commit the whole window to one answer.
// `long: true` releases the remainder for the cases that genuinely need it.
const DEFAULT_OUTPUT_CAP = 10_000;

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

/** Cheap heuristic — code is punctuation-dense and line-broken. */
function detectKind(s) {
  const sample = s.slice(0, 4000);
  const symbols = (sample.match(/[{}()[\];=<>|&/\\_$#]/g) || []).length;
  const ratio = symbols / Math.max(1, sample.length);
  if (ratio > 0.06) return 'code';
  if (ratio > 0.03) return 'mixed';
  return 'prose';
}

/** Tokens in a chat `messages` array, including per-message framing overhead. */
function estimateMessageTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  // ~4 tokens per message of role/delimiter framing, per the OpenAI-format
  // convention llama-server's /v1/chat/completions follows.
  return messages.reduce((n, m) => n + estimateTokens(m?.content || '') + 4, 0);
}

/**
 * How many output tokens may this turn have?
 *
 *   max_tokens = n_ctx - prompt_tokens - margin
 *
 * capped at `cap` unless `long` is set, in which case the full remainder is
 * released. Never returns less than `floor` — if the arithmetic says there is
 * no room, that is a prompt problem to report, not a zero-length answer to
 * emit silently.
 *
 * @param {object} opts
 * @param {number} opts.contextTokens   the live window (n_ctx)
 * @param {number} opts.promptTokens    everything going in
 * @param {number} [opts.margin]
 * @param {boolean} [opts.long]         release the cap
 * @param {number} [opts.cap]
 * @param {number} [opts.requested]     an explicit caller ceiling
 * @returns {{maxTokens:number, remainder:number, limitedBy:string, fits:boolean, reason:string}}
 */
function outputBudget(opts = {}) {
  const ctx = Math.max(512, Number(opts.contextTokens) || 4096);
  const prompt = Math.max(0, Number(opts.promptTokens) || 0);
  const margin = opts.margin ?? DEFAULT_MARGIN_TOKENS;
  const cap = opts.cap ?? DEFAULT_OUTPUT_CAP;
  const floor = opts.floor ?? 256;

  const remainder = ctx - prompt - margin;

  if (remainder < floor) {
    return {
      maxTokens: Math.max(0, remainder),
      remainder,
      fits: false,
      limitedBy: 'context',
      reason: `The prompt uses ${prompt.toLocaleString()} of a ${ctx.toLocaleString()}-token window, `
        + `leaving ${Math.max(0, remainder).toLocaleString()} for the answer. `
        + `Shorten the input, or serve this model with a larger context.`,
    };
  }

  let maxTokens = remainder;
  let limitedBy = 'context';

  if (!opts.long && remainder > cap) {
    maxTokens = cap;
    limitedBy = 'cap';
  }
  if (opts.requested && opts.requested < maxTokens) {
    maxTokens = Math.max(floor, Number(opts.requested));
    limitedBy = 'requested';
  }

  return {
    maxTokens,
    remainder,
    fits: true,
    limitedBy,
    reason: limitedBy === 'cap'
      ? `Capped at ${cap.toLocaleString()} tokens; ${remainder.toLocaleString()} were available. Use long mode to release the rest.`
      : `${maxTokens.toLocaleString()} tokens available after a ${prompt.toLocaleString()}-token prompt and a ${margin}-token margin.`,
  };
}

/**
 * Split the INPUT side of the window between memory and skills, in tokens.
 *
 * D1f. These were fixed character counts that knew nothing about the window
 * they were spending from — identical on an 8k window and a 32k one.
 * Expressed as fractions, they scale with whatever the machine can serve.
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

module.exports = {
  estimateTokens,
  estimateMessageTokens,
  outputBudget,
  inputBudgets,
  detectKind,
  CHARS_PER_TOKEN,
  DEFAULT_MARGIN_TOKENS,
  DEFAULT_OUTPUT_CAP,
};
