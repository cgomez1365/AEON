/**
 * Embeddings — one-shot llama-embedding path.
 *
 * No network, no model load, no spawning. The parser, the command line and the
 * pre-flight validation are the parts that regress silently, and all three are
 * pure. The real binary is exercised end to end in BO-A4 instead of being
 * faked here — a stub would only prove the stub works.
 *
 * Imports the real embedder — no re-implementation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const LR = path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), '..', '..', 'services', 'local-runtime');
const { embedOnce, buildEmbedArgs, parseEmbeddingJson, embeddingBinaryFor } = require(path.join(LR, 'embedder.cjs'));

const isWin = os.platform() === 'win32';

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-embed-')); });
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

describe('parseEmbeddingJson', () => {
  it('extracts the vector from OpenAI-style output', () => {
    const out = 'load noise\n' + JSON.stringify({
      object: 'list',
      data: [{ object: 'embedding', index: 0, embedding: [0.1, -0.2, 0.3] }],
    });
    expect(parseEmbeddingJson(out)).toEqual([0.1, -0.2, 0.3]);
  });

  it('rejects output with no JSON at all', () => {
    expect(() => parseEmbeddingJson('total failure, no braces here')).toThrow(/no JSON/i);
  });

  it('rejects malformed JSON', () => {
    expect(() => parseEmbeddingJson('{ "data": [ ')).toThrow(/could not parse/i);
  });

  it('rejects a well-formed response carrying no embedding', () => {
    expect(() => parseEmbeddingJson(JSON.stringify({ object: 'list', data: [] })))
      .toThrow(/no embedding/i);
    expect(() => parseEmbeddingJson(JSON.stringify({ object: 'list', data: [{ embedding: [] }] })))
      .toThrow(/no embedding/i);
  });

  it('rejects a vector containing NaN or Infinity', () => {
    // JSON.stringify turns these into null, which is exactly how a corrupt
    // run would surface — a silent null in a vector is worse than an error.
    const out = '{"data":[{"embedding":[0.1,null,0.3]}]}';
    expect(() => parseEmbeddingJson(out)).toThrow(/non-finite/i);
  });
});

describe('embeddingBinaryFor', () => {
  it('resolves the sibling embedding binary of the runtime entrypoint', () => {
    const entry = isWin ? 'C:\\rt\\llamacpp\\llama-cli.exe' : '/rt/llamacpp/llama-cli';
    const got = embeddingBinaryFor(entry);
    expect(path.dirname(got)).toBe(path.dirname(entry));
    expect(path.basename(got)).toBe(isWin ? 'llama-embedding.exe' : 'llama-embedding');
  });
});

describe('embedOnce — argument validation', () => {
  it('requires absolute paths', async () => {
    await expect(embedOnce({ entryAbsPath: 'rel/llama-cli', modelAbsPath: '/a/m.gguf', text: 'x' }))
      .rejects.toThrow(/entryAbsPath must be absolute/);
    await expect(embedOnce({ entryAbsPath: path.resolve('/a/llama-cli'), modelAbsPath: 'rel.gguf', text: 'x' }))
      .rejects.toThrow(/modelAbsPath must be absolute/);
  });

  it('rejects empty text rather than embedding whitespace', async () => {
    // Validation runs before any filesystem or process work, so no fixture.
    for (const bad of ['', '   ', '\n\t', null, undefined]) {
      await expect(embedOnce({
        entryAbsPath: path.resolve('/rt/llama-cli'),
        modelAbsPath: path.resolve('/m.gguf'),
        text: bad,
      })).rejects.toThrow(/text is empty/);
    }
  });

  it('names the missing binary when llama-embedding is absent', async () => {
    const dir = path.join(tmp, 'bare');
    fs.mkdirSync(dir, { recursive: true });
    const entry = path.join(dir, isWin ? 'llama-cli.exe' : 'llama-cli');
    fs.writeFileSync(entry, '');
    const model = path.join(tmp, 'm.gguf');
    fs.writeFileSync(model, 'GGUF');
    await expect(embedOnce({ entryAbsPath: entry, modelAbsPath: model, text: 'hi' }))
      .rejects.toThrow(/llama-embedding not found/);
  });

  it('reports a missing model file', async () => {
    // Only presence is checked, so an empty file is a sufficient fixture and
    // the call rejects before anything is spawned.
    const dir = path.join(tmp, 'rt');
    fs.mkdirSync(dir, { recursive: true });
    const entry = path.join(dir, isWin ? 'llama-cli.exe' : 'llama-cli');
    fs.writeFileSync(entry, '');
    fs.writeFileSync(path.join(dir, isWin ? 'llama-embedding.exe' : 'llama-embedding'), '');
    await expect(embedOnce({ entryAbsPath: entry, modelAbsPath: path.join(tmp, 'nope.gguf'), text: 'hi' }))
      .rejects.toThrow(/model file not found/);
  });
});

describe('buildEmbedArgs — n_batch >= n_ctx', () => {
  const valOf = (args, flag) => args[args.indexOf(flag) + 1];

  it('always passes --batch-size equal to --ctx-size', () => {
    // llama-embedding ABORTS on GGML_ASSERT(n_batch >= n_ctx) rather than
    // returning an error, so a ctx above the 2048 default batch killed the
    // child process. Asserted on the real command line the module builds.
    for (const contextSize of [512, 2048, 8192, 32768]) {
      const args = buildEmbedArgs({ modelAbsPath: '/m.gguf', text: 'hi', contextSize });
      expect(valOf(args, '--ctx-size')).toBe(String(contextSize));
      expect(valOf(args, '--batch-size')).toBe(String(contextSize));
    }
  });

  it('floors a nonsense context size instead of passing it through', () => {
    for (const bad of [0, -1, NaN, undefined, null, 'abc']) {
      const args = buildEmbedArgs({ modelAbsPath: '/m.gguf', text: 'hi', contextSize: bad });
      expect(Number(valOf(args, '--ctx-size'))).toBeGreaterThanOrEqual(64);
      expect(valOf(args, '--batch-size')).toBe(valOf(args, '--ctx-size'));
    }
  });

  it('requests JSON output and passes the model and prompt through', () => {
    const args = buildEmbedArgs({ modelAbsPath: '/models/x.gguf', text: 'hello world' });
    expect(valOf(args, '--model')).toBe('/models/x.gguf');
    expect(valOf(args, '--prompt')).toBe('hello world');
    expect(valOf(args, '--embd-output-format')).toBe('json');
  });
});

// The real binary's behaviour — JSON on stdout, log noise on stderr, and the
// non-zero-exit-with-output case — is covered by parseEmbeddingJson above and
// proven end to end against the actual llama-embedding binary in BO-A4. Not
// stubbed here: a fake executable cannot be spawned without a shell on
// Windows, and adding one would test the stub, not the code.
