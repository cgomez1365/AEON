/**
 * Private operational roots must be unstageable.
 *
 * Marathon audit 2026-08-11, P0-04: `git check-ignore` matched NOTHING for
 * `models/`, `vault/`, `Vault/` or the runtime JSON that lands in `db/`. A
 * locally installed model or a Vault credential could be staged by an ordinary
 * `git add`, and `db/` otherwise holds tracked schema files, so a runtime write
 * there looks like it belongs.
 *
 * Deleting a file does not revoke a credential — it destroys the record of
 * which one to revoke. The cheaper property is never committing it.
 *
 * This gate exists because .gitignore is edited by hand and the protection is
 * invisible when it works. Both casings are asserted deliberately: gitignore
 * matching is case-sensitive on Linux and insensitive on Windows/macOS, and
 * AEON claims all three platforms.
 *
 * Proven able to fail: commenting out BOTH `vault/` and `Vault/` turns the two
 * vault assertions red, naming the paths.
 *
 * Known coverage limit, stated rather than implied: on a case-insensitive
 * filesystem (Windows, default macOS) the two casings are one rule, so removing
 * only `vault/` leaves this gate green. The first falsifiability attempt did
 * exactly that and passed, which is why both casings are asserted AND both must
 * be removed to prove failure. Only a Linux CI leg can distinguish them — until
 * that leg runs, treat the casing pair as belt-and-braces, not as verified
 * per-casing coverage.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import path from 'path';

const ROOT = path.join(__dirname, '..');

/** True when git would ignore `p`. --no-index so the file need not exist. */
function isIgnored(p) {
  try {
    execFileSync('git', ['check-ignore', '--no-index', '-q', '--', p], {
      cwd: ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

describe('private operational roots are ignored', () => {
  const mustBeIgnored = [
    'models/weights.gguf',
    'Models/weights.gguf',
    'vault/secret.json',
    'Vault/blocks/security/local_auth.json',
    'db/aeon-roles.json',
    'db/aeon-block-runstate.json',
  ];

  it.each(mustBeIgnored)('ignores %s', (p) => {
    expect(isIgnored(p), `${p} is stageable — a private root is unprotected`).toBe(true);
  });

  // The inverse half. An over-broad rule that swallowed the tracked schema
  // files would "pass" the checks above while quietly removing real files from
  // the working tree on the next clean checkout.
  it('does not ignore any tracked file', () => {
    const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);

    let ignored = [];
    try {
      const out = execFileSync('git', ['check-ignore', '--stdin'], {
        cwd: ROOT,
        input: tracked.join('\n'),
        encoding: 'utf8',
      });
      ignored = out.split('\n').filter(Boolean);
    } catch {
      // check-ignore exits 1 when nothing matches, which is the passing case.
    }

    expect(ignored, 'tracked files matched an ignore rule').toEqual([]);
  });

  it('keeps the tracked retrieval scopes visible under db/', () => {
    expect(isIgnored('db/retrieval/_scopes.json')).toBe(false);
  });
});
