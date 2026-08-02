// Execution surface — AEON must not run a client-supplied string through a shell.
//
// Six routes did. Four are deleted (/os/agent-shell, /os/shell, /os/execute,
// /os-bridge); /exec became typed named actions; /model/serve and /os/open now
// pass argument arrays. The value of this file is that it fails if any of that
// comes back — including via a route nobody is looking at.
//
// It reads the real source. A behavioural test cannot prove the ABSENCE of a
// dangerous construct across the repo; a scan can.
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const { isInside, insideAny } = require('../src/kernel/pathContainment.cjs');

/** Source files under a directory, excluding build output and deps. */
function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (/\.(js|cjs|mjs)$/.test(e.name)) acc.push(full);
  }
  return acc;
}

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('no block API can reach a shell', () => {
  const blockApis = walk(path.join(ROOT, 'src', 'blocks'))
    .filter(f => f.includes(`${path.sep}api${path.sep}`));

  it('scans a meaningful number of block API files', () => {
    expect(blockApis.length).toBeGreaterThan(20);
  });

  it('no block API file calls exec() or execSync() on a built string', () => {
    const hits = [];
    for (const f of blockApis) {
      const code = stripComments(fs.readFileSync(f, 'utf8'));
      // execFile/execFileSync are fine — they take an argument array. A regex's
      // own .exec() is not process execution either.
      if (/(?<![.\w])exec(Sync)?\s*\(/.test(code)) hits.push(path.relative(ROOT, f));
    }
    expect(hits, `shell exec found in: ${hits.join(', ')}`).toEqual([]);
  });

  it('no block API file spawns with shell:true or launches a shell with -c', () => {
    // Line-based so a trailing `aeon-shell-allow: <reason>` annotation can grant
    // a reviewed exception — the same idiom the path-authority scanner uses. An
    // exception must be visible in the diff and carry a reason; a scan with no
    // escape hatch just gets weakened the first time it is inconvenient.
    const hits = [];
    for (const f of blockApis) {
      const raw = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      const lines = raw.split('\n');
      lines.forEach((line, i) => {
        if (line.trim().startsWith('//')) return;
        // The annotation may sit on the line itself or in the comment directly
        // above it, which is where a reason long enough to be useful belongs.
        const scope = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
        if (scope.includes('aeon-shell-allow')) return;
        const where = `${path.relative(ROOT, f)}:${i + 1}`;
        if (/shell\s*:\s*true/.test(line)) hits.push(`${where} (shell:true)`);
        // Launching a SHELL with -c is the dangerous shape. `python -c <script>`
        // is an interpreter with an argument array — no shell, nothing reparses.
        if (/spawn\w*\(\s*[^,)]*\b(bash|sh|zsh|cmd(\.exe)?|powershell(\.exe)?)\b[^,)]*,\s*\[\s*['"`][-/]c/i.test(line)) {
          hits.push(`${where} (shell -c)`);
        }
      });
    }
    expect(hits, `shell spawn found at: ${hits.join(', ')}`).toEqual([]);
  });

  it('every shell exception carries a written reason', () => {
    const annotated = [];
    for (const f of walk(path.join(ROOT, 'src'))) {
      fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (!line.includes('aeon-shell-allow')) return;
        annotated.push({ where: `${path.relative(ROOT, f)}:${i + 1}`, line });
      });
    }
    const unexplained = annotated
      .filter(a => !/aeon-shell-allow:\s*\S+/.test(a.line))
      .map(a => a.where);
    expect(unexplained, `annotation without a reason: ${unexplained.join(', ')}`).toEqual([]);
  });

  it('the deleted routes are gone from source', () => {
    const os = stripComments(fs.readFileSync(
      path.join(ROOT, 'src', 'blocks', 'host_os', 'api', 'os.cjs'), 'utf8'));
    for (const route of ['/os/agent-shell', '/os/shell', '/os/execute', '/os-bridge']) {
      expect(os, `${route} must not be registered`).not.toContain(`'${route}'`);
    }
    // /exec was replaced by typed actions, not kept alongside them.
    expect(os).not.toMatch(/router\.post\(\s*['"]\/exec['"]/);
    expect(os).toMatch(/router\.post\(\s*['"]\/os\/action['"]/);
  });

  it('no frontend still calls a deleted execution route', () => {
    const hits = [];
    for (const f of walk(path.join(ROOT, 'src'))
      .concat(walk(path.join(ROOT, 'src')).filter(x => x.endsWith('.jsx')))) {
      const code = stripComments(fs.readFileSync(f, 'utf8'));
      for (const route of ['/api/os/shell', '/api/os/execute', '/api/os/agent-shell', '/api/os-bridge', '/api/exec']) {
        if (code.includes(`'${route}'`) || code.includes(`"${route}"`)) {
          hits.push(`${path.relative(ROOT, f)} → ${route}`);
        }
      }
    }
    expect(hits, `dead execution call sites: ${hits.join(', ')}`).toEqual([]);
  });
});

describe('path containment is not a string prefix', () => {
  it('a sibling directory sharing a name prefix is refused', () => {
    // The case that motivated this: C:\Users\Alexandra vs C:\Users\Alex.
    expect(isInside('/home/alex', '/home/alexandra/secrets')).toBe(false);
    expect(isInside('/home/alex', '/home/alex/notes.md')).toBe(true);
    expect(isInside('/data/vault', '/data/vault-backup/x')).toBe(false);
  });

  it('traversal out of the root is refused', () => {
    expect(isInside('/data/vault', '/data/vault/../etc/passwd')).toBe(false);
    expect(isInside('/data/vault', '/data/vault/sub/../ok.md')).toBe(true);
  });

  it('the root itself requires allowRoot', () => {
    expect(isInside('/data/vault', '/data/vault')).toBe(false);
    expect(isInside('/data/vault', '/data/vault', { allowRoot: true })).toBe(true);
  });

  it('rejects malformed input rather than defaulting to allow', () => {
    expect(isInside('', '/x')).toBe(false);
    expect(isInside('/x', '')).toBe(false);
    expect(isInside(null, undefined)).toBe(false);
  });

  it('insideAny returns the matching root, or null', () => {
    expect(insideAny(['/a', '/b'], '/b/file')).toBe('/b');
    expect(insideAny(['/a', '/b'], '/c/file')).toBe(null);
    expect(insideAny(null, '/a/x')).toBe(null);
  });

  it('no source file authorizes a path with startsWith()', () => {
    const files = [
      ...walk(path.join(ROOT, 'src')),
      ...walk(path.join(ROOT, 'services')),
      ...walk(path.join(ROOT, 'server')),
    ];
    const hits = [];
    for (const f of files) {
      if (f.endsWith('pathContainment.cjs')) continue;
      const code = stripComments(fs.readFileSync(f, 'utf8'));
      // A containment check compares a resolved path against a ROOT-ish name.
      const re = /\b\w*(?:resolved|resolvedPath|full|target|candidate|p)\b\s*\.startsWith\(\s*(\w*(?:ROOT|root|DIR|dir)\w*)\s*\)/g;
      let m;
      while ((m = re.exec(code))) hits.push(`${path.relative(ROOT, f)} → startsWith(${m[1]})`);
    }
    expect(hits, `string-prefix containment: ${hits.join(', ')}`).toEqual([]);
  });
});

describe('local-only decisions read the socket, never the Host header', () => {
  it('no route branches on req.get("host") or req.headers.host for authorization', () => {
    const files = [
      ...walk(path.join(ROOT, 'src')),
      ...walk(path.join(ROOT, 'security')),
      ...walk(path.join(ROOT, 'server')),
    ];
    const hits = [];
    for (const f of files) {
      const code = stripComments(fs.readFileSync(f, 'utf8'));
      // Building an absolute URL from the Host header is fine; deciding trust
      // from it is not. The tell is a localhost/127.0.0.1 comparison.
      const lines = code.split('\n');
      lines.forEach((line, i) => {
        if (!/req\.get\(\s*['"]host['"]\s*\)|req\.headers\.host/.test(line)) return;
        const window = lines.slice(i, i + 4).join(' ');
        if (/localhost|127\.0\.0\.1/.test(window) && !/https?:\/\//.test(line)) {
          hits.push(`${path.relative(ROOT, f)}:${i + 1}`);
        }
      });
    }
    expect(hits, `Host-header trust decision at: ${hits.join(', ')}`).toEqual([]);
  });
});
