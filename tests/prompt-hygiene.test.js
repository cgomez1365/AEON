// Prompt hygiene — no operator-specific data may be baked into a shipped prompt.
//
// The AEON_CORTEX_V4 system prompt in NeuralTerminal.jsx shipped with one
// operator's loan principal, daily interest and accrued interest interpolated
// into EVERY model request, under the heading "LIVE FINANCIAL TELEMETRY". Every
// customer's assistant would have been primed with somebody else's finances.
//
// User data reaches the model through retrieved context and memory. A prompt
// template describes AEON's role — it is not a place to carry a person.
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'src');

/** Every .js/.jsx/.cjs under src/, excluding build output. */
function sourceFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (/\.(js|jsx|cjs|mjs)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

// Each entry: a pattern that must not appear, and why it is banned.
const BANNED = [
  [/LIVE FINANCIAL TELEMETRY/i, 'operator financial telemetry block inside a model prompt'],
  [/Daily Interest Bleed/i, 'operator debt figure inside a model prompt'],
  [/Base Loan Principal/i, 'operator debt figure inside a model prompt'],
  [/System Deficit/i, 'operator debt figure inside a model prompt'],
  [/\?\?\s*9\.41/, "one operator's real daily interest as a default for every user"],
];

describe('shipped prompts carry no operator-specific data', () => {
  const files = sourceFiles(SRC);

  it('finds source files to scan (guards against a silently empty scan)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  for (const [pattern, why] of BANNED) {
    it(`no source file contains ${pattern} — ${why}`, () => {
      const hits = [];
      for (const f of files) {
        // Strip comments: this repo documents its own past defects on purpose,
        // and an explanation naming the removed text must not fail the gate.
        const code = fs.readFileSync(f, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        if (pattern.test(code)) hits.push(path.relative(SRC, f));
      }
      expect(hits, `banned pattern found in: ${hits.join(', ')}`).toEqual([]);
    });
  }
});
