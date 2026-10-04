/**
 * Auto-continue — joining an answer a model had to stop at its output limit.
 *
 * Free OpenRouter models stop at 1,024 output tokens (services/ai.js,
 * OPENROUTER_FREE_MAX_TOKENS), and the operator was typing "continue" by
 * hand, many times per long answer. The turn engine (agentTurn.cjs) asks the
 * model to carry on when, and only when, the provider SAID it stopped for the
 * limit (`truncated: true`); this module words that request and stitches the
 * seam so the operator reads one answer:
 *
 *   - a repeated tail ("...the vault keys" + "the vault keys are kept...")
 *   - a restarted sentence (the last partial sentence written again)
 *   - a preamble ("Continuing: ", "Sure, here is the rest:")
 *
 * The start of a continuation is held back while the seam is decided: at
 * least SEAM_HOLD characters, and longer (up to SEAM_HOLD_MAX) while what is
 * held still repeats text already shown, so a restarted paragraph is matched
 * whole. The rest streams straight through.
 *
 * Known limit: a continuation that repeats the previous part's last line
 * when that part ended exactly at a line break is kept (a checklist or a
 * table can rightly repeat a line; dropping it would lose text).
 *
 * Pure: no I/O. Kernel module.
 */
'use strict';

const DEFAULT_PARTS = 4;
const MAX_PARTS = 8;
const SEAM_HOLD = 200;
const SEAM_HOLD_MAX = 1000;
const SEAM_MIN = 12;
// A restarted sentence or line is tied to a boundary and must match from its
// start, so a short one is still a restart ("The first" written again).
const RESTART_MIN = 4;

const CONTINUE_PROMPT = 'Your previous reply was cut off by the output limit. Continue exactly where it '
  + 'stopped: do not repeat anything already written, do not restart the sentence, no preamble, no summary. '
  + 'If you stopped inside a code block, list or table, continue inside it.';

/** The `auto_continue_parts` setting, clamped to [0, MAX_PARTS]. */
function clampParts(v) {
  const n = Number(v);
  if (v === null || v === undefined || v === '' || !Number.isFinite(n)) return DEFAULT_PARTS;
  return Math.max(0, Math.min(MAX_PARTS, Math.floor(n)));
}

/**
 * How many characters at the start of `head` repeat the end of `prev`
 * (>= min), counting any leading whitespace of `head` that was skipped.
 */
function overlapLength(prev, head, min = SEAM_MIN) {
  const p = String(prev || '');
  // The part ended at a line break: a first line equal to the last one is a
  // new line, not a repeat (see the known limit above).
  if (p.endsWith('\n')) return 0;
  const h0 = String(head || '');
  for (const h of [h0, h0.replace(/^\s+/, '')]) {
    const offset = h0.length - h.length;
    for (let k = Math.min(h.length, p.length); k >= min; k--) {
      if (p.endsWith(h.slice(0, k))) return offset + k;
    }
  }
  return 0;
}

/**
 * The model restarted the sentence or line it was cut off in: `head` begins
 * with the last partial line of `prev` (a list marker included: "1. Open
 * the") or its last partial sentence. Returns how much of `head` to drop.
 */
function restartedLength(prev, head, min = RESTART_MIN) {
  const p = String(prev || '');
  const h0 = String(head || '');
  const h = h0.replace(/^\s+/, '');
  const lineStart = p.lastIndexOf('\n') + 1;
  const candidates = [p.slice(lineStart)];
  let cut = -1;
  const re = /[.!?]\s/g;
  let m;
  while ((m = re.exec(p))) cut = m.index + m[0].length;
  if (cut > lineStart) candidates.push(p.slice(cut));
  let best = 0;
  for (const c of candidates) {
    const partial = c.replace(/^\s+/, '');
    if (partial.length >= min && partial.length > best && h.startsWith(partial)) best = partial.length;
  }
  return best ? (h0.length - h.length) + best : 0;
}

// A preamble is the whole word in brackets, or the whole word followed by its
// own punctuation. "continued by the team" is the answer, not a preamble, and
// is never cut.
const PREAMBLES = [
  /^\s*(?:[([](?:continued|continuing)[)\]]|(?:continued|continuing)\b[ \t]*[:…—–-]+)\s*/i,
  /^\s*(?:sure|okay|ok)[,!.]\s+(?:continuing|here is the rest)[:.]?\s*/i,
  /^\s*(?:continuing|picking up)\s+(?:from\s+)?where\s+(?:I|we)\s+left\s+off\b[ \t]*[:.…—–-]*\s*/i,
  // "Here is the continuation:" — the colon is required: "Here is the rest of
  // the config file you asked for." is an answer.
  /^\s*here(?:'s|’s|\s+is)\s+the\s+(?:continuation|rest)(?:\s+of\s+(?:the|my)\s+(?:answer|reply|response))?[ \t]*:\s*/i,
];

/** `head` without a "Continuing:" style preamble. */
function stripPreamble(head) {
  let h = String(head || '');
  for (const re of PREAMBLES) {
    const m = re.exec(h);
    if (m && m[0].length) h = h.slice(m[0].length);
  }
  return h;
}

/**
 * A seam for one continuation part. `prev` is the visible text it continues.
 * push(t) / end() — calls onText with the stitched text.
 */
function createSeam(prev, { onText = () => {}, hold = SEAM_HOLD, holdMax = SEAM_HOLD_MAX, min = SEAM_MIN } = {}) {
  const tail = String(prev || '').slice(-2 * holdMax);
  // Still a repeat of text already shown: keep holding, the overlap may grow.
  const stillRepeating = () => {
    const h = stripPreamble(buf).replace(/^\s+/, '');
    return h.length > 0 && tail.includes(h);
  };
  let buf = '';
  let decided = false;
  let dropped = 0;
  const decide = () => {
    if (decided) return;
    decided = true;
    const stripped = stripPreamble(buf);
    const cut = Math.max(overlapLength(prev, stripped, min), restartedLength(prev, stripped));
    let out = stripped.slice(cut);
    // "Continuing: thirteen" after "...twelve": the preamble took the space
    // with it, and a model that writes a preamble restarts at a word.
    if (stripped.length !== buf.length && !cut && /\S$/.test(String(prev || '')) && /^[\p{L}\p{N}]/u.test(out)) out = ` ${out}`;
    dropped = buf.length - out.length;
    buf = '';
    if (out) onText(out);
  };
  return {
    push(t) {
      if (!t) return;
      if (decided) { onText(t); return; }
      buf += t;
      if (buf.length >= holdMax || (buf.length >= hold && !stillRepeating())) decide();
    },
    end() { decide(); return { dropped }; },
    dropped: () => dropped,
  };
}

module.exports = {
  CONTINUE_PROMPT, DEFAULT_PARTS, MAX_PARTS, SEAM_HOLD, SEAM_HOLD_MAX, SEAM_MIN, RESTART_MIN,
  clampParts, overlapLength, restartedLength, stripPreamble, createSeam,
};
