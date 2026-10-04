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
 * least SEAM_HOLD characters, and longer while what is held still repeats
 * text already shown, so a restarted paragraph is matched whole. Past
 * SEAM_HOLD_MAX characters the held text is followed through the previous
 * part character by character: a restart that runs on to the end of that
 * part (a model that began its section, or the whole answer, again) is
 * dropped however long it is; one that turns into new text before then is
 * shown as it was written. The rest streams straight through.
 *
 * Known limits: a continuation that repeats the previous part's last line
 * when that part ended exactly at a line break is kept (a checklist or a
 * table can rightly repeat a line; dropping it would lose text). An overlap
 * that is a short repeating pattern ("0 0 0 0 0 0 0") is never trimmed:
 * repetitive data can rightly continue with more of the same, so such a
 * repeat may show twice.
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
      const o = h.slice(0, k);
      if (!p.endsWith(o)) continue;
      // Repetitive data ("0 0 0 0 0 0") can rightly go on with more of the
      // same; trimming it would lose text (see the known limit above).
      if (periodic(o)) return 0;
      return offset + k;
    }
  }
  return 0;
}

// Whether `s` is a shorter pattern repeated at least twice over its length.
function periodic(s) {
  const n = s.length;
  for (let p = 1; p <= n / 2; p++) {
    let i = p;
    while (i < n && s[i] === s[i - p]) i++;
    if (i === n) return true;
  }
  return false;
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
  const whole = String(prev || '');
  const held = () => stripPreamble(buf).replace(/^\s+/, '');
  // Still a repeat of text already shown (anywhere in the previous part):
  // keep holding, the overlap may grow.
  const stillRepeating = () => {
    const h = held();
    return h.length > 0 && whole.includes(h);
  };
  let buf = '';
  let decided = false;
  let dropped = 0;
  // Past holdMax: where in the previous part the held text could still be
  // a repeat of (start offsets), followed as more arrives.
  let offsets = null;
  let matched = 0; // how much of the held text is known to match at every offset
  const track = () => {
    const h = held();
    const lead = buf.length - h.length;
    for (const o of offsets) {
      const rest = whole.length - o;
      if (h.length >= rest && h.slice(matched, rest) === whole.slice(o + matched)) {
        // The repeat ran on to the end of the previous part: drop it all.
        decided = true;
        dropped = lead + rest;
        const out = h.slice(rest);
        buf = '';
        if (out) onText(out);
        return;
      }
    }
    const more = h.slice(matched);
    offsets = offsets.filter((o) => whole.startsWith(more, o + matched));
    matched = h.length;
    if (!offsets.length) decide();
  };
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
      if (offsets) { track(); return; }
      if (buf.length >= hold && !stillRepeating()) { decide(); return; }
      if (buf.length >= holdMax) {
        const h = held();
        offsets = [];
        for (let i = whole.indexOf(h); i !== -1; i = whole.indexOf(h, i + 1)) offsets.push(i);
        matched = 0;
        track();
      }
    },
    end() {
      // Still following a repeat when the part ended (cut again before it
      // reached the end of the previous part): all of it was shown already.
      if (!decided && offsets && offsets.length) { decided = true; dropped = buf.length; buf = ''; }
      decide();
      return { dropped };
    },
    dropped: () => dropped,
  };
}

module.exports = {
  CONTINUE_PROMPT, DEFAULT_PARTS, MAX_PARTS, SEAM_HOLD, SEAM_HOLD_MAX, SEAM_MIN, RESTART_MIN,
  clampParts, overlapLength, restartedLength, stripPreamble, createSeam,
};
