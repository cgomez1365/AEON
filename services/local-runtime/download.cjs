'use strict';
/**
 * BO-A0 — the ONE download implementation for the native local runtime.
 *
 * This replaces byte-identical copies that lived in runtime-installer.cjs and
 * model-installer.cjs. Both are the only callers. Every fix below had to land
 * twice before, which is exactly how they drifted.
 *
 * What the previous implementation did on a redirect:
 *
 *   file.close(() => fs.unlinkSync(destPath));           // async
 *   return download(res.headers.location, destPath, …);  // fires immediately
 *
 * Two defects compounding:
 *
 *   1. RACE — the recursive call reopened destPath with 'wx' (fail-if-exists)
 *      before the unlink in the close callback had run, so the retry died with
 *      EEXIST.
 *   2. UNHANDLED ERROR — `file.on('error')` was registered only on the 200
 *      branch. The redirect branch returned early, so that failing stream had
 *      no listener at all: an unhandled 'error' event, which in Node takes the
 *      whole process down. Not a failed download — a killed kernel.
 *
 * Every GitHub release URL and every resolvable Hugging Face model URL answers
 * 302, so this fired on 100% of real installs.
 *
 * Invariants now:
 *   - the error handler is attached before any branching
 *   - the file handle is closed and unlinked, awaited, before the next hop
 *   - 301/302/303/307/308 are all followed (both hosts use several)
 *   - an https→http downgrade is refused outright
 *   - redirects are capped, so a loop fails bounded instead of blowing the stack
 *
 * Hash verification catches tampering after the fact. Refusing the downgrade is
 * what stops the request being made in cleartext in the first place.
 */

const fs = require('fs');
const https = require('https');
const http = require('http');
const { createWriteStream } = require('fs');
const { URL } = require('url');

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 120_000;

/** Remove a partial download, best-effort. */
function unlinkQuiet(p) {
  try { fs.unlinkSync(p); } catch { /* never existed, or already gone */ }
}

/**
 * Close a write stream and remove its file, resolving only once both are done.
 * The awaited close is what makes the next hop's 'wx' open safe.
 *
 * `owned` guards the unlink: the 'wx' flag means an EEXIST error fires before
 * we ever hold the file, and deleting on that path would destroy whatever was
 * already at destPath — the exact opposite of what fail-if-exists is for. We
 * only remove files this download created.
 */
function closeAndRemove(file, destPath, owned) {
  return new Promise((resolve) => {
    const finish = () => { if (owned()) unlinkQuiet(destPath); resolve(); };
    if (file.destroyed || file.closed) return finish();
    file.close(finish);
  });
}

/**
 * Resolve a Location header against the URL it came from, and refuse any
 * transport downgrade.
 *
 * A relative Location is legal (RFC 7231) and Hugging Face's CDN uses them.
 */
function resolveRedirect(fromUrl, location) {
  if (!location) throw new Error(`Redirect with no Location header: ${fromUrl}`);
  const from = new URL(fromUrl);
  const to = new URL(location, from);
  if (from.protocol === 'https:' && to.protocol === 'http:') {
    throw new Error(`Refusing https→http downgrade: ${from.host} → ${to.host}`);
  }
  if (to.protocol !== 'https:' && to.protocol !== 'http:') {
    throw new Error(`Refusing non-HTTP redirect target: ${to.protocol}//${to.host}`);
  }
  return to.toString();
}

/**
 * Download a URL to destPath, streaming, following redirects safely.
 *
 * @param {string} url
 * @param {string} destPath                       must not already exist
 * @param {object} [opts]
 * @param {(pct:number, bytes:number, total:number)=>void} [opts.onProgress]
 * @param {number} [opts.timeoutMs]               per-hop socket timeout
 * @param {number} [opts.maxRedirects]
 * @returns {Promise<{url:string, bytes:number, redirects:number}>}
 */
function download(url, destPath, opts = {}) {
  const {
    onProgress,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRedirects = MAX_REDIRECTS,
  } = opts;

  return new Promise((resolve, reject) => {
    let redirects = 0;

    const attempt = (currentUrl) => {
      let proto;
      try {
        proto = new URL(currentUrl).protocol === 'https:' ? https : http;
      } catch {
        return reject(new Error(`Malformed download URL: ${String(currentUrl).slice(0, 200)}`));
      }

      const file = createWriteStream(destPath, { flags: 'wx' });
      let settled = false;
      // Set once the 'wx' open succeeds — i.e. once destPath is ours to delete.
      let created = false;
      const owned = () => created;
      file.on('open', () => { created = true; });

      // Attached BEFORE any branch. An unhandled 'error' on this stream is what
      // used to kill the process; there is now no code path where it is unheard.
      const failWith = (err) => {
        if (settled) return;
        settled = true;
        closeAndRemove(file, destPath, owned).then(() => reject(err));
      };
      file.on('error', failWith);

      const req = proto.get(currentUrl, { timeout: timeoutMs }, (res) => {
        const code = res.statusCode;

        if (REDIRECT_CODES.has(code)) {
          res.resume(); // drain, or the socket is held open
          if (redirects >= maxRedirects) {
            return failWith(new Error(`Too many redirects (>${maxRedirects}) starting at ${url}`));
          }
          let next;
          try { next = resolveRedirect(currentUrl, res.headers.location); }
          catch (e) { return failWith(e); }
          redirects += 1;
          if (settled) return;
          settled = true;
          // Await the close+unlink before reopening with 'wx'. This ordering is
          // the fix for the EEXIST race; do not make it fire-and-forget.
          return closeAndRemove(file, destPath, owned).then(() => {
            settled = false;
            attempt(next);
          });
        }

        if (code !== 200) {
          res.resume();
          return failWith(new Error(`Download failed: HTTP ${code} for ${currentUrl}`));
        }

        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;

        res.on('error', failWith);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (onProgress && total) onProgress(Math.round(received / total * 100), received, total);
        });

        res.pipe(file);

        file.on('finish', () => {
          if (settled) return;
          settled = true;
          file.close(() => resolve({ url: currentUrl, bytes: received, redirects }));
        });
      });

      req.on('error', failWith);
      req.on('timeout', () => {
        req.destroy();
        failWith(new Error(`Download timed out after ${timeoutMs}ms: ${currentUrl}`));
      });
    };

    attempt(url);
  });
}

module.exports = { download, resolveRedirect, REDIRECT_CODES, MAX_REDIRECTS, DEFAULT_TIMEOUT_MS };
