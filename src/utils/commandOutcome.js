/**
 * One command, one outcome.
 *
 * BO-D2c. A dangerous command produced TWO process lines for one action:
 *
 *   [0007] CMD /model-pull … (awaiting approval)   EXIT 0    <- green
 *   [0008] CMD /model-pull …                       EXIT 1    <- red
 *
 * The confirmation gate answers 428, and the terminal marked that chip
 * `ok` — which the renderer draws as a completed, successful run — then
 * started a fresh chip when the operator approved. So a command that failed
 * showed green above red, and a command still WAITING on a human showed as
 * finished. Both are §08: the screen asserted an outcome the system had not
 * reached.
 *
 * A challenge is not a result. It is a state the same run passes through,
 * and it resolves in place.
 *
 * WHY THIS IS A PURE FUNCTION AND NOT AN `if` IN THE COMPONENT
 * Terminal2 is the operator's primary interface (§05) and it has no DOM
 * test. A decision table inside it cannot be driven by a gate, so it rots —
 * which is exactly how the double-log survived. Same reasoning, and the same
 * shape, as src/utils/interceptorPolicy.js.
 *
 * WHY IT TAKES THE HTTP STATUS RATHER THAN A FLAG
 * The confirmation gate is currently trusted on a bare `confirmed:true` in
 * the request body, with no server-side proof that a 428 was ever issued
 * (a design note standing since 2026-07-26). When that is replaced by a
 * request-bound receipt, the server's answer changes shape and this function
 * changes with it — the terminal keeps rendering "whatever the dispatcher
 * said" and needs no unpicking. That was an explicit constraint on D2c.
 */

/**
 * Chip lifecycle states. `pending` and `denied` are NOT failures and must
 * never render as EXIT 1 — one is waiting on a person, the other is a person
 * having answered.
 */
export const CHIP_STATUS = {
  RUNNING: 'running',
  PENDING: 'pending',
  OK: 'ok',
  FAIL: 'fail',
  DENIED: 'denied',
};

/** Does this state mean the run finished? Only these two carry an exit code. */
export function isTerminalStatus(status) {
  return status === CHIP_STATUS.OK || status === CHIP_STATUS.FAIL;
}

/**
 * What should the terminal do with a dispatch response?
 *
 * @param {object} res  { status, data }
 * @returns {{kind, chipStatus, prompt?, output?, text?, expand}}
 */
export function describeDispatchOutcome({ status, data } = {}) {
  const body = data || {};

  // 428 — the dispatcher is asking a human. Nothing has run.
  if (status === 428 && body.requiresConfirmation) {
    return {
      kind: 'challenge',
      chipStatus: CHIP_STATUS.PENDING,
      prompt: body.prompt || 'Confirm to execute.',
      expand: false,
    };
  }

  if (body.ok) {
    return {
      kind: 'ok',
      chipStatus: CHIP_STATUS.OK,
      text: typeof body.text === 'string' && body.text.trim() ? body.text : null,
      expand: false,
    };
  }

  return {
    kind: 'fail',
    chipStatus: CHIP_STATUS.FAIL,
    // A failure is worth opening; a success is not.
    expand: true,
    error: body.error || null,
  };
}

/**
 * What should the chip actually SHOW?
 *
 * BO-D2d. The old expression was:
 *
 *   data.text || (data.data ? '```json…```' : data.error || '(empty)')
 *
 * which produced, on real commands:
 *
 *   /docs    → ```json\n[]\n```          a code block containing nothing
 *   /upload  → ```json\n{"empty":true}``` the word "empty" as JSON
 *   /scan    → (empty)                    while data.logs held the real answer
 *
 * Empty is a legitimate answer and should read as one. A raw JSON dump of an
 * empty container is the machine's internal state pasted onto the screen, and
 * "(empty)" for a command that returned several log lines is simply wrong —
 * /scan answers {ok:true, text:null, data:{logs:[…]}}, and the old expression
 * checked `data.text` first, found null, then rendered `data` as JSON only if
 * truthy… which it was, so /scan actually printed its logs as JSON. The
 * commands that printed "(empty)" were the ones with no `data` at all.
 *
 * Either way the operator got machine shape instead of an answer.
 */
export function describeCommandOutput(data) {
  const body = data || {};

  if (typeof body.text === 'string' && body.text.trim()) return body.text;

  // A logs array is prose the command already wrote for a human.
  const logs = body.data?.logs ?? body.logs;
  if (Array.isArray(logs) && logs.length) return logs.join('\n');

  const payload = body.data;

  if (Array.isArray(payload)) {
    return payload.length
      ? '```json\n' + JSON.stringify(payload, null, 2) + '\n```'
      : 'Nothing to show — the command ran and found no entries.';
  }

  if (payload && typeof payload === 'object') {
    // {empty:true} and {} are both "it worked, there is nothing here".
    const keys = Object.keys(payload);
    const onlyEmptyFlag = keys.length === 1 && keys[0] === 'empty' && payload.empty === true;
    if (!keys.length || onlyEmptyFlag) {
      return 'Nothing to show — the command ran and found no entries.';
    }
    return '```json\n' + JSON.stringify(payload, null, 2) + '\n```';
  }

  if (typeof body.error === 'string' && body.error.trim()) return body.error;

  // Nothing at all came back. Say that, rather than "(empty)", which reads
  // like a value the command returned.
  return body.ok
    ? 'Done — the command reported success and returned no output.'
    : 'The command returned no output and did not say why.';
}

/**
 * The operator answered the challenge with "no".
 *
 * Denial is an outcome the operator chose, not an error the system hit. It
 * previously rewrote the confirmation card into a plain system message and
 * left the original chip sitting on "awaiting approval" forever.
 */
export function describeDenial(command) {
  return {
    kind: 'denied',
    chipStatus: CHIP_STATUS.DENIED,
    output: `Denied by operator — ${command} was not run.`,
    expand: false,
  };
}
