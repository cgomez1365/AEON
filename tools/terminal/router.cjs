/**
 * AEON Terminal — natural-language router (BO-TGM)
 *
 * Resolves free text to a registered command. Two tiers, in order:
 *
 *   1. Fast match  — deterministic. Exact /command, then block-qualified
 *                    forms, then intent keywords scored against the live
 *                    registry. No model call, no latency, no token spend.
 *   2. LLM route   — only when the fast tier is genuinely unsure. The model
 *                    picks from the registry; it never invents a route.
 *
 * The ordering is the whole design. Most terminal input is unambiguous, and
 * spending a model call to discover that "/gpu" means /gpu is waste — on a
 * portable install it is also latency against a 8B model running off a USB
 * stick. The LLM is the fallback, not the front door.
 */
'use strict';

const { request, ping } = require('./client.cjs');

// Intent keywords → the block that owns them. Scored, not first-match, so
// "search my files" resolves on the strongest signal rather than word order.
const INTENTS = [
  { block: 'resume_grader', terms: ['grade', 'resume', 'cv', 'candidate', 'score resume', 'job description'], weight: 3 },
  { block: 'aeon_matrix',  terms: ['recall', 'remember', 'what did i', 'vault', 'second brain', 'index', 'brain'], weight: 3 },
  { block: 'deep_research',terms: ['research', 'deep research', 'investigate', 'scrape', 'sources'], weight: 3 },
  { block: 'writer',       terms: ['write', 'draft', 'compose', 'note', 'document', 'docs'], weight: 2 },
  { block: 'files',        terms: ['file', 'files', 'folder', 'directory', 'list files'], weight: 2 },
  { block: 'settings',     terms: ['setting', 'settings', 'config', 'configure', 'preference'], weight: 2 },
  { block: 'security',     terms: ['lock', 'unlock', 'guard', 'security', 'flush', 'session'], weight: 3 },
  { block: 'cookbook',     terms: ['model', 'models', 'gpu', 'pull model', 'download model', 'runtime', 'llama.cpp'], weight: 3 },
  { block: 'orion_search', terms: ['search the web', 'web search', 'google', 'orion', 'look up online'], weight: 3 },
  { block: 'host_os',      terms: ['scan', 'system', 'autopilot', 'upload', 'host'], weight: 2 },
  { block: 'dashboard',    terms: ['dashboard', 'push', 'pull', 'sync'], weight: 1 },
  { block: 'master',       terms: ['blocks', 'list blocks', 'mounted'], weight: 2 },
  { block: 'council',      terms: ['council', 'debate', 'consensus', 'panel'], weight: 3 },
  { block: 'memory_core',  terms: ['memory', 'memories', 'remember this'], weight: 2 },
  { block: 'activity',     terms: ['activity', 'heatmap', 'history'], weight: 2 },
  { block: 'fleet_control',terms: ['fleet', 'agents', 'agent status'], weight: 2 },
  { block: 'quick_links',  terms: ['link', 'links', 'bookmark', 'shortcut'], weight: 2 },
];

const norm = (s) => String(s || '').toLowerCase().trim();

/**
 * Deterministic resolution. Returns null when it is not confident, which is
 * the signal for the caller to try the model.
 */
