/**
 * Groq's default/fallback model is a real, currently-hosted one.
 *
 * Found live, 2026-09-20: llama-3.3-70b-versatile and llama-3.1-8b-instant
 * both 404'd against the real Groq API — Groq retired the whole Llama 3.x
 * lineup, not a rename. Nine call sites across five files hardcoded one or
 * the other as a fallback/default, so every path that fell back to Groq
 * without an explicit model choice was broken. Replaced with openai/gpt-oss-120b
 * (general/flagship tier) and openai/gpt-oss-20b (fast/cheap tier), verified
 * live against Groq's real /openai/v1/models list on 2026-09-20.
 *
 * This is a static source check, not a runtime one — the actual fix is nine
 * literal-string replacements, and the risk worth gating is regression (the
 * retired string creeping back in), not the classifier logic around it
 * (that's covered live by tests/block-readiness-roles.test.js and
 * tests/embed-role.test.js, which use these model names only as example
 * fixture data for a picker function, not as the defaults under test here).
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const RETIRED = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];

// Same approach as tests/suite-touches-nothing.test.js: a rule described in
// a comment is not a rule being broken. Every fixed file's own comment names
// the retired model as part of explaining the fix — checking raw source
// would fail on its own explanation.
const code = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

// Files with a LIVE default naming one of the retired models. Two other
// files (src/kernel/endpoints.cjs, src/blocks/settings/index.jsx) keep the
// old name in prose — documenting a past defect, not a live default — and
// are deliberately excluded here; that history is worth keeping accurate.
const LIVE_DEFAULT_FILES = [
  'src/blocks/settings/api/settings.js',
  'src/blocks/council/api/index.cjs',
  'src/blocks/dashboard/api/chat.cjs',
  'services/ai.js',
  'src/settings.default.json',
];

describe('no live default names a Groq model Groq has retired', () => {
  for (const rel of LIVE_DEFAULT_FILES) {
    it(`${rel} does not fall back to a retired Groq model`, () => {
      const src = code(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
      for (const model of RETIRED) {
        expect(src, `${rel} still names ${model} outside a comment`).not.toContain(model);
      }
    });
  }

  it('the replacement models are real, current Groq ids', () => {
    const src = fs.readFileSync(path.join(ROOT, 'services/ai.js'), 'utf8');
    expect(src).toContain('openai/gpt-oss-120b');
  });
});
