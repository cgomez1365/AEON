/**
 * The Vite dev server (`npm start`) listens on this machine only.
 *
 * Its proxy forwards /api, /block, /core, /events and /ws to AEON from
 * 127.0.0.1, rewrites Host to AEON's own (changeOrigin) and adds no
 * forwarding headers (no xfwd). To AEON, everything it relays was made on
 * this machine. With `host: true` (fe93dbf) it listened on every interface:
 * measured 2026-09-30, temp home, no account, AEON on 3361 and Vite on 3362
 * with the repo's config, `curl` with no Origin from the LAN address took
 * POST /api/auth/reauth's token and then /api/settings/export-credentials,
 * vault master key included. Bound to 127.0.0.1, the same curl is refused at
 * connect, and localhost / 127.0.0.1 still reach AEON through the proxy.
 *
 * Starting Vite here would write its cache into the install, so this reads
 * the setting Vite listens on, the one value that decides it.
 */
import { describe, expect, it } from 'vitest';
import net from 'net';
import config from '../vite.config.js';

// Vite's own reading of server.host: undefined/false is 'localhost', true is
// every interface, a string is that address or name.
function listensOnLoopbackOnly(host) {
  if (host === undefined || host === false) return true;
  if (host === true) return false;
  const h = String(host).replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost') return true;
  if (net.isIPv4(h)) return /^127\./.test(h);
  if (net.isIPv6(h)) return h === '::1';
  return false; // a DNS name could resolve anywhere
}

describe('vite.config.js dev server bind', () => {
  it('listens on loopback only, never every interface', () => {
    expect(config.server).toBeTruthy();
    expect(listensOnLoopbackOnly(config.server.host), `server.host = ${JSON.stringify(config.server.host)}`).toBe(true);
  });

  it('listens on 127.0.0.1, so http://127.0.0.1:3000 (a dev origin AEON trusts) answers', () => {
    // 'localhost' would bind ::1 alone on macOS (Node returns ::1 first).
    expect(config.server.host).toBe('127.0.0.1');
  });

  it('the rule above tells the dangerous values apart', () => {
    for (const h of [true, '0.0.0.0', '::', '192.168.0.209', 'my-mac.local']) expect(listensOnLoopbackOnly(h), String(h)).toBe(false);
    for (const h of ['127.0.0.1', '::1', '[::1]', 'localhost', undefined]) expect(listensOnLoopbackOnly(h), String(h)).toBe(true);
  });

  it('still proxies the API to AEON on 127.0.0.1', () => {
    for (const p of ['/api', '/block', '/core', '/events', '/ws']) {
      expect(config.server.proxy[p].target, p).toBe('http://127.0.0.1:3001');
    }
    expect(config.server.proxy['/ws'].ws).toBe(true);
  });
});
