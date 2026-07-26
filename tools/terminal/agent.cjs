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
const OBSERVATION_LIMIT = 700;    // chars of the MOST RECENT result fed back
const OLD_OBSERVATION_LIMIT = 120; // older steps collapse to a one-liner
// How many commands to show per step. The full registry is 33 commands and
// ~675 tokens — 72% of a first-step prompt — and re-sending it every step is
// what makes a free tier or a slow local model unusable for real work. The
// relevant subset is picked deterministically (no model call), and the model
// can ask for everything with {"action":"list"} if the subset is wrong.
const CATALOGUE_LIMIT = Number(process.env.AEON_AGENT_CATALOGUE) || 12;
const AGENT_ROLE = process.env.AEON_AGENT_ROLE || 'agent_worker';
// A 14B model on CPU-only inference (this machine's GTX 1050 lost CUDA
// support in Ollama 0.32.4) answers a catalogue-sized prompt in minutes, not
// seconds. Overridable so a fast cloud model isn't held to a slow default.
const MODEL_TIMEOUT = Number(process.env.AEON_AGENT_TIMEOUT_MS) || 180000;

/** Keep the model's view of a result small but honest. */
function summarizeObservation(res, limit = OBSERVATION_LIMIT) {
  if (!res) return 'no response';
  if (!res.ok) {
    const err = res.data?.error || res.data?.text || `failed (${res.status})`;
    return `ERROR: ${String(err).slice(0, limit)}`;
  }
  const payload = res.data || {};
  const text = payload.text;
  const data = payload.data;
  let body;
  if (text) body = String(text);
  else if (data && typeof data === 'object') body = JSON.stringify(data);
  else body = JSON.stringify(payload);
  if (body.length > limit) {
    body = body.slice(0, limit) + ` …[truncated, ${body.length} chars total]`;
  }
  return body;
}

/**
 * Pick the commands worth showing this step. Deterministic and free — no model
 * call — using the router's own word-overlap scorer.
 *
 * Guarantees, so the filter is never a wall:
 *   • anything already used this run stays visible (continuity)
 *   • if scoring finds nothing, fall back to the full list rather than
 *     showing the model an empty menu
 *   • the model can always request everything with {"action":"list"}
 */
function pickRelevant(goal, commands, history = [], limit = CATALOGUE_LIMIT) {
  if (commands.length <= limit) return commands;

  const usedIds = new Set(history.map((h) => h.id));
  const used = commands.filter((c) => usedIds.has(c.id));

  let ranked = [];
  try { ranked = require('./router.cjs').suggest(goal, commands, limit * 2); }
  catch { ranked = []; }

  const picked = [];
  const seen = new Set();
  for (const c of [...used, ...ranked]) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    picked.push(c);
    if (picked.length >= limit) break;
  }
  // Nothing scored — the goal shares no vocabulary with any command. Showing
  // a truncated arbitrary slice would be worse than showing everything.
  return picked.length ? picked : commands;
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

