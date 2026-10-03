# Security policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability**, or go straight to
<https://github.com/cgomez1365/AEON/security/advisories/new>. Only the maintainer can see
the report.

Please include:

- what an attacker can do, and what they need first (local access, a crafted file, a
  malicious block, a network position)
- the smallest steps that reproduce it
- the release you downloaded (for example v3.2.0), or for a `git clone` the commit
  (`git log --oneline -1`); your OS and your Node.js version

AEON has one maintainer. Reports are read and answered as fast as that allows; there is
no promised response time, and none is claimed here.

## Supported versions

Fixes land on `main` and in the next release. Older releases are not patched.

| Version | Supported |
|---|---|
| 3.2.x | Yes |
| 3.1.x and older | No — upgrade to the [latest release](https://github.com/cgomez1365/AEON/releases/latest) |

3.0.0 lacks security fixes made since (among them an auth-guard bypass and an
unauthenticated `/ws` socket). See *Updating AEON* in the [README](../README.md#updating-aeon).

## What AEON does and does not claim

The protections AEON makes — an encrypted vault, keys that never reach the browser,
auth-gated block routes, declared and audited filesystem access, no telemetry — are
described with their limits in [`docs/SECURITY.md`](../docs/SECURITY.md).

One limit matters for reports: **blocks share a Node.js process.** A block manifest
governs what the kernel hands a block; it is not a sandbox against hostile code. A block
you install yourself doing something harmful is that known limit, not a new
vulnerability. A way for something *other* than a block you chose to reach the vault,
your keys, or files outside a block's declared scope is exactly what this policy is for.
