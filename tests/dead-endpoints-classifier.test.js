/**
 * The dead-endpoint sweep's classification rules.
 *
 * The tool itself needs a booted instance, so it is not part of the suite. Its
 * DECISION RULES can be checked here, and they are the part that has been wrong
 * twice in one afternoon:
 *
 *   1. It classified every 404 as a dead route, contradicting its own header
 *      ("a mounted handler answers 404 with JSON"). That reported 17 live
 *      routes as missing — including /api/auth/login, whose
 *      {"error":"No account configured"} is a mounted route doing its job.
 *
 *   2. Fixing it, I wrote the regex with a DOUBLE backslash — /Cannot\\s+/ —
 *      which matches a literal backslash, never whitespace. The sweep then
 *      reported 0 dead while two routes were genuinely unmounted. A gate that
 *      cannot fail is worse than the false positives it replaced.
 *
 * So this pins the regex itself, not a paraphrase of it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(__dirname, '..', 'tools', 'stress', 'dead-endpoints.mjs');
const src = fs.readFileSync(TOOL, 'utf8');

/** Pull the live regex literal out of the tool and use THAT — not a copy. */
function unmountedRegex() {
  const m = src.match(/unmounted = (\/Cannot[^\n]*?\/i)\.test\(body\)/);
  if (!m) throw new Error('could not find the unmounted regex in the tool');
  // eslint-disable-next-line no-eval
  return eval(m[1]);
}

const EXPRESS_404_HTML =
  '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n' +
  '</head>\n<body>\n<pre>Cannot POST /api/memory/tidy</pre>\n</body>\n</html>\n';

describe('the unmounted-route discriminator', () => {
  const re = unmountedRegex();

  it('matches a real Express "Cannot POST" page', () => {
    expect(re.test(EXPRESS_404_HTML)).toBe(true);
  });

  it('matches every method Express can report', () => {
    for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      expect(re.test(`<pre>Cannot ${m} /api/x</pre>`), m).toBe(true);
    }
  });

  it('does NOT match a mounted handler answering 404 with JSON', () => {
    expect(re.test('{"error":"No account configured"}')).toBe(false);
    expect(re.test('{"error":"not found"}')).toBe(false);
  });

  it('is written with a single backslash — the bug that made it unable to fail', () => {
    // /Cannot\\s+/ matches a literal backslash. It silently turned the gate
    // into one that reports 0 dead no matter what.
    expect(src).not.toMatch(/Cannot\\\\s/);
    expect(src).toMatch(/Cannot\\s\+/);
  });
});

describe('what the sweep must keep separate', () => {
  it('classifies DEAD from unmounted, not from a bare 404', () => {
    expect(src).toMatch(/const allDead\s*=\s*results\.filter\(r => r\.unmounted === true \|\| r\.html === true\)/);
    expect(src).not.toMatch(/filter\(r => r\.status === 404 \|\| r\.html === true\)/);
  });

  it('separates dynamic-segment paths, which cannot be verified literally', () => {
    // /api/${w.id}/safe-mode is real — /api/host_os/safe-mode is mounted —
    // but the substituted /api/probe/safe-mode never is.
    expect(src).toMatch(/const dynamic = /);
    expect(src).toMatch(/DYNAMIC PATH, not literally verifiable/);
  });

  it('separates calls inside modules nothing imports', () => {
    // src/components/NeuralTerminal.jsx was replaced by Terminal2 and kept as
    // reference. Its stale calls cannot fire, so reporting them as live
    // defects sends someone hunting a bug that does not exist.
    expect(src).toMatch(/isReachable/);
    expect(src).toMatch(/DEAD CALL IN AN UNREACHABLE MODULE/);
  });

  it('states that skipped endpoints were not verified', () => {
    // 26 destructive endpoints are never called, including all of /api/build/.
    // "DEAD 0" must not read as "all 156 verified".
    expect(src).toMatch(/none of these were verified/);
  });
});
