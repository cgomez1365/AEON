'use strict';
/**
 * A live llama-server process on loopback, with a readiness handshake that can
 * actually complete — and, when it cannot, fails fast and says why.
 *
 * WHAT THIS REPLACES
 *
 * supervisor.cjs + worker.mjs spawned `llama-cli --server`, pointed `--host` at
 * a NAMED PIPE, passed `--log-disable`, then waited for the string "listening"
 * on the child's stdout while discarding stderr. Against llama.cpp b5060:
 *
 *   - `llama-cli` has no --server flag ("error: invalid argument: --server")
 *   - llama.cpp's server is TCP-only; it cannot bind a pipe
 *   - the readiness banner goes to stderr, which was thrown away
 *   - --log-disable suppresses it regardless
 *
 * So readiness never arrived. The 120s inference timeout could not save it,
 * because that timer was armed INSIDE the ready callback — on the wrong side of
 * the gate it needed to protect. infer() hung forever with no error and no log.
 *
 * THE RULES THIS FILE FOLLOWS
 *
 *   1. Readiness is a real signal: poll GET /health until it answers, and cap
 *      that wait with a timer armed BEFORE the wait begins. A broken handshake
 *      must surface in seconds as a readable message.
 *   2. stderr is captured, not discarded. It is llama.cpp's only real channel,
 *      and its tail is what turns "it failed" into "it failed because...".
 *   3. Loopback only, on a port claimed by us — never 0.0.0.0, never a fixed
 *      port that could collide with something the user is already running.
 *   4. The process is a child we own: killed on shutdown, on error, and on
 *      process exit, so a crashed kernel never leaves a model resident in RAM.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const READY_TIMEOUT_MS = 90_000;   // cold load of a multi-GB model off disk
const HEALTH_POLL_MS = 250;
const REQUEST_TIMEOUT_MS = 180_000;
const STDERR_KEEP = 40;            // lines retained for diagnostics

/** Ask the OS for a free loopback port, then release it for the child. */
function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Sibling of the runtime entrypoint. */
function serverBinaryFor(entryAbsPath) {
  const exe = os.platform() === 'win32' ? 'llama-server.exe' : 'llama-server';
  return path.join(path.dirname(entryAbsPath), exe);
}

class ServerSession {
  /**
   * @param {object} opts
   * @param {boolean} [opts.embeddings]  serve /v1/embeddings instead of chat.
   *   b10216 removed the standalone llama-embedding binary — embeddings are a
   *   llama-server mode now, which is why one session class covers both.
   */
  constructor({ entryAbsPath, modelAbsPath, contextSize = 4096, ngl = 0, logPath = null, embeddings = false }) {
    this.entryAbsPath = entryAbsPath;
    this.modelAbsPath = modelAbsPath;
    this.contextSize = contextSize;
    this.ngl = ngl;
    this.logPath = logPath;
    this.embeddings = embeddings;

    this.child = null;
    this.port = null;
    this.state = 'idle';           // idle | starting | ready | error | stopped
    this.lastError = null;
    this._stderr = [];
    this._startPromise = null;
  }

  get baseUrl() { return this.port ? `http://127.0.0.1:${this.port}` : null; }

  /** Recent stderr, newest last — the only place llama.cpp explains itself. */
  stderrTail(n = 8) { return this._stderr.slice(-n).join('\n'); }

  _recordStderr(text) {
    for (const line of String(text).split('\n')) {
      const t = line.trim();
      if (t) this._stderr.push(t);
    }
    if (this._stderr.length > STDERR_KEEP) {
      this._stderr.splice(0, this._stderr.length - STDERR_KEEP);
    }
    if (this.logPath) {
      try { fs.appendFileSync(this.logPath, text); } catch { /* logging is best-effort */ }
    }
  }

  /**
   * Start the server and resolve once /health answers. Idempotent: concurrent
   * callers share one start.
   */
  start() {
    if (this.state === 'ready') return Promise.resolve(this);
    if (this._startPromise) return this._startPromise;

    this._startPromise = this._doStart().catch((e) => {
      this._startPromise = null;
      throw e;
    });
    return this._startPromise;
  }