function fastMatch(input, commands) {
  const text = norm(input);
  if (!text) return null;

  // 1. Exact command token: "/gpu", "gpu", "/gpu 0" — highest confidence.
  const firstWord = text.split(/\s+/)[0];
  const bare = firstWord.replace(/^\//, '');
  for (const spec of commands) {
    const specBare = norm(spec.cmd).replace(/^\//, '');
    if (specBare === bare) {
      return {
        ...spec,
        arg: input.trim().slice(firstWord.length).trim(),
        confidence: 1,
        via: 'exact',
        explanation: `exact command ${spec.cmd}`,
      };
    }
  }

  // 2. Namespaced id: "cookbook.gpu"
  for (const spec of commands) {
    if (norm(spec.id) === bare) {
      return { ...spec, arg: input.trim().slice(firstWord.length).trim(), confidence: 1, via: 'id', explanation: `command id ${spec.id}` };
    }
  }

  // 3. Intent scoring across the live registry.
  const scores = new Map();
  for (const intent of INTENTS) {
    for (const term of intent.terms) {
      if (text.includes(term)) {
        scores.set(intent.block, (scores.get(intent.block) || 0) + intent.weight * (term.includes(' ') ? 2 : 1));
      }
    }
  }
  // A command's own title/desc is evidence too — manifests describe themselves.
  for (const spec of commands) {
    const hay = norm(`${spec.title} ${spec.desc}`);
    for (const word of text.split(/\s+/).filter((w) => w.length > 3)) {
      if (hay.includes(word)) scores.set(spec.blockId, (scores.get(spec.blockId) || 0) + 1);
    }
  }
  if (!scores.size) return null;

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [topBlock, topScore] = ranked[0];
  const runnerUp = ranked[1]?.[1] || 0;

  // Ambiguous between two blocks → hand it to the model rather than guess.
  if (topScore < 3 || (runnerUp && topScore - runnerUp < 2)) return null;

  const candidates = commands.filter((s) => s.blockId === topBlock);
  if (!candidates.length) return null;

  // Within the winning block, prefer the command whose own words match best.
  let best = candidates[0], bestHits = -1;
  for (const spec of candidates) {
    const hay = norm(`${spec.cmd} ${spec.title} ${spec.desc}`);
    const hits = text.split(/\s+/).filter((w) => w.length > 3 && hay.includes(w)).length;
    if (hits > bestHits) { best = spec; bestHits = hits; }
  }

  return {
    ...best,
    arg: stripIntentWords(input),
    confidence: Math.min(0.9, 0.55 + topScore * 0.05),
    via: 'intent',
    explanation: `matched ${topBlock} (score ${topScore})`,
  };
}

// The whole utterance is usually the argument — "research USB trends" should
// search for "USB trends", not "research USB trends". Strip only the leading
// imperative, never words from the middle.
function stripIntentWords(input) {
  return String(input).trim()
    .replace(/^(please\s+)?(can you\s+|could you\s+)?/i, '')
    .replace(/^(run|do|start|open|show me|show|give me|get|find|search for|search|tell me)\s+/i, '')
    .trim();
}

/**
 * Model-assisted routing. The model chooses from the registry and returns an
 * id; anything it returns that is not a real command is rejected here rather
 * than dispatched, so a hallucinated route can never reach the kernel.
 */
async function llmRoute(input, commands) {
  const live = await ping();
  if (!live.connected) return null;

  const catalogue = commands
    .filter((s) => s.available !== false)
    .map((s) => `${s.id} | ${s.cmd} | ${s.blockLabel} | ${s.title}${s.desc ? ` — ${s.desc}` : ''}`)
    .join('\n');

  const prompt = `You are AEON's terminal router. Map the user's command to exactly one entry from the registry.

REGISTRY (id | cmd | block | description):
${catalogue}

USER COMMAND: "${input}"

Reply with ONLY a JSON object, no prose, no code fence:
{"id":"<exact id from the registry>","arg":"<argument text, or empty string>","confidence":<0.0-1.0>,"explanation":"<one short line>"}

If nothing in the registry fits, reply {"id":null,"confidence":0,"explanation":"no match"}.`;

  // POST /api/ai — { prompt, role } → { text }. This was /api/ai/kernel, which
  // has never existed: the route is mounted at /api/ai (server.js), so every
  // llmRoute() call 404'd and the model tier silently never ran. The fast tier
  // masked it — anything it resolved worked, anything it didn't fell straight
  // through to "nothing matched". Found while wiring the agent loop, which
  // copied this same wrong URL and failed loudly on the first call.
  const res = await request('POST', '/api/ai', {
    role: 'router',
    prompt,
  }, { timeout: 45000 });

  if (!res.ok) return null;
  const d = res.data || {};
  const raw = d.text ?? d.answer ?? d.content ?? d.message ?? d.response ?? '';
  const parsed = extractJson(typeof raw === 'string' ? raw : JSON.stringify(raw));
  if (!parsed || !parsed.id) return null;

  const spec = commands.find((s) => s.id === parsed.id)
    || commands.find((s) => norm(s.cmd) === norm(parsed.id));
  if (!spec) return null;   // hallucinated route — refuse it

  return {
    ...spec,
    arg: parsed.arg || stripIntentWords(input),
    confidence: Number(parsed.confidence) || 0.6,
    via: 'llm',
    explanation: parsed.explanation || 'model-routed',
  };
}

// Models wrap JSON in prose or fences no matter how firmly you ask them not
// to. Pull the first balanced object out rather than trusting the envelope.
function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < body.length; i++) {
    if (body[i] === '{') depth++;
    else if (body[i] === '}' && --depth === 0) {
      try { return JSON.parse(body.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

/**
 * Full resolution: fast tier, then model, then give up with suggestions so the
 * user gets a next step instead of a dead end.
 */
async function routeCommand(input, commands, { noLlm = false } = {}) {
  const fast = fastMatch(input, commands);
  if (fast && fast.confidence >= 0.75) return fast;
  if (!noLlm) {
    const routed = await llmRoute(input, commands);
    if (routed) return routed;
  }
  if (fast) return fast;
  return { ok: false, suggestions: suggest(input, commands), input };
}

function suggest(input, commands, limit = 5) {
  const text = norm(input);
  const words = text.split(/\s+/).filter((w) => w.length > 2);
  return commands
    .map((s) => {
      const hay = norm(`${s.cmd} ${s.title} ${s.desc} ${s.blockLabel}`);
      return { spec: s, score: words.filter((w) => hay.includes(w)).length };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.spec);
}

module.exports = { routeCommand, fastMatch, llmRoute, suggest, stripIntentWords, extractJson };
