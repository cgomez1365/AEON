/**
 * The Privacy notice says what "Local only" and "Off" do in the same terms as
 * the screen that sets them (review of audit #2/#36, 2026-10-03).
 *
 * PRIVACY.md said a Local only agent's "own memory" goes only to a local
 * model. For the operator's own AEON that memory is the shared memory, which
 * an agent set to Roulette still sends to its own model; Memory Core and its
 * README said so, PRIVACY.md did not. It also named search results in
 * general, while Aeon Matrix's search box still lists those files to the
 * operator. These lines keep the texts from drifting apart again.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// JSX and Markdown wrap lines; compare the words.
const flat = (text) => text.replace(/[`*]/g, '').replace(/\s+/g, ' ');

const PRIVACY = flat(read('PRIVACY.md'));
const SHARED_EXCEPTION = 'an agent set to Roulette that reads the shared memory still sends it to its own model';

describe('Local only: the shared-memory exception is stated everywhere it is set or described', () => {
  it.each([
    ['PRIVACY.md', PRIVACY],
    ['Memory Core screen', flat(read('src/blocks/memory_core/index.jsx'))],
    ['Memory Core README', flat(read('src/blocks/memory_core/README.md'))],
  ])('%s', (_label, text) => {
    expect(text).toContain(SHARED_EXCEPTION);
  });

  it('PRIVACY.md claims "its own memory" only for an agent the operator created', () => {
    expect(PRIVACY).not.toMatch(/and its own memory go only to a model on this computer/);
    expect(PRIVACY).toContain('For an agent you created, that includes its own memory.');
  });

  it('the screen\'s label for the operator\'s own AEON promises its chats only', () => {
    const jsx = read('src/blocks/memory_core/index.jsx');
    expect(jsx).toContain("'Local only — its chats never go to a cloud model'");
    expect(read('src/utils/terminalAgent.js')).toContain('local only (its chats never go to a cloud model)');
  });
});

describe('the commands PRIVACY.md says a Local only agent keeps local are the ones that do', () => {
  const declared = [];
  for (const block of fs.readdirSync(path.join(ROOT, 'src', 'blocks'))) {
    const file = path.join(ROOT, 'src', 'blocks', block, 'block.manifest.json');
    if (!fs.existsSync(file)) continue;
    for (const c of JSON.parse(fs.readFileSync(file, 'utf8'))?.contract?.commands || []) {
      if (c.takesLocalOnly) declared.push(c.cmd);
    }
  }

  it('every command that declares takesLocalOnly is named, and the list names no other', () => {
    expect(declared.sort()).toEqual(['/ask', '/ask-doc', '/read', '/recall']);
    const m = PRIVACY.match(/while it is the terminal's agent, the (.+?) commands and the sentence/);
    expect(m, 'the Local only sentence in PRIVACY.md moved').not.toBeNull();
    expect(m[1].match(/\/[a-z-]+/g).sort()).toEqual(declared.sort());
    expect(PRIVACY).toContain('other slash commands use the models set in Settings → Models');
  });
});

describe('Off and Local only: where they are withheld, in words the code keeps', () => {
  it('names the recall paths, not "search results" in general', () => {
    expect(PRIVACY).not.toMatch(/never appear in search results/);
    expect(PRIVACY).toContain('never come back from /recall, /ask, /ask-doc or chat recall');
    expect(PRIVACY).toContain("Aeon Matrix's own search box still lists them");
  });
});
