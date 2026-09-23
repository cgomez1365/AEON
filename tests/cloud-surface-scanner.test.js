/**
 * The cloud-surface ratchet must count what the code does, not what its
 * comment stripper happens to swallow.
 *
 * Found 2026-09-22: server/server.js logs the string
 * '[TOKEN HEATMAP] Routes mounted: /api/token-analytics/*'. The scanner removed
 * comments with one regex, read that "/*" as a comment opener, and discarded
 * 135 lines of real code — four isVercel branches — until the "*\/" of an
 * unrelated `/* port already free *\/` comment closed it. The baseline (95) had
 * been four short ever since, and deleting that dead comment made the count
 * "rise" to 99 with no new branch written. A gate whose number moves when a
 * comment is deleted is not measuring code.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { stripNonCode, countIn } = require('../scripts/scan-cloud-surface.cjs');

describe('stripNonCode', () => {
  it('a "/*" inside a string is not a comment (the server.js shape)', () => {
    const src = [
      "console.log('[TOKEN HEATMAP] Routes mounted: /api/token-analytics/*');",
      'if (isVercel) a();',
      'if (isVercel) b();',
      'try { x(); } catch (e) { /* port already free */ }',
      'if (isVercel) c();',
    ].join('\n');
    expect(countIn(src).flagUses).toBe(3);
  });

  it('"//" inside a string (a URL) does not end the line\'s code', () => {
    expect(countIn("const u = 'http://localhost:3001'; if (isVercel) go();").flagUses).toBe(1);
  });

  it('real comments still hide what they contain', () => {
    const src = '// if (isVercel) old();\n/* if (isVercel) older(); */\nif (isVercel) now();';
    expect(countIn(src).flagUses).toBe(1);
  });

  it('template literals: text is not code, ${…} is', () => {
    const src = 'const t = `mode: isVercel /* ${isVercel ? "cloud" : "local"} */`; if (isVercel) x();';
    expect(countIn(src).flagUses).toBe(2);
  });

  it('regex literals are not comments, and division is not a regex', () => {
    const src = [
      'const re = /\\/\\*[\\s\\S]*?\\*\\//g; if (isVercel) a();',
      'const half = total / 2; if (isVercel) b(); const q = n / 4;',
      'return /^\\/api\\/*/.test(p) && isVercel;',
    ].join('\n');
    expect(countIn(src).flagUses).toBe(3);
  });

  it('process.env.VERCEL reads are counted in code, not in strings', () => {
    const src = "const a = process.env.VERCEL; log('process.env.VERCEL_URL is set');";
    expect(countIn(src).envReads).toBe(1);
  });

  it('keeps line count, so reports can name lines', () => {
    const src = 'a\n/* b\nc */\n"d\\n"\n`e\nf`\n';
    expect(stripNonCode(src).split('\n').length).toBe(src.split('\n').length);
  });
});
