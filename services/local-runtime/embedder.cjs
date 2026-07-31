'use strict';
/**
 * Embeddings — one-shot, no daemon.
 *
 * Why this exists instead of going through supervisor.cjs/worker.mjs:
 *
 * The worker spawns the runtime with `--server`, points `--host` at a NAMED
 * PIPE, passes `--log-disable`, then waits for the string "listening" on the
 * child's stdout while explicitly discarding stderr. Every one of those is
 * wrong for llama.cpp b5060:
 *
 *   - `llama-cli` has no --server flag at all: "error: invalid argument"
 *   - llama.cpp's server is TCP-only; it cannot bind a named pipe or a socket
 *   - the readiness banner goes to stderr, which the worker throws away
 *   - --log-disable suppresses the banner regardless
 *
 * So `childReady` could never become true, the `ready` message was never
 * posted, and getSupervisor() awaited a promise nothing would ever resolve.
 * embed() hung forever with no output and no log. (Verified 2026-07-31.)
 *
 * The llama.cpp release already ships `llama-embedding`, a dedicated one-shot
 * binary that prints OpenAI-style JSON and exits. It needs no port, no pipe,
 * no daemon and no readiness handshake — which matches what the rest of this
 * subtree promises ("No daemon, no TCP") far better than a resident server
 * does. Embedding is a request/response operation; it does not need a session.
 *
 * Containment rules are unchanged: absolute managed paths only, no shell, no
 * PATH lookup, clean environment.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** A cold model load dominates; the embedding itself is milliseconds. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Sibling of the runtime entrypoint, per runtime-assets.json requiredFiles. */
function embeddingBinaryFor(entryAbsPath) {
  const dir = path.dirname(entryAbsPath);
  const exe = os.platform() === 'win32' ? 'llama-embedding.exe' : 'llama-embedding';
  return path.join(dir, exe);
}

/**
 * Parse llama-embedding's `--embd-output-format json` payload.
 * Shape is OpenAI's: { object:'list', data:[{ embedding:[...] }] }
 */
function parseEmbeddingJson(stdout) {
  const start = stdout.indexOf('{');
  if (start === -1) throw new Error('embedder: no JSON in output');
  let parsed;
  try {
    parsed = JSON.parse(stdout.slice(start));
  } catch (e) {
    throw new Error(`embedder: could not parse output as JSON: ${e.message}`);
  }
  const first = parsed && Array.isArray(parsed.data) ? parsed.data[0] : null;
  const vec = first && Array.isArray(first.embedding) ? first.embedding : null;
  if (!vec || !vec.length) throw new Error('embedder: output contained no embedding');
  if (!vec.every(n => typeof n === 'number' && Number.isFinite(n))) {
    throw new Error('embedder: embedding contained a non-finite value');
  }
  return vec;
}

/**
 * Build the llama-embedding command line.
 *
 * Pure and exported so the n_batch invariant can be asserted without spawning
 * anything: llama-embedding does not return an error when n_batch < n_ctx, it
 * ABORTS the process —
 *   GGML_ASSERT(params.n_batch >= params.n_ctx) failed
 * The default batch is 2048, so any context above that killed the child rather
 * than failing gracefully. Pinning batch to ctx makes every context size legal.
 */
function buildEmbedArgs({ modelAbsPath, text, contextSize = 512 }) {
  const ctx = Math.max(64, Math.floor(Number(contextSize)) || 512);
  return [
    '--model', modelAbsPath,
    '--prompt', text,
    '--embd-output-format', 'json',
    '--ctx-size', String(ctx),
    '--batch-size', String(ctx),
    '--no-warmup',
  ];
}

/**
 * Embed one string.
 *
 * @param {object}  opts
 * @param {string}  opts.entryAbsPath  absolute path to llama-cli in the managed runtime dir
 * @param {string}  opts.modelAbsPath  absolute path to the GGUF
 * @param {string}  opts.text
 * @param {number} [opts.contextSize]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<number[]>}
 */
function embedOnce({ entryAbsPath, modelAbsPath, text, contextSize = 512, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    if (!entryAbsPath || !path.isAbsolute(entryAbsPath)) {
      return reject(new Error('embedder: entryAbsPath must be absolute'));
    }
    if (!modelAbsPath || !path.isAbsolute(modelAbsPath)) {
      return reject(new Error('embedder: modelAbsPath must be absolute'));
    }
    const input = String(text == null ? '' : text);
    if (!input.trim()) return reject(new Error('embedder: text is empty'));

    const bin = embeddingBinaryFor(entryAbsPath);
    if (!fs.existsSync(bin)) {
      return reject(new Error(`embedder: llama-embedding not found next to the runtime entrypoint: ${bin}`));
    }
    if (!fs.existsSync(modelAbsPath)) {
      return reject(new Error(`embedder: model file not found: ${modelAbsPath}`));
    }

    const args = buildEmbedArgs({ modelAbsPath, text: input, contextSize });

    execFile(bin, args, {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,   // a 768-dim vector as JSON text is large
      windowsHide: true,
      shell: false,                  // absolute path only, never PATH
      encoding: 'utf8',
      // Clean environment — nothing inherited that could redirect model paths.
      env: {
        PATH: process.env.PATH || '',
        SYSTEMROOT: process.env.SYSTEMROOT || '',
        TEMP: process.env.TEMP || os.tmpdir(),
        TMP: process.env.TMP || os.tmpdir(),
      },
    }, (err, stdout, stderr) => {
      // The binary writes its whole log to stderr and exits 0; a non-zero exit
      // with usable stdout still yields a vector, so parse before judging.
      if (stdout && stdout.includes('{')) {
        try { return resolve(parseEmbeddingJson(stdout)); } catch (parseErr) {
          return reject(parseErr);
        }
      }
      if (err) {
        if (err.killed) return reject(new Error(`embedder: timed out after ${timeoutMs}ms`));
        const detail = (stderr || '').trim().split('\n').slice(-3).join(' ');
        return reject(new Error(`embedder: ${err.message}${detail ? ' — ' + detail : ''}`));
      }
      reject(new Error('embedder: produced no output'));
    });
  });
}

module.exports = { embedOnce, buildEmbedArgs, parseEmbeddingJson, embeddingBinaryFor, DEFAULT_TIMEOUT_MS };
