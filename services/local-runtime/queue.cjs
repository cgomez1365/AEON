'use strict';
/**
 * Phase 5 — Async request queue.
 *
 * llama.cpp in server mode handles one inference at a time. This queue
 * serializes concurrent callers so the supervisor never sends a second
 * request while one is in-flight. Callers receive a Promise that resolves
 * or rejects when their slot runs.
 *
 * Not a general-purpose concurrency primitive — designed specifically for the
 * single-slot llama.cpp IPC protocol. Max queue depth is enforced; overflow
 * rejects immediately so the UI can show a "busy" state rather than silently
 * stalling for minutes.
 */

const MAX_QUEUE_DEPTH = 8;

class InferenceQueue {
  constructor({ maxDepth = MAX_QUEUE_DEPTH } = {}) {
    this._queue = [];
    this._running = false;
    this._maxDepth = maxDepth;
  }

  /**
   * Enqueue a task. Returns a Promise that resolves/rejects when the task runs.
   * @param {() => Promise<any>} task
   * @returns {Promise<any>}
   */
  enqueue(task) {
    if (this._queue.length >= this._maxDepth) {
      return Promise.reject(new Error(`Inference queue full (${this._maxDepth} pending). Try again shortly.`));
    }
    return new Promise((resolve, reject) => {
      this._queue.push({ task, resolve, reject });
      this._drain();
    });
  }

  async _drain() {
    if (this._running || this._queue.length === 0) return;
    this._running = true;
    const { task, resolve, reject } = this._queue.shift();
    try {
      resolve(await task());
    } catch (e) {
      reject(e);
    } finally {
      this._running = false;
      this._drain();
    }
  }

  get depth() { return this._queue.length; }
  get busy() { return this._running; }

  /** Reject all queued items (called on supervisor shutdown). */
  flush(reason = 'Runtime shutting down') {
    const pending = this._queue.splice(0);
    for (const { reject } of pending) {
      reject(new Error(reason));
    }
  }
}

module.exports = { InferenceQueue, MAX_QUEUE_DEPTH };
