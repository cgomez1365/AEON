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

/**
 * A role left as "Same as Chat" has no provider of its own, so the card found
 * no models for it and printed "No models available from this provider — add a
 * key under Connections" under a picker that already said "↳ Same as Chat".
 * Routing was never wrong (_declaredFor hands the role to Chat); the warning
 * was. An inheriting role now names the Chat model it really runs on, and the
 * warning stays for a role that has a provider of its own, and for Chat.
 */
const NO_MODELS = [
  { id: 'openrouter', label: 'OpenRouter', icon: '🔀', fallbackModels: [], accounts: [] },
  { id: 'local', label: 'Local', icon: '💻', fallbackModels: [], accounts: [] },
];
const CHAT = { provider: 'openrouter', model: 'nvidia/nemotron-3-ultra-550b-a55b:free' };

// chatConfig has no default on purpose: null must reach the card as null.
const renderBare = (key, config, chatConfig) => renderToStaticMarkup(React.createElement(RoleCard, {
  role: { key, label: key, desc: '', icon: '' },
  config,
  chatConfig,
  providers: { openrouter: true, local: true },
  liveModels: {},
  freeModels: {},
  onUpdate: () => {},
  providerBlocks: {},
  providerRegistry: NO_MODELS,
}));

describe('a role left as Same as Chat does not claim there are no models', () => {
  for (const key of ['analyst', 'naming', 'grading', 'creative']) {
    for (const config of [undefined, { provider: '', model: '' }]) {
      it(`${key} (${config ? 'blank entry' : 'no entry'}) names the Chat model`, () => {
        const html = renderBare(key, config, CHAT);
        expect(html).not.toMatch(/No models available/);
        expect(html).toContain('Uses the Chat model (openrouter / nvidia/nemotron-3-ultra-550b-a55b:free)');
      });
    }
  }

  it('Vision and Embedding unset: no warning, and no claim that they use Chat', () => {
    for (const key of ['vision', 'embed']) {
      const html = renderBare(key, { provider: '', model: '' }, CHAT);
      expect(html, key).not.toMatch(/No models available/);
      expect(html, key).not.toMatch(/Uses the Chat model/);
    }
  });

  it('Chat with no provider yet says so rather than naming a model', () => {
    expect(renderBare('naming', undefined, null)).toMatch(/Uses the Chat model — none is set yet/);
    expect(renderBare('naming', undefined, { provider: 'none', model: '' })).toMatch(/Uses the Chat model — none is set yet/);
  });

  it('a role with its own provider and no models still gets the remedy', () => {
    const own = renderBare('naming', { provider: 'openrouter', model: '' }, CHAT);
    expect(own).toMatch(/No models available from openrouter — add a key under Connections/);
    expect(own).not.toMatch(/Uses the Chat model/);
    expect(renderBare('naming', { provider: 'local', model: '' }, CHAT)).toMatch(/No local model installed yet/);
  });

  it('Chat itself keeps its warning when it has no provider', () => {
    const html = renderBare('chat', { provider: '', model: '' }, CHAT);
    expect(html).toMatch(/No models available from this provider/);
    expect(html).not.toMatch(/Uses the Chat model/);
  });
});
