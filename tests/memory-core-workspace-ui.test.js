/**
 * 3.3.0 — Memory Core shows an agent's scratchpad and handoffs, and its
 * New agent example is generic.
 *
 * The New agent persona example is generic (F5). The 3.2 example is never
 * quoted here, only its SHA-256.
 * The scratchpad and handoffs live in the agent's folder (agentWorkspace.cjs)
 * and are served by memory_core's routes; the panel must call those routes and
 * say the 2,000-character cap.
 *
 * Text only: the component cannot be rendered here (environment: 'node').
 */
import { describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'blocks', 'memory_core', 'index.jsx'), 'utf8');

describe('the New agent persona example', () => {
  // SHA-256 of the old example: the sentence alone, and as it stood in the
  // placeholder attribute (with its "e.g. " prefix).
  const OLD = [
    { length: 74, sha256: 'd427d72e55882a7bfdab38126c0207316dd9b3cca7602301e4e6c024f5473ed3' },
    { length: 79, sha256: 'fb6088bededba5714635ba46c6bd95d3b5fffd7d1cde6956c4aca6e1e2c3c082' },
  ];
  const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
  // Does any substring of `text` hash to one of `list`?
  const holds = (text, list) => list.some(({ length, sha256 }) => {
    for (let i = 0; i + length <= text.length; i++) if (sha(text.slice(i, i + length)) === sha256) return true;
    return false;
  });

  it('no longer shows the 3.2 persona example (checked by hash)', () => {
    for (const f of ['src/blocks/memory_core/index.jsx', 'src/blocks/memory_core/README.md', 'CHANGELOG.md']) {
      expect(holds(fs.readFileSync(path.join(ROOT, f), 'utf8'), OLD), f).toBe(false);
    }
  });

  it('the hash check catches a listed string anywhere in a text', () => {
    // Self-check without the old words: a text holding a string whose hash
    // is listed must be caught. Uses a stand-in of the same length.
    const standIn = 'x'.repeat(74);
    const found = holds(`before ${standIn} after`, [{ length: 74, sha256: sha(standIn) }]);
    expect(found).toBe(true);
  });

  it('is a generic helper', () => {
    expect(SRC).toMatch(/placeholder="e\.g\. Answers bookkeeping questions from my Vault and drafts a short month-end summary\."/);
  });
});

describe('the agent settings panel shows the scratchpad and handoffs', () => {
  it('reads and saves the scratchpad through memory_core\'s route', () => {
    expect(SRC).toMatch(/const base = `\/api\/agents\/\$\{encodeURIComponent\(agentId\)\}`/);
    expect(SRC).toMatch(/fetch\(`\$\{base\}\/scratchpad`\)/);
    expect(SRC).toMatch(/fetch\(`\$\{base\}\/scratchpad`, \{\s*method: 'PUT'/);
    expect(SRC).toMatch(/JSON\.stringify\(\{ content: text \}\)/);
  });

  it('lists the handoffs through memory_core\'s route', () => {
    expect(SRC).toMatch(/fetch\(`\$\{base\}\/handoffs\?limit=20`\)/);
  });

  it('shows the 2,000-character limit and will not save over it', () => {
    expect(SRC).toMatch(/const SCRATCHPAD_MAX = 2000;/);
    expect(SRC).toMatch(/\{fmt\(text\.length\)\} \/ \{fmt\(max\)\}/);
    expect(SRC).toMatch(/disabled=\{saving \|\| pad == null \|\| over \|\| !changed\}/);
    // The server's refusal (413) is shown in its own words.
    expect(SRC).toMatch(/throw new Error\(d\.error \|\| `not saved \(server answered \$\{r\.status\}\)`\)/);
  });

  it('is shown when editing an agent, your own AEON included', () => {
    expect(SRC).toMatch(/agentForm\.mode === 'edit' && agentForm\.id && \(\s*<AgentWorkspace/);
  });

  it('says what each part is, in plain words', () => {
    expect(SRC).toMatch(/It sees them every turn and can change them with its scratchpad tool\./);
    expect(SRC).toMatch(/Written by the agent with \/handoff, or when you save a chat if that setting is on\. The newest one is shown to it on every turn until it writes a newer one\. Nothing is deleted;/);
  });
});