function buildPrompt(goal, commands, history, { hiddenCount = 0 } = {}) {
  // Only the most recent result is carried in full — that is the one the next
  // decision actually depends on. Older steps collapse to a single line. Without
  // this the transcript grows without bound and dominates the prompt by step 4.
  const last = history.length - 1;
  const transcript = history.length
    ? history.map((h, i) => (i === last
        ? `STEP ${i + 1}: ran ${h.id}${h.argText ? ` (${h.argText})` : ''}\nRESULT: ${h.observation}`
        : `STEP ${i + 1}: ran ${h.id}${h.argText ? ` (${h.argText})` : ''} → ${h.ok === false ? 'FAILED' : 'ok'}: ${String(h.observation).slice(0, OLD_OBSERVATION_LIMIT)}`
      )).join('\n')
    : '(nothing yet — this is the first step)';

  const more = hiddenCount
    ? `\n(${hiddenCount} further commands exist but were filtered as unrelated. If none of the above fit, reply {"action":"list"} to see all of them.)`
    : '';

  return `You operate AEON, a local AI operating system, by calling its registered commands one at a time.

COMMANDS YOU MAY CALL (id | argument shape | description):
${buildCatalogue(commands)}${more}

THE USER'S GOAL: "${goal}"

WHAT HAS HAPPENED SO FAR:
${transcript}

Decide the SINGLE next step. Reply with ONLY a JSON object, no prose, no code fence:

{"action":"run","id":"<exact id>","arg":"<text argument, or empty>","body":{},"why":"<short reason>","final":false}
{"action":"done","summary":"<what was accomplished, in plain English for a non-technical user>"}
{"action":"ask","question":"<what you need from the user to continue>"}

Rules:
- "id" MUST be copied exactly from the list above. Never invent one.
- Use "body" ONLY for commands whose shape shows body:{...}; fill those exact keys. Otherwise use "arg".
- Set "final":true when this command is the LAST one needed — then also include "summary". This saves a whole round trip, so use it whenever you can.
- If the goal is ALREADY met by what has happened, reply with "done".
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
      // Usually means the cloud provider just rate-limited us mid-run and the
      // kernel fell back to the local model, which needs an explicit operator
      // OK. Name the exact unblock rather than describing it vaguely.
      throw new Error('cloud providers are unavailable (often a rate limit) and the local model needs your OK first.\n'
        + '    Approve it for this session:  curl -X POST http://127.0.0.1:3001/api/system/allow-local\n'
        + '    or type /allow-local in the AEON terminal, then retry.');
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
  catalogueLimit = CATALOGUE_LIMIT,
} = {}) {
  const { commands } = await getCommands();
  if (!commands.length) throw new Error('no commands available — is the server running?');

  const history = [];
  // Rough token accounting so the cost of a run is visible rather than
  // guessed at. ~4 chars/token is close enough to compare runs and to tell a
  // user whether a free tier will carry them through a day's work.
  const usage = { calls: 0, promptChars: 0, get estPromptTokens() { return Math.ceil(this.promptChars / 4); } };
  let showAll = false;   // flipped by {"action":"list"} — once, on demand

  for (let step = 1; step <= maxSteps; step++) {
    const visible = showAll ? commands : pickRelevant(goal, commands, history, catalogueLimit);
    const prompt = buildPrompt(goal, visible, history, { hiddenCount: commands.length - visible.length });
    usage.calls++;
    usage.promptChars += prompt.length;

    const spin = json ? { stop() {} } : render.spinner(`thinking (step ${step}/${maxSteps})`);
    let decision;
    try { decision = await ask(prompt); }
    finally { spin.stop(); }

    // The filtered menu did not contain what it needed — show everything on
    // the next pass. Costs one call, and only ever happens once per run.
    if (decision.action === 'list') {
      if (!showAll) { showAll = true; continue; }
      return { ok: false, steps: history, reason: 'unparseable-decision', decision, usage };
    }

    if (decision.action === 'done') {
      const summary = decision.summary || 'done';
      if (!json) log(`\n  ${c.green('✓')} ${summary}\n`);
      return { ok: true, steps: history, summary, usage };
    }

    if (decision.action === 'ask') {
      const question = decision.question || 'more information needed';
      if (!json) log(`\n  ${c.yellow('?')} ${question}\n`);
      return { ok: false, steps: history, reason: 'needs-input', question, usage };
    }

    if (decision.action !== 'run' || !decision.id) {
      return { ok: false, steps: history, reason: 'unparseable-decision', decision, usage };
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
        return { ok: false, steps: history, reason: 'declined', at: spec.id, usage };
      }
      res = await dispatch(spec.id, argText, { body, confirmed: true, timeout: 180000 });
    }

    const observation = summarizeObservation(res);
    history.push({ id: spec.id, argText: shown, observation, ok: !!res.ok });
    if (!json) log(`     ${res.ok ? c.dim('→ ' + observation.slice(0, 160)) : c.red('→ ' + observation.slice(0, 160))}`);

    // The model flagged this as the last step it needed. Believe it ONLY if
    // the command actually succeeded — otherwise keep going so it can react to
    // the failure. Saves a whole round trip, which on a free tier is a third
    // of the requests for a typical two-action goal.
    if (decision.final === true && res.ok) {
      const summary = decision.summary || `Completed: ${goal}`;
      if (!json) log(`\n  ${c.green('✓')} ${summary}\n`);
      return { ok: true, steps: history, summary, usage, finalizedEarly: true };
    }
  }

  return { ok: false, steps: history, reason: 'step-limit', summary: `stopped after ${maxSteps} steps`, usage };
}

module.exports = {
  run, summarizeObservation, buildPrompt, buildCatalogue, pickRelevant,
  DEFAULT_MAX_STEPS, CATALOGUE_LIMIT,
};
