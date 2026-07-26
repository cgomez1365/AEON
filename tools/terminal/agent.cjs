/**
 * AEON Terminal — agentic loop (multi-step).
 *
 * One utterance → many steps. `aeon "grade this resume"` routes to exactly one
 * command and stops; this loop keeps going: the model proposes ONE command at
 * a time from the live registry, the loop dispatches it through the SAME
 * kernel command bus every other path uses, feeds the real result back, and
 * asks again until the goal is met or the step cap is hit.
 *
 * What it deliberately is NOT: a code-execution agent. It can only invoke
 * commands the block manifests already declare, so the blast radius is exactly
 * the command registry — no shell, no arbitrary routes, no filesystem access
 * beyond what a block already exposes. Three properties hold it in place:
 *
 *   1. A proposed command id must exist in the registry or the step is
 *      refused locally — a hallucinated route never reaches the kernel.
 *   2. Dangerous commands still return 428 from the dispatcher and the human
 *      is asked, per step. --yes pre-confirms; it does not remove the gate.
 *   3. Observations fed back to the model are truncated. An overnight loop
 *      that appends every full result will exhaust context (and, on a
 *      portable install running an 8B model off a USB stick, RAM) long
 *      before it finishes.
 *
 * The model is whichever provider/model the operator assigned to the
 * `agent_worker` role in Settings — "the AI you get to set".
 */
'use strict';

const client = require('./client.cjs');
const render = require('./renderers.cjs');
const { c } = client;

const DEFAULT_MAX_STEPS = 8;
const OBSERVATION_LIMIT = 1200;   // chars of any single result fed back
const AGENT_ROLE = process.env.AEON_AGENT_ROLE || 'agent_worker';
// A 14B model on CPU-only inference (this machine's GTX 1050 lost CUDA
// support in Ollama 0.32.4) answers a catalogue-sized prompt in minutes, not
// seconds. Overridable so a fast cloud model isn't held to a slow default.
const MODEL_TIMEOUT = Number(process.env.AEON_AGENT_TIMEOUT_MS) || 180000;

/** Keep the model's view of a result small but honest. */
function summarizeObservation(res) {
  if (!res) return 'no response';
  if (!res.ok) {
    const err = res.data?.error || res.data?.text || `failed (${res.status})`;
    return `ERROR: ${String(err).slice(0, OBSERVATION_LIMIT)}`;
  }
  const payload = res.data || {};
  const text = payload.text;
  const data = payload.data;
  let body;
  if (text) body = String(text);
  else if (data && typeof data === 'object') body = JSON.stringify(data);
  else body = JSON.stringify(payload);
  if (body.length > OBSERVATION_LIMIT) {
    body = body.slice(0, OBSERVATION_LIMIT) + ` …[truncated, ${body.length} chars total]`;
  }
  return body;
}

function buildCatalogue(commands) {
  return commands
    .filter((s) => s.available !== false)
    .map((s) => {
      const shape = s.params ? `body:{${s.params.join(', ')}}` : s.param ? `arg:<${s.param}>` : 'arg:<text|none>';
      return `${s.id} | ${shape}${s.dangerous ? ' | DANGEROUS(asks first)' : ''} | ${s.title || s.desc || s.cmd}`;
    })
    .join('\n');
}

function buildPrompt(goal, commands, history) {
  const transcript = history.length
    ? history.map((h, i) => `STEP ${i + 1}: ran ${h.id}${h.argText ? ` (${h.argText})` : ''}\nRESULT: ${h.observation}`).join('\n\n')
    : '(nothing yet — this is the first step)';

  return `You operate AEON, a local AI operating system, by calling its registered commands one at a time.

COMMANDS YOU MAY CALL (id | argument shape | description):
${buildCatalogue(commands)}

THE USER'S GOAL: "${goal}"

WHAT HAS HAPPENED SO FAR:
${transcript}

Decide the SINGLE next step. Reply with ONLY a JSON object, no prose, no code fence:

{"action":"run","id":"<exact id from the list>","arg":"<text argument, or empty>","body":{},"why":"<short reason>"}
{"action":"done","summary":"<what was accomplished, in plain English for a non-technical user>"}
{"action":"ask","question":"<what you need from the user to continue>"}

Rules:
- "id" MUST be copied exactly from the list above. Never invent one.
- Use "body" ONLY for commands whose shape shows body:{...}; fill those exact keys. Otherwise use "arg".
- If the goal is already met by what has happened, reply with "done".
- If you cannot proceed without information only the user has, reply with "ask".
- Prefer the fewest steps. Do not repeat a step that already succeeded.`;
}

