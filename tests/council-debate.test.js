/**
 * Council — what the chair is shown, and what the Vault transcript records.
 *
 * Reproduced live 2026-09-23 (agent C2) through the real UI against a stub
 * model that tags each answer with the question it was asked:
 *
 *   Question C, then Question D. The chair's prompt for D — and the transcript
 *   saved to Vault/Agents/council/debates/ for D — carried every councilor's
 *   "Final:" position from C. On the first debate of the session "Final:" was
 *   the opening repeated; no revised position ever reached the chair.
 *
 * Cause: the component read final positions from React state captured at the
 * click. That logic now lives in src/blocks/council/debate.mjs, driven here by a
 * fake `ask` that records every prompt.
 */
import { describe, it, expect } from 'vitest';
import { runDebate, savePayload, BUDGET } from '../src/blocks/council/debate.mjs';

const COUNCIL = [
  { id: 'p', label: 'The Pragmatist', persona: 'cash first' },
  { id: 's', label: 'The Skeptic', persona: 'doubts everything' },
];
const CHAIR = { id: 'c', label: 'The Chair', chair: true };

/** A model that says which question and which round it is answering. */
function recordingAsk(overrides = {}) {
  const prompts = [];
  const ask = async (prompt, member) => {
    prompts.push({ prompt, member: member.id });
    const q = (prompt.match(/QUESTION: (.+)|The question was: (.+)|Question: (.+)/) || []).slice(1).find(Boolean);
    const round = /Write the council's verdict/.test(prompt) ? 'verdict' : /Give your FINAL position/.test(prompt) ? 'final' : 'opening';
    const key = `${member.id}:${round}`;
    if (overrides[key]) return overrides[key](q);
    return `${round.toUpperCase()} by ${member.id} on [${q}]`;
  };
  return { ask, prompts };
}

describe('the chair rules on THIS debate', () => {
  it('sees each councilor\'s revised position, not the opening repeated', async () => {
    const { ask, prompts } = recordingAsk();
    const r = await runDebate({ question: 'Q1', councilors: COUNCIL, chair: CHAIR, ask });
    const chairPrompt = prompts.find((p) => p.member === 'c').prompt;
    expect(chairPrompt).toContain('Final: FINAL by p on [Q1]');
    expect(chairPrompt).toContain('Final: FINAL by s on [Q1]');
    expect(r.verdict).toBe('VERDICT by c on [Q1]');
  });

  it('a second debate never carries the first debate\'s positions', async () => {
    const { ask, prompts } = recordingAsk();
    await runDebate({ question: 'Question C', councilors: COUNCIL, chair: CHAIR, ask });
    const second = await runDebate({ question: 'Question D', councilors: COUNCIL, chair: CHAIR, ask });
    const chairD = prompts.filter((p) => p.member === 'c').pop().prompt;
    expect(chairD).not.toContain('Question C]');
    expect(chairD).toContain('FINAL by s on [Question D]');
    const saved = savePayload('Question D', COUNCIL, second);
    expect(saved.opinions.map((o) => o.revised)).toEqual(['FINAL by p on [Question D]', 'FINAL by s on [Question D]']);
  });

  it('the transcript payload carries both rounds', async () => {
    const { ask } = recordingAsk();
    const r = await runDebate({ question: 'Q', councilors: COUNCIL, chair: CHAIR, ask });
    const saved = savePayload('Q', COUNCIL, r);
    expect(saved.opinions[0]).toMatchObject({ label: 'The Pragmatist', opening: 'OPENING by p on [Q]', revised: 'FINAL by p on [Q]' });
    expect(saved.verdict).toBe('VERDICT by c on [Q]');
  });
});

describe('a cut-off or failed voice is said out loud', () => {
  it('marks an answer the model truncated, and tells the chair', async () => {
    const { ask, prompts } = recordingAsk({
      'p:opening': () => ({ text: 'A long answer that stops mid', truncated: true, truncationReason: 'max_tokens' }),
    });
    const r = await runDebate({ question: 'Q', councilors: COUNCIL, chair: CHAIR, ask });
    expect(r.opinions.p.openingTruncated).toBe(true);
    const saved = savePayload('Q', COUNCIL, r);
    expect(saved.opinions[0].openingTruncated).toBe(true);
    expect(prompts.find((p) => p.member === 'c').prompt).toMatch(/cut off at the model's output limit/);
  });

  it('a councilor who cannot answer is recorded, not fed to the others as an opinion', async () => {
    const { ask, prompts } = recordingAsk({
      's:opening': () => { throw new Error('custom is rate-limited right now (HTTP 429)'); },
    });
    const r = await runDebate({ question: 'Q', councilors: COUNCIL, chair: CHAIR, ask });
    expect(r.opinions.s.error).toMatch(/429/);
    const pFinal = prompts.find((p) => p.member === 'p' && /FINAL position/.test(p.prompt)).prompt;
    expect(pFinal).not.toContain('The Skeptic:');
    expect(prompts.find((p) => p.member === 'c').prompt).toMatch(/The Skeptic\n {2}\(no answer — custom is rate-limited/);
  });

  it('a chair failure keeps every opinion and reports the verdict error', async () => {
    const { ask } = recordingAsk({ 'c:verdict': () => { throw new Error('Endpoint error 502'); } });
    const r = await runDebate({ question: 'Q', councilors: COUNCIL, chair: CHAIR, ask });
    expect(r.verdict).toBe('');
    expect(r.verdictError).toMatch(/chair could not write a verdict: Endpoint error 502/);
    expect(r.opinions.p.revised).toBe('FINAL by p on [Q]');
    expect(savePayload('Q', COUNCIL, r).verdictError).toMatch(/502/);
  });

  it('keeps the text that streamed before a failure, marked as cut off', async () => {
    const { ask } = recordingAsk({
      'p:final': () => { const e = new Error('socket hang up'); e.partialText = 'Half a final answer'; throw e; },
    });
    const r = await runDebate({ question: 'Q', councilors: COUNCIL, chair: CHAIR, ask });
    expect(r.opinions.p.revised).toBe('Half a final answer');
    expect(r.opinions.p.revisedTruncated).toBe(true);
  });
});

describe('prompts ask for answers that fit a free model', () => {
  it('every round states a word limit and why', async () => {
    const { ask, prompts } = recordingAsk();
    await runDebate({ question: 'Q', councilors: COUNCIL, chair: CHAIR, ask });
    for (const { prompt } of prompts) {
      expect(prompt).toMatch(/\d+ words max/);
      expect(prompt).toMatch(/small output budget/);
    }
    expect(BUDGET.verdict).toBeLessThanOrEqual(300);
  });
});
