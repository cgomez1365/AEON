'use strict';
/**
 * Phase 5 — Runtime supervisor.
 *
 * Owns the worker_thread that hosts the llama.cpp process. Handles:
 *   - Lazy start (worker only spawned when first inference is requested)
 *   - Restart on unexpected exit (up to MAX_RESTARTS times)
 *   - Graceful shutdown
 *   - Request correlation (id → promise callbacks)
 *   - Queue integration — calls queue.enqueue() so concurrent callers serialize
 *
 * The supervisor is a singleton per Node process. Import `getSupervisor()`
 * from the local-runtime index, never construct it directly.
 *
 * State machine:
 *   idle → starting → ready → busy → ready → ... → stopping → stopped
 *
 * This module never touches: Ollama, PATH, HOME, or any model path directly.
 * All path resolution goes through paths.cjs; all state through registry.cjs.
 */

const { Worker } = require('worker_threads');
const path = require('path');
const { InferenceQueue } = require('./queue.cjs');

const WORKER_PATH = path.join(__dirname, 'worker.mjs');
const MAX_RESTARTS = 3;
const RESTART_DELAY_MS = 1500;
const INFER_TIMEOUT_MS = 120_000;

// Valid supervisor states
const STATES = ['idle', 'starting', 'ready', 'busy', 'stopping', 'stopped', 'error'];

class Supervisor {
  constructor({ entryAbsPath, modelAbsPath, contextSize = 4096, ngl = 0 } = {}) {
    if (!entryAbsPath || !path.isAbsolute(entryAbsPath)) {
      throw new Error('Supervisor: entryAbsPath must be an absolute path');
    }
    if (!modelAbsPath || !path.isAbsolute(modelAbsPath)) {
      throw new Error('Supervisor: modelAbsPath must be an absolute path');
    }

    this._entryAbsPath = entryAbsPath;
    this._modelAbsPath = modelAbsPath;
    this._contextSize = contextSize;
    this._ngl = ngl;

    this._worker = null;
    this._state = 'idle';
    this._restarts = 0;
    this._queue = new InferenceQueue();
    this._pending = new Map();   // id → { resolve, reject, timer }
    this._idCounter = 0;
    this._readyCallbacks = [];
    this._errorCallbacks = [];
  }

  get state() { return this._state; }
  get queueDepth() { return this._queue.depth; }

  _setState(s) {
    if (!STATES.includes(s)) throw new Error(`Unknown state: ${s}`);
    this._state = s;
  }

  // ── Worker lifecycle ───────────────────────────────────────────────────────

  _startWorker() {
    if (this._state !== 'idle' && this._state !== 'error') return;
    this._setState('starting');

    this._worker = new Worker(WORKER_PATH, {
      workerData: {
        entryAbsPath: this._entryAbsPath,
        modelAbsPath: this._modelAbsPath,
        contextSize: this._contextSize,
        ngl: this._ngl,
      },
    });

    this._worker.on('message', (msg) => this._onMessage(msg));
    this._worker.on('error', (e) => this._onWorkerError(e));
    this._worker.on('exit', (code) => this._onWorkerExit(code));
  }

  _onMessage(msg) {
    switch (msg.type) {
      case 'ready': {
        this._setState('ready');
        const cbs = this._readyCallbacks.splice(0);
        for (const cb of cbs) cb();
        break;
      }
      case 'token': {
        const entry = this._pending.get(msg.id);
        if (entry && entry.onToken) entry.onToken(msg.t);
        break;
      }
      case 'done': {
        const entry = this._pending.get(msg.id);
        if (entry) {
          clearTimeout(entry.timer);
          this._pending.delete(msg.id);
          entry.resolve({ text: msg.text, tokens: msg.tokens, latencyMs: msg.latencyMs, provider: msg.provider, model: msg.model });
        }
        if (this._state === 'busy') this._setState('ready');
        break;
      }
      case 'error': {
        if (msg.id != null) {
          const entry = this._pending.get(msg.id);
          if (entry) {
            clearTimeout(entry.timer);
            this._pending.delete(msg.id);
            entry.reject(new Error(msg.error));
          }
          if (this._state === 'busy') this._setState('ready');
        } else {
          // Global worker error
          this._rejectAll(msg.error);
          this._setState('error');
        }
        break;
      }
      case 'exit': {
        // Worker's child process exited — handled in _onWorkerExit
        break;
      }
    }
  }