async function askModel(prompt) {
  // POST /api/ai — { prompt, role } → { text }. (Mounted at /api/ai in
  // server.js, with a legacy alias at /api/kernel/llm.)
  const res = await client.request('POST', '/api/ai', {
    role: AGENT_ROLE,
    prompt,
  }, { timeout: MODEL_TIMEOUT });

  if (!res.ok) {
    // 409 needsLocalConfirm: the kernel wants the operator to okay spinning up
    // a local model. Say that plainly instead of reporting it as a failure.
    if (res.status === 409 && res.data?.needsLocalConfirm) {
      throw new Error('the local model needs to be confirmed before first use — run any single command that uses it once, then retry.');
    }
    const why = res.data?.error || `HTTP ${res.status}`;
    throw new Error(`the ${AGENT_ROLE} model did not answer (${why}). Set one with: aeon run settings.set "set ${AGENT_ROLE} to <provider> <model>"`);
  }
  const d = res.data || {};
  const raw = d.text ?? d.answer ?? d.content ?? d.message ?? d.response ?? '';
  // Same extractor the NL router uses — models fence and pad JSON regardless
  // of instructions, and a small local model does it more.
  const parsed = require('./router.cjs').extractJson(typeof raw === 'string' ? raw : JSON.stringify(raw));
  if (!parsed) throw new Error(`could not parse a decision from the model. It said: ${String(raw).slice(0, 200)}`);
  return parsed;
}

/**
 * Run the loop. Returns { ok, steps, summary, reason }.
 *
 * `confirm` is injected so the REPL, the one-shot CLI and tests can each
 * decide how a 428 is answered without this module owning a prompt. `ask` and
 * `dispatch` are injected for the same reason — it lets the loop's control
 * flow be tested deterministically instead of against a live model whose
 * latency and phrasing vary run to run.
 */
async function run(goal, {
  maxSteps = DEFAULT_MAX_STEPS,
  yes = false,
  json = false,
  confirm = null,
  log = console.log,
  ask = askModel,
  dispatch = client.dispatch,
  getCommands = client.getCommands,
} = {}) {
  const { commands } = await getCommands();
  if (!commands.length) throw new Error('no commands available — is the server running?');

  const history = [];

  for (let step = 1; step <= maxSteps; step++) {
    const spin = json ? { stop() {} } : render.spinner(`thinking (step ${step}/${maxSteps})`);
    let decision;
    try { decision = await ask(buildPrompt(goal, commands, history)); }
    finally { spin.stop(); }

    if (decision.action === 'done') {
      const summary = decision.summary || 'done';
      if (!json) log(`\n  ${c.green('✓')} ${summary}\n`);
      return { ok: true, steps: history, summary };
    }

    if (decision.action === 'ask') {
      const question = decision.question || 'more information needed';
      if (!json) log(`\n  ${c.yellow('?')} ${question}\n`);
      return { ok: false, steps: history, reason: 'needs-input', question };
    }

    if (decision.action !== 'run' || !decision.id) {
      return { ok: false, steps: history, reason: 'unparseable-decision', decision };
    }

    // A hallucinated id never reaches the kernel. Feed the refusal back so the
    // model can correct itself rather than dying on one bad guess.
    const spec = commands.find((s) => s.id === decision.id)
      || commands.find((s) => s.cmd === decision.id);
    if (!spec) {
      history.push({
        id: String(decision.id),
        argText: '',
        observation: `ERROR: "${decision.id}" is not a real command. Choose an id exactly as written in the list.`,
      });
      continue;
    }

    const body = decision.body && typeof decision.body === 'object' && Object.keys(decision.body).length
      ? decision.body : null;
    const argText = typeof decision.arg === 'string' ? decision.arg : '';
    const shown = body ? Object.entries(body).map(([k, v]) => `${k}=${String(v).slice(0, 40)}`).join(', ') : argText;

    if (!json) {
      log(`  ${c.dim(`${step}.`)} ${c.neon(spec.cmd)} ${c.dim(shown || '')}${decision.why ? c.dim(`  — ${decision.why}`) : ''}`);
    }

    let res = await dispatch(spec.id, argText, { body, timeout: 180000 });

    // The confirmation gate is the kernel's, per step, every step.
    if (res.status === 428 && res.data?.requiresConfirmation) {
      let approved = yes;
      if (!approved && confirm) approved = await confirm(res.data.prompt);
      if (!approved) {
        return { ok: false, steps: history, reason: 'declined', at: spec.id };
      }
      res = await dispatch(spec.id, argText, { body, confirmed: true, timeout: 180000 });
    }

    const observation = summarizeObservation(res);
    history.push({ id: spec.id, argText: shown, observation, ok: !!res.ok });
    if (!json) log(`     ${res.ok ? c.dim('→ ' + observation.slice(0, 160)) : c.red('→ ' + observation.slice(0, 160))}`);
  }

  return { ok: false, steps: history, reason: 'step-limit', summary: `stopped after ${maxSteps} steps` };
}

module.exports = { run, summarizeObservation, buildPrompt, buildCatalogue, DEFAULT_MAX_STEPS };
