/**
 * Sweep C33 (UI) — a role card's empty option names what actually serves an
 * unset role.
 *
 * Every role but Chat offered "↳ Same as Chat". The kernel honours that for
 * most roles (_declaredFor), but Vision and Embedding never use Chat: Vision
 * has its own default (Groq Llama 4 Scout) and Embedding is automatic (an
 * installed local embedder, or the assigned endpoint). Picking "Same as Chat"
 * for Vision saved {provider: ''} and every image upload failed; an unset
 * Vision or Embedding role was labelled with something the kernel would not do.
 *
 * Renders the real RoleCard to static markup (the suite has no DOM).
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const { RoleCard } = await import('../src/blocks/settings/index.jsx');

const PROVIDERS = [
  { id: 'groq', label: 'Groq', icon: '⚡', fallbackModels: ['openai/gpt-oss-120b'], accounts: [] },
  { id: 'openrouter', label: 'OpenRouter', icon: '🔀', fallbackModels: ['openrouter/free'], accounts: [] },
];

const render = (key, config = { provider: '', model: '' }) => renderToStaticMarkup(React.createElement(RoleCard, {
  role: { key, label: key, desc: '', icon: '' },
  config,
  providers: { groq: true, openrouter: true },
  liveModels: {},
  freeModels: {},
  onUpdate: () => {},
  providerBlocks: {},
  providerRegistry: PROVIDERS,
}));

// The text of the <option value=""> the card offers, or null when it has none.
const unsetOption = (html) => {
  const m = /<option value=""[^>]*>([^<]*)<\/option>/.exec(html);
  return m ? m[1] : null;
};

describe('C33 — the empty option says what an unset role runs on', () => {
  it('Vision: its own default, never "Same as Chat"', () => {
    const opt = unsetOption(render('vision'));
    expect(opt).not.toMatch(/Same as Chat/);
    expect(opt).toMatch(/Llama 4 Scout/);
  });

  it('Embedding: automatic, never "Same as Chat"', () => {
    const opt = unsetOption(render('embed'));
    expect(opt).not.toMatch(/Same as Chat/);
    expect(opt).toMatch(/Automatic/);
  });

  it('other roles keep "Same as Chat" — the kernel does use Chat for them', () => {
    for (const key of ['naming', 'analyst', 'grading', 'creative']) {
      expect(unsetOption(render(key)), key).toMatch(/Same as Chat/);
    }
  });

  it('Chat itself has no empty option', () => {
    expect(unsetOption(render('chat', { provider: 'groq', model: 'openai/gpt-oss-120b' }))).toBeNull();
  });
});