  _onWorkerError(e) {
    this._rejectAll(e.message);
    const cbs = this._errorCallbacks.splice(0);
    for (const cb of cbs) cb(e);
    this._setState('error');
  }

  _onWorkerExit(code) {
    if (this._state === 'stopping' || this._state === 'stopped') {
      this._setState('stopped');
      this._queue.flush('Runtime stopped');
      return;
    }
    // Unexpected exit — attempt restart
    this._rejectAll(`Runtime exited unexpectedly (code ${code})`);
    if (this._restarts < MAX_RESTARTS) {
      this._restarts++;
      this._setState('idle');
      setTimeout(() => this._startWorker(), RESTART_DELAY_MS);
    } else {
      this._setState('error');
      this._queue.flush('Runtime crashed and exceeded restart limit');
    }
  }

  _rejectAll(reason) {
    for (const [id, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this._pending.clear();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Run inference. Returns Promise<{ text, tokens, latencyMs, provider, model }>.
   * If opts.onToken is provided, it's called for each streaming token.
   *
   * @param {string} prompt
   * @param {{ maxTokens?, temperature?, stop?, model?, onToken? }} opts
   */
  infer(prompt, opts = {}) {
    if (this._state === 'stopped' || this._state === 'error') {
      return Promise.reject(new Error(`Runtime is ${this._state} — cannot infer`));
    }

    return this._queue.enqueue(() => {
      // Ensure worker is started
      if (this._state === 'idle' || this._state === 'error') this._startWorker();

      return new Promise((resolve, reject) => {
        const waitReady = (cb) => {
          if (this._state === 'ready') return cb();
          if (this._state === 'starting') {
            this._readyCallbacks.push(cb);
          } else {
            reject(new Error(`Runtime state is "${this._state}", cannot infer`));
          }
        };

        waitReady(() => {
          const id = ++this._idCounter;
          this._setState('busy');

          const timer = setTimeout(() => {
            this._pending.delete(id);
            if (this._state === 'busy') this._setState('ready');
            reject(new Error(`Inference timed out after ${INFER_TIMEOUT_MS / 1000}s`));
          }, INFER_TIMEOUT_MS);

          this._pending.set(id, { resolve, reject, timer, onToken: opts.onToken });
          this._worker.postMessage({ type: 'infer', id, prompt, opts });
        });
      });
    });
  }

  /**
   * Graceful shutdown. Waits for any in-flight inference to complete.
   * @param {{ force?: boolean }} opts
   */
  async shutdown({ force = false } = {}) {
    if (this._state === 'stopped') return;
    this._setState('stopping');
    this._queue.flush('Shutting down');
    if (this._worker) {
      this._worker.postMessage({ type: 'shutdown' });
      if (force) {
        await this._worker.terminate();
      } else {
        await new Promise(r => setTimeout(r, 4000));
        try { await this._worker.terminate(); } catch {}
      }
    }
    this._setState('stopped');
  }

  onError(cb) { this._errorCallbacks.push(cb); }
}

// ── Singleton manager ─────────────────────────────────────────────────────────
// One supervisor per (entryAbsPath, modelAbsPath) pair. Swapping models
// shuts down the current supervisor and mints a new one.

let _supervisor = null;
let _supervisorKey = '';

/**
 * Get or create the singleton supervisor for the given runtime+model pair.
 * If the model changes, the old supervisor is shut down first.
 */
async function getSupervisor({ entryAbsPath, modelAbsPath, contextSize, ngl } = {}) {
  const key = `${entryAbsPath}::${modelAbsPath}`;
  if (_supervisor && _supervisorKey !== key) {
    await _supervisor.shutdown({ force: false });
    _supervisor = null;
    _supervisorKey = '';
  }
  if (!_supervisor) {
    _supervisor = new Supervisor({ entryAbsPath, modelAbsPath, contextSize, ngl });
    _supervisorKey = key;
  }
  return _supervisor;
}

/**
 * Shut down the current supervisor (called on server shutdown).
 */
async function shutdownSupervisor() {
  if (_supervisor) {
    await _supervisor.shutdown({ force: false });
    _supervisor = null;
    _supervisorKey = '';
  }
}

module.exports = { Supervisor, getSupervisor, shutdownSupervisor };
