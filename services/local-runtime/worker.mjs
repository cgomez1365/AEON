/**
 * Phase 5 — llama.cpp worker (ESM, runs in Node worker_threads).
 *
 * This module is the ONLY place that spawns the llama.cpp process.
 * It owns the child process lifecycle: spawn, health check, token streaming,
 * and graceful shutdown. The supervisor (supervisor.cjs) controls when to
 * spawn; this worker just owns the IPC session with the binary.
 *
 * Protocol (parentPort message API):
 *   parent → worker:
 *     { type: 'infer', id, prompt, opts }
 *     { type: 'shutdown' }
 *   worker → parent:
 *     { type: 'ready' }                         — binary spawned and health-checked
 *     { type: 'token', id, t }                  — SSE vocabulary from Phase 0 ADR
 *     { type: 'done', id, text, tokens, latencyMs, provider, model }
 *     { type: 'error', id, error }
 *     { type: 'exit', code }                    — process exited
 *
 * llama.cpp is run in --server mode on a UNIX socket / named pipe (no TCP).
 * On Windows: named pipe \\.\pipe\aeon-llama-{pid}
 * On POSIX:   /tmp/aeon-llama-{pid}.sock
 * This avoids binding a TCP port that could conflict with Ollama or anything
 * else on localhost:11434 (or any port), and means no firewall prompt on
 * Windows.
 */

import { parentPort, workerData } from 'worker_threads';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import net from 'net';
import path from 'path';
import os from 'os';

const require = createRequire(import.meta.url);

const { entryAbsPath, modelAbsPath, contextSize = 4096, ngl = 0 } = workerData;

const isWin = os.platform() === 'win32';
const pipePath = isWin
  ? `\\\\.\\pipe\\aeon-llama-${process.pid}`
  : path.join(os.tmpdir(), `aeon-llama-${process.pid}.sock`);

let child = null;
let childReady = false;
let shutdownRequested = false;

// ── Safety: absolute path only, no shell ─────────────────────────────────────
if (!path.isAbsolute(entryAbsPath)) {
  parentPort.postMessage({ type: 'error', id: null, error: `Worker: entryAbsPath must be absolute: ${entryAbsPath}` });
  process.exit(1);
}

// ── Spawn llama.cpp in server mode ───────────────────────────────────────────
function spawnLlama() {
  const args = [
    '--server',
    '--model', modelAbsPath,
    '--ctx-size', String(contextSize),
    '--n-gpu-layers', String(ngl),
    '--no-mmap',
    // Named pipe / Unix socket — no TCP port
    ...(isWin
      ? ['--host', pipePath]
      : ['--host', pipePath, '--port', '0']),
    '--log-disable',  // structured JSON only on stdout
  ];

  child = spawn(entryAbsPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
    // Clean environment — no inherited OLLAMA_* or HOME model paths
    env: {
      PATH: process.env.PATH || '',
      SYSTEMROOT: process.env.SYSTEMROOT || '',
      TEMP: process.env.TEMP || os.tmpdir(),
      TMP: process.env.TMP || os.tmpdir(),
    },
  });

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    // llama.cpp logs "llama server listening" when ready
    if (!childReady && /listening|HTTP server listening/i.test(text)) {
      childReady = true;
      parentPort.postMessage({ type: 'ready' });
    }
  });

  child.stderr.on('data', () => {}); // captured but not forwarded (log-disable)

  child.on('exit', (code, signal) => {
    parentPort.postMessage({ type: 'exit', code: code ?? (signal ? -1 : 0) });
    child = null;
    childReady = false;
  });

  child.on('error', (e) => {
    parentPort.postMessage({ type: 'error', id: null, error: `Worker: spawn error: ${e.message}` });
  });
}

// ── Inference via HTTP over named pipe / Unix socket ─────────────────────────
function runInference(id, prompt, opts) {
  return new Promise((resolve, reject) => {
    const model = opts.model || path.basename(modelAbsPath, '.gguf');
    const body = JSON.stringify({
      prompt,
      n_predict: opts.maxTokens || 512,
      temperature: opts.temperature ?? 0.7,
      top_p: opts.topP ?? 0.9,
      stop: opts.stop || [],
      stream: true,
    });

    const reqHeaders = [
      'POST /completion HTTP/1.1',
      `Host: localhost`,
      'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Accept: text/event-stream',
      '',
      body,
    ].join('\r\n');

    const socket = isWin
      ? net.createConnection(pipePath)
      : net.createConnection(pipePath);

    let fullText = '';
    let tokenCount = 0;
    let buf = '';
    const start = Date.now();

    socket.setTimeout(60_000);

    socket.on('connect', () => {
      socket.write(reqHeaders);
    });

    socket.on('data', (chunk) => {
      buf += chunk.toString();
      // SSE: split on \n\n boundaries
      const parts = buf.split('\n\n');
      buf = parts.pop() || '';
      for (const part of parts) {
        for (const line of part.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const json = line.slice(6).trim();
          if (!json || json === '[DONE]') continue;
          try {
            const evt = JSON.parse(json);
            if (evt.content) {
              fullText += evt.content;
              tokenCount++;
              parentPort.postMessage({ type: 'token', id, t: evt.content });
            }
            if (evt.stop) {
              socket.destroy();
              const latencyMs = Date.now() - start;
              resolve({ text: fullText, tokens: tokenCount, latencyMs, provider: 'local', model });
            }
          } catch {}
        }
      }
    });

    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('Inference timed out after 60s'));
    });

    socket.on('error', (e) => {
      reject(new Error(`Socket error during inference: ${e.message}`));
    });

    socket.on('close', () => {
      if (fullText) {
        const latencyMs = Date.now() - start;
        resolve({ text: fullText, tokens: tokenCount, latencyMs, provider: 'local', model });
      } else {
        reject(new Error('Socket closed before any tokens were received'));
      }
    });
  });
}

// ── Message handler ───────────────────────────────────────────────────────────
parentPort.on('message', async (msg) => {
  if (msg.type === 'shutdown') {
    shutdownRequested = true;
    if (child) {
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child?.kill('SIGKILL'); } catch {} }, 3000);
    }
    return;
  }

  if (msg.type === 'infer') {
    const { id, prompt, opts = {} } = msg;
    if (!childReady) {
      parentPort.postMessage({ type: 'error', id, error: 'Runtime not ready' });
      return;
    }
    try {
      const result = await runInference(id, prompt, opts);
      parentPort.postMessage({ type: 'done', id, ...result });
    } catch (e) {
      parentPort.postMessage({ type: 'error', id, error: e.message });
    }
    return;
  }
});

// ── Boot ─────────────────────────────────────────────────────────────────────
spawnLlama();
