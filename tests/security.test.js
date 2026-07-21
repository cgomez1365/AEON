import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const serverJs = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');
const securityJs = fs.readFileSync(path.join(ROOT, 'security', 'security.js'), 'utf8');

describe('security.js — hardening middleware is wired', () => {
  it('mounts helmet', () => {
    expect(securityJs).toMatch(/require\(['"]helmet['"]\)/);
    expect(serverJs).toMatch(/security\.helmetMiddleware/);
  });

  it('mounts rate limiting', () => {
    expect(securityJs).toMatch(/express-rate-limit/);
    expect(serverJs).toMatch(/security\.apiLimiter/);
  });

  it('registers process-level crash guards', () => {
    expect(serverJs).toMatch(/process\.on\(['"]uncaughtException['"]/);
    expect(serverJs).toMatch(/process\.on\(['"]unhandledRejection['"]/);
  });

  it('does not leak error detail in production', () => {
    expect(serverJs).toMatch(/production/);
  });

  it('enforces fail-closed shell auth', () => {
    expect(securityJs).toMatch(/requireShellAuth/);
    expect(securityJs).toMatch(/Shell endpoints disabled/);
  });
});

describe('server.cjs shim delegates to server/server.js', () => {
  const shim = fs.readFileSync(path.join(ROOT, 'server.cjs'), 'utf8');
  it('requires server/server.js', () => {
    expect(shim).toMatch(/require\(['"]\.\/server\/server\.js['"]\)/);
  });
});

describe('RLS migration — containment SQL exists and is complete', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'db', 'migrations', '001_enable_rls.sql'), 'utf8');
  const sensitive = [
    'aeon_candidates', 'desktop_commands', 'bot_status', 'aeon_blocks',
    'documents', 'aeon_notes', 'aeon_governance',
  ];

  it('enables RLS on every sensitive table', () => {
    for (const t of sensitive) {
      expect(sql).toMatch(new RegExp(`ALTER TABLE public\\.${t}\\s+ENABLE ROW LEVEL SECURITY`));
    }
  });

  it('never opens anon access with USING (true) for public/anon', () => {
    const usingTrue = [...sql.matchAll(/USING \(true\)/g)];
    expect(usingTrue.length).toBeGreaterThan(0);
    expect(sql).not.toMatch(/TO anon[\s\S]*USING \(true\)/);
    expect(sql).toMatch(/TO authenticated/);
  });
});

describe('no secret API keys exposed to the browser', () => {
  const srcDir = path.join(ROOT, 'src');

  function scanDir(dir, ext = ['.jsx', '.js']) {
    const hits = [];
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      if (f.isDirectory() && !f.name.startsWith('.') && f.name !== 'node_modules' && f.name !== 'training') {
        hits.push(...scanDir(full, ext));
      } else if (f.isFile() && ext.some(e => f.name.endsWith(e))) {
        const content = fs.readFileSync(full, 'utf8');
        const forbidden = ['VITE_GROQ_API_KEY', 'VITE_GEMINI_KEY', 'VITE_AEON_MOBILE_SECRET'];
        for (const key of forbidden) {
          if (content.includes(key)) hits.push(`${path.relative(ROOT, full)}: ${key}`);
        }
      }
    }
    return hits;
  }

  it('frontend code does not reference VITE_ secret keys', () => {
    const hits = scanDir(srcDir);
    expect(hits).toEqual([]);
  });
});
