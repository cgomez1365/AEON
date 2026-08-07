/**
 * BO-D2c — one command, one outcome.
 *
 * THE DEFECT THIS SUITE EXISTS FOR (2026-08-05): /model-pull and
 * /autopilot-start each produced two process lines for a single action —
 * a green EXIT 0 above a red EXIT 1 — because the confirmation gate's 428
 * was rendered as a COMPLETED, SUCCESSFUL run and the approved execution
 * then opened a second chip.
 *
 * Two separate lies in one screen:
 *   - a command still waiting on a human was drawn as finished
 *   - a command that failed was shown as having also succeeded
 *
 * These drive the real decision table. Nothing is re-implemented inline.
 */
import { describe, expect, it } from 'vitest';
import {
  CHIP_STATUS,
  describeDispatchOutcome,
  describeDenial,
  describeCommandOutput,
  isTerminalStatus,
} from '../src/utils/commandOutcome.js';

describe('a challenge is not a result', () => {
  const challenge = {
    status: 428,
    data: { ok: false, requiresConfirmation: true, prompt: 'Host OS: Pull model "tinyllama" — confirm to execute.' },
  };

  it('does not report success for a command that has not run', () => {
    const o = describeDispatchOutcome(challenge);
    // The exact defect: this was CHIP_STATUS.OK, which the renderer draws
    // as a green EXIT 0.
    expect(o.chipStatus).not.toBe(CHIP_STATUS.OK);
    expect(o.chipStatus).toBe(CHIP_STATUS.PENDING);
    expect(o.kind).toBe('challenge');
  });

  it('pending carries no exit code at all', () => {
    // EXIT 0 and EXIT 1 are claims about a finished run. A challenge is
    // neither, and must not be forced into that pair.
    expect(isTerminalStatus(CHIP_STATUS.PENDING)).toBe(false);
    expect(isTerminalStatus(CHIP_STATUS.OK)).toBe(true);
    expect(isTerminalStatus(CHIP_STATUS.FAIL)).toBe(true);
  });

  it('carries the prompt the dispatcher actually sent', () => {
    expect(describeDispatchOutcome(challenge).prompt).toMatch(/tinyllama/);
  });

  it('falls back to a usable prompt rather than an empty card', () => {
    const o = describeDispatchOutcome({ status: 428, data: { requiresConfirmation: true } });
    expect(o.prompt.length).toBeGreaterThan(0);
  });
});

describe('a real result reports what actually happened', () => {
  it('ok is ok', () => {
    const o = describeDispatchOutcome({ status: 200, data: { ok: true, text: 'done' } });
    expect(o.chipStatus).toBe(CHIP_STATUS.OK);
    expect(o.text).toBe('done');
    expect(o.expand).toBe(false);
  });

  it('a failure is a failure, and opens itself', () => {
    const o = describeDispatchOutcome({ status: 200, data: { ok: false, error: 'repo_id is required' } });
    expect(o.chipStatus).toBe(CHIP_STATUS.FAIL);
    expect(o.error).toMatch(/repo_id/);
    expect(o.expand).toBe(true);
  });

  it('a 428 without the confirmation flag is not a challenge', () => {
    // Only the dispatcher's real gate produces a challenge. A bare 428 from
    // anywhere else is a failure like any other.
    const o = describeDispatchOutcome({ status: 428, data: { ok: false, error: 'something else' } });
    expect(o.kind).toBe('fail');
  });

  it('an empty body is a failure, not a success', () => {
    expect(describeDispatchOutcome({ status: 500, data: {} }).chipStatus).toBe(CHIP_STATUS.FAIL);
    expect(describeDispatchOutcome({}).chipStatus).toBe(CHIP_STATUS.FAIL);
  });

  it('does not treat whitespace as output worth announcing', () => {
    const o = describeDispatchOutcome({ status: 200, data: { ok: true, text: '   ' } });
    expect(o.text).toBeNull();
  });
});

describe('BO-D2d — empty is a legitimate answer and must read as one', () => {
  it('an empty list is a sentence, not an empty code block', () => {
    // /docs returned [] and the terminal drew ```json\n[]\n``` — the
    // machine's internal shape pasted onto the screen.
    const out = describeCommandOutput({ ok: true, data: [] });
    expect(out).not.toMatch(/```/);
    expect(out).toMatch(/no entries/i);
  });

  it('{empty:true} is a sentence, not the word "empty" as JSON', () => {
    const out = describeCommandOutput({ ok: true, data: { empty: true } });
    expect(out).not.toMatch(/```/);
    expect(out).toMatch(/no entries/i);
  });

  it('log lines the command wrote for a human are shown as prose', () => {
    // /scan answers {ok:true, text:null, data:{logs:[…]}} — verified live.
    const out = describeCommandOutput({
      ok: true, text: null,
      data: { success: true, logs: ['✔ Supabase notes merged.', 'ℹ Matrix indexing skipped.'] },
    });
    expect(out).toBe('✔ Supabase notes merged.\nℹ Matrix indexing skipped.');
    expect(out).not.toMatch(/```/);
  });

  it('real structured data is still shown', () => {
    const out = describeCommandOutput({ ok: true, data: { models: ['a', 'b'] } });
    expect(out).toMatch(/```json/);
    expect(out).toMatch(/models/);
  });

  it('a non-empty list is still shown', () => {
    expect(describeCommandOutput({ ok: true, data: [{ id: 1 }] })).toMatch(/```json/);
  });

  it('text wins over everything', () => {
    expect(describeCommandOutput({ ok: true, text: 'the answer', data: [] })).toBe('the answer');
  });

  it('an error is shown when there is no data', () => {
    expect(describeCommandOutput({ ok: false, error: 'Invalid repo_id' })).toBe('Invalid repo_id');
  });

  it('silence is described, never rendered as "(empty)"', () => {
    // "(empty)" reads like a value the command returned.
    const ok = describeCommandOutput({ ok: true });
    const bad = describeCommandOutput({ ok: false });
    expect(ok).not.toMatch(/\(empty\)/);
    expect(bad).not.toMatch(/\(empty\)/);
    expect(ok).toMatch(/success/i);
    expect(bad).toMatch(/did not say why/i);
  });
});

describe('denial is an answer, not an error', () => {
  it('is its own state', () => {
    const d = describeDenial('/model-pull tinyllama');
    expect(d.chipStatus).toBe(CHIP_STATUS.DENIED);
    expect(isTerminalStatus(d.chipStatus)).toBe(false);
    expect(d.output).toMatch(/not run/i);
  });

  it('names the command the operator refused', () => {
    expect(describeDenial('/autopilot-start').output).toMatch(/autopilot-start/);
  });
});
