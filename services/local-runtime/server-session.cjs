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
const budget = require('./budget.cjs');

const READY_TIMEOUT_MS = 90_000;   // cold load of a multi-GB model off disk
const HEALTH_POLL_MS = 250;
const STDERR_KEEP = 40;            // lines retained for diagnostics

/**
 * BO-D1b — the timeout measures SILENCE, not duration.
 *
 * This was `REQUEST_TIMEOUT_MS = 180_000`, a wall clock on the whole request.
 * It is the reason every long answer stopped near 750 tokens: the model was
 * still generating correctly and the clock ran out. The operator saw 701,
 * 730, 743 tokens and no setting they could reach changed it, because the
 * ceiling was not a token setting at all.
 *
 * Wall-clock is the wrong measurement. A healthy 40-minute generation emits
 * tokens the entire time; a wedged one stops emitting. So we bound the gap
 * BETWEEN tokens instead. That is simultaneously far more permissive for
 * real work and strictly harsher on an actually-hung model — a server that
 * dies silently is now caught in 60s rather than 180.
 */
const IDLE_TIMEOUT_MS = 60_000;

// BO-E3 removed the non-streaming request path entirely — every call to
// llama-server streams now, so the idle timeout above is the only generation
// bound and undici's 300s bodyTimeout can no longer cap a slow model.
// (The former NONSTREAM_TIMEOUT_MS lived here.)

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
  constructor({ entryAbsPath, modelAbsPath, contextSize = 4096, ngl = 0, logPath = null, embeddings = false,
                cacheType = null, idleTimeoutMs = IDLE_TIMEOUT_MS }) {
    this.entryAbsPath = entryAbsPath;
    this.modelAbsPath = modelAbsPath;
    this.contextSize = contextSize;
    this.ngl = ngl;
    this.logPath = logPath;
    this.embeddings = embeddings;
    // D1e — 'q8_0' halves the KV cache, which is the lever that puts 32k in
    // reach on a machine that could otherwise only serve 8k.
    this.cacheType = cacheType;
    this.idleTimeoutMs = idleTimeoutMs;

    // D1c — in-flight generations, so a stop request can reach them.
    this._active = new Set();
    this._idleAborted = new WeakSet();

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
      // Quantising K and V halves the cache. Applied only when the fit engine
      // asked for it, so the default path keeps f16 precision.
      ...(this.cacheType ? ['--cache-type-k', this.cacheType, '--cache-type-v', this.cacheType] : []),
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
    // A binary that cannot launch at all (missing, unreadable, wrong arch)
    // emits 'error' and never 'exit'. Unhandled, that event throws and kills
    // the kernel rather than failing this session.
    this.child.on('error', (err) => {
      exited = { code: null, signal: null };
      this.state = 'error';
      this.lastError = `llama-server could not start: ${err.message}`;
      this._recordStderr(`[spawn error] ${err.message}\n`);
    });
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
  async chat(messages, { maxTokens, temperature = 0.7, stop, onToken, signal, long = false } = {}) {
    if (this.state !== 'ready') await this.start();

    // D1a — the budget is arithmetic against THIS session's window, not a
    // constant. `maxTokens` remains overridable, but the default is now
    // derived rather than guessed at 512.
    const promptTokens = budget.estimateMessageTokens(messages);
    const plan = budget.outputBudget({
      contextTokens: this.contextSize,
      promptTokens,
      long,
      requested: maxTokens,
    });
    if (!plan.fits) {
      const e = new Error(plan.reason);
      e.code = 'CONTEXT_EXHAUSTED';
      e.budget = plan;
      throw e;
    }

    // BO-E3 — ALWAYS stream from llama-server, even when the caller wants one
    // string back.
    //
    // Found by running real inference on a clean machine (2026-08-08): a
    // generation that took longer than five minutes failed with a bare
    // "fetch failed", after exactly 300.0 seconds.
    //
    // That is undici's `bodyTimeout`, which Node's built-in fetch applies
    // independently of any AbortSignal. On a non-streamed request llama-server
    // sends headers immediately and then computes the WHOLE answer before
    // writing a body — so a slow model trips a five-minute cap that nothing in
    // AEON declared and no setting could reach.
    //
    // It is the same defect D1b removed, one layer down and quieter: the
    // ceiling did not disappear, it moved from 180s to 300s. Streaming resets
    // undici's timer on every chunk, which makes D1b's inter-token idle
    // timeout the single governing limit for both paths — which is what D1b
    // argued for in the first place.
    //
    // The cost is `usage.total_tokens`; tokens are estimated from the text
    // instead. A slightly soft token count is a fair trade for output that is
    // not silently truncated at five minutes.
    const wantsCallback = typeof onToken === 'function';
    const body = {
      messages,
      max_tokens: plan.maxTokens,
      temperature,
      stream: true,
      ...(stop && stop.length ? { stop } : {}),
      // Reasoning models (Qwen3 and friends) emit a long internal monologue
      // before their answer, and llama-server reports it separately as
      // reasoning_content. With a modest max_tokens the monologue consumes the
      // whole budget and `content` comes back EMPTY — the user asks a question
      // and the screen stays blank. Templates that don't know this kwarg ignore
      // it, so it is safe to send unconditionally.
      chat_template_kwargs: { enable_thinking: false },
    };

    // D1c — the caller's abort signal reaches the upstream fetch. Aborting
    // this request is what makes llama-server cancel generation; without it
    // /chat/stop could only ever lie. At the old 512-token cap a fake stop
    // was a two-minute annoyance. At D1a's budget it is ~43 minutes of
    // unstoppable CPU while the UI says "cancelled".
    const controller = new AbortController();
    const abortUpstream = () => { try { controller.abort(); } catch { /* already gone */ } };
    if (signal) {
      if (signal.aborted) abortUpstream();
      else signal.addEventListener('abort', abortUpstream, { once: true });
    }
    this._active.add(controller);

    try {
      const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        // Every request streams now (BO-E3), so the inter-token idle timeout
        // below is the ONLY generation bound. No wall clock, and nothing
        // undici can cap behind our back.
        signal: controller.signal,
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`llama-server returned ${res.status}: ${detail.slice(0, 300)}`);
      }

      // SSE stream: "data: {json}\n\n", terminated by "data: [DONE]".
      let text = '';
      let model = null;
      let finishReason = null;
      const decoder = new TextDecoder();
      let buffer = '';

      // D1b — bound the gap between tokens, not the life of the request.
      let idleTimer = null;
      const armIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          this._idleAborted.add(controller);
          abortUpstream();
        }, this.idleTimeoutMs);
      };
      armIdle();

      try {
        for await (const chunk of res.body) {
          armIdle();                       // a token arrived: the model is alive
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
            const choice = evt?.choices?.[0];
            if (choice?.finish_reason) finishReason = choice.finish_reason;
            const delta = choice?.delta?.content;
            // A caller that wanted one string still gets one; it simply is not
            // told about each token on the way (BO-E3).
            if (delta) { text += delta; if (wantsCallback) onToken(delta); }
          }
        }
      } catch (e) {
        if (e?.name === 'AbortError') {
          if (this._idleAborted.has(controller)) {
            const stalled = new Error(
              `The model stopped producing output for ${Math.round(this.idleTimeoutMs / 1000)}s and was cancelled. `
              + `${text.length ? 'The partial answer above is what it produced.' : 'It produced nothing.'} `
              + `${this.stderrTail(3)}`.trim()
            );
            stalled.code = 'MODEL_STALLED';
            stalled.partialText = text;
            throw stalled;
          }
          // A deliberate stop is not a failure. Return what was generated.
          return {
            text, model,
            tokens: budget.estimateTokens(text),
            complete: false,
            finishReason: 'cancelled',
            truncated: false,
            cancelled: true,
            budget: plan,
          };
        }
        throw e;
      } finally {
        clearTimeout(idleTimer);
      }

      return {
        text, model,
        tokens: budget.estimateTokens(text),
        ...this._completion(finishReason, plan),
      };
    } finally {
      this._active.delete(controller);
      this._idleAborted.delete(controller);
      if (signal) signal.removeEventListener?.('abort', abortUpstream);
    }
  }

  /**
   * D1d — say whether the answer actually finished.
   *
   * `finish_reason` was read and discarded, so a reply cut off at the budget
   * was indistinguishable on screen from one the model chose to end. That is
   * §08 exactly: AEON held the fact and dropped it on the way to the display.
   * With this surfaced, a caller can offer Continue — and once turns stitch,
   * output length stops being bounded by the window at all.
   */
  _completion(finishReason, plan) {
    const truncated = finishReason === 'length';
    return {
      finishReason: finishReason || null,
      complete: !truncated,
      truncated,
      budget: plan,
      ...(truncated ? {
        truncationReason:
          `The answer reached its ${plan.maxTokens.toLocaleString()}-token budget and stopped mid-thought. `
          + (plan.limitedBy === 'cap'
            ? 'Continue to carry on, or use long mode to release the rest of the window.'
            : 'Continue to carry on in a fresh turn.'),
      } : {}),
    };
  }

  /** D1c — cancel every generation in flight on this session. */
  cancelActive() {
    let n = 0;
    for (const c of this._active) { try { c.abort(); n++; } catch { /* already gone */ } }
    return n;
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
      // An embedding is a single short forward pass — a wall clock is the
      // right measurement here, unlike generation (D1b).
      signal: AbortSignal.timeout(120_000),
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
    // Killing the child would strand any awaiting generation; abort them
    // first so callers get a cancellation rather than a socket error.
    this.cancelActive();
    if (this.child && !this.child.killed) {
      try { this.child.kill(); } catch { /* already gone */ }
    }
    this.child = null;
    this.port = null;
  }
}

module.exports = { ServerSession, reserveLoopbackPort, serverBinaryFor, READY_TIMEOUT_MS, IDLE_TIMEOUT_MS };