  async _doStart() {
    const bin = serverBinaryFor(this.entryAbsPath);
    if (!fs.existsSync(bin)) {
      throw new Error(`llama-server not found next to the runtime entrypoint: ${bin}`);
    }
    if (!fs.existsSync(this.modelAbsPath)) {
      throw new Error(`model file not found: ${this.modelAbsPath}`);
    }

    this.state = 'starting';
    this._stderr = [];
    this.port = await reserveLoopbackPort();

    const args = [
      '--model', this.modelAbsPath,
      '--host', '127.0.0.1',          // loopback ONLY — never exposed to a LAN
      '--port', String(this.port),
      '--ctx-size', String(this.contextSize),
      '--n-gpu-layers', String(this.ngl),
      '--no-webui',                   // we are the UI; don't serve another one
      ...(this.embeddings
        // Embedding mode: pooling must be set or /v1/embeddings 500s, and
        // n_batch must cover n_ctx the same way the old standalone binary
        // asserted on.
        ? ['--embeddings', '--pooling', 'mean', '--batch-size', String(this.contextSize)]
        : ['--jinja']),               // chat: use the model's own template
    ];

    this.child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      // Clean environment: nothing inherited can redirect model or cache paths.
      env: {
        PATH: process.env.PATH || '',
        SYSTEMROOT: process.env.SYSTEMROOT || '',
        TEMP: process.env.TEMP || os.tmpdir(),
        TMP: process.env.TMP || os.tmpdir(),
      },
    });

    // BOTH streams are kept. Discarding stderr is what left the old failure
    // with no diagnostic trail whatsoever.
    this.child.stdout.on('data', (c) => this._recordStderr(c.toString()));
    this.child.stderr.on('data', (c) => this._recordStderr(c.toString()));

    let exited = null;
    this.child.on('exit', (code, signal) => {
      exited = { code, signal };
      if (this.state !== 'stopped') {
        this.state = 'error';
        this.lastError = `llama-server exited (code ${code}${signal ? `, ${signal}` : ''})`;
      }
    });
    this.child.on('error', (e) => {
      this.state = 'error';
      this.lastError = `could not start llama-server: ${e.message}`;
    });

    // The deadline is armed HERE — before the wait — so a handshake that never
    // completes fails in READY_TIMEOUT_MS instead of hanging forever.
    const deadline = Date.now() + READY_TIMEOUT_MS;

    for (;;) {
      if (exited) {
        this.state = 'error';
        throw new Error(
          `llama-server exited during startup (code ${exited.code}). ${this.stderrTail(4)}`.trim()
        );
      }
      if (await this._healthOk()) {
        this.state = 'ready';
        return this;
      }
      if (Date.now() > deadline) {
        this.stop();
        throw new Error(
          `llama-server did not become ready within ${READY_TIMEOUT_MS / 1000}s. ${this.stderrTail(4)}`.trim()
        );
      }
      await new Promise(r => setTimeout(r, HEALTH_POLL_MS));
    }
  }

  async _healthOk() {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return false;
      const body = await res.json().catch(() => ({}));
      // While weights load, llama-server answers 503 with status "loading model".
      return !body.status || body.status === 'ok';
    } catch { return false; }
  }

  /**
   * Chat completion. Returns { text, tokens, model }.
   * onToken, when supplied, receives each token as it streams.
   */
  async chat(messages, { maxTokens = 512, temperature = 0.7, stop, onToken } = {}) {
    if (this.state !== 'ready') await this.start();

    const body = {
      messages,
      max_tokens: maxTokens,
      temperature,
      stream: !!onToken,
      ...(stop && stop.length ? { stop } : {}),
      // Reasoning models (Qwen3 and friends) emit a long internal monologue
      // before their answer, and llama-server reports it separately as
      // reasoning_content. With a modest max_tokens the monologue consumes the
      // whole budget and `content` comes back EMPTY — the user asks a question
      // and the screen stays blank. Templates that don't know this kwarg ignore
      // it, so it is safe to send unconditionally.
      chat_template_kwargs: { enable_thinking: false },
    };

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`llama-server returned ${res.status}: ${detail.slice(0, 300)}`);
    }

    if (!onToken) {
      const json = await res.json();
      const msg = json?.choices?.[0]?.message || {};
      // Belt and braces for the same problem: if a model reasoned its way
      // through the entire budget anyway, show that rather than nothing. A
      // wall of thinking is a bad answer; an empty bubble is not an answer.
      const text = msg.content || msg.reasoning_content || '';
      return { text, tokens: json?.usage?.total_tokens || 0, model: json?.model || null };
    }

    // SSE stream: "data: {json}\n\n", terminated by "data: [DONE]".
    let text = '';
    let model = null;
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const parts = buffer.split('\n');
      buffer = parts.pop();
      for (const line of parts) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const payload = s.slice(5).trim();
        if (payload === '[DONE]') continue;
        let evt;
        try { evt = JSON.parse(payload); } catch { continue; }
        model = model || evt.model || null;
        const delta = evt?.choices?.[0]?.delta?.content;
        if (delta) { text += delta; onToken(delta); }
      }
    }
    return { text, tokens: Math.ceil(text.length / 4), model };
  }

  /**
   * Embed one string. Requires a session constructed with { embeddings: true }.
   * @returns {Promise<number[]>}
   */
  async embed(text) {
    if (!this.embeddings) throw new Error('this session was not started in embedding mode');
    if (this.state !== 'ready') await this.start();

    const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: String(text) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`llama-server /v1/embeddings returned ${res.status}: ${detail.slice(0, 300)}`);
    }
    const json = await res.json();
    const vec = json?.data?.[0]?.embedding;
    if (!Array.isArray(vec) || !vec.length) throw new Error('llama-server returned no embedding');
    if (!vec.every(n => typeof n === 'number' && Number.isFinite(n))) {
      throw new Error('embedding contained a non-finite value');
    }
    return vec;
  }

  stop() {
    this.state = 'stopped';
    this._startPromise = null;
    if (this.child && !this.child.killed) {
      try { this.child.kill(); } catch { /* already gone */ }
    }
    this.child = null;
    this.port = null;
  }
}

module.exports = { ServerSession, reserveLoopbackPort, serverBinaryFor, READY_TIMEOUT_MS };
