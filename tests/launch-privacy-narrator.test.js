/**
 * The Narrator never picks an online voice by itself (audit A070 review).
 *
 * The Vault's read-aloud player chose "UK English Female" by default. In
 * Chrome that is "Google UK English Female", a network voice
 * (localService: false), so pressing Play sent each sentence of the document
 * to Google's speech service. Edge's "Online (Natural)" voices do the same.
 * The default is now picked only from voices that run on this computer, the
 * picker marks online ones, and with only online voices Play waits for the
 * operator to choose one.
 */
import { describe, expect, it } from 'vitest';
import { pickDefaultVoice, voiceLabel, needsVoiceChoice, isOnlineVoice } from '../src/blocks/aeon_matrix/components/NarratorPlayer.jsx';

const voice = (name, lang, localService, extra = {}) => ({ name, lang, localService, default: false, ...extra });

// What Chrome on macOS lists, in its order: system voices plus Google's network ones.
const CHROME_MAC = [
  voice('Samantha', 'en-US', true, { default: true }),
  voice('Daniel', 'en-GB', true),
  voice('Google US English', 'en-US', false),
  voice('Google UK English Female', 'en-GB', false),
  voice('Google UK English Male', 'en-GB', false),
];

describe('Narrator voice choice', () => {
  it('Chrome: the old default (Google UK English Female, a network voice) is passed over for a local en-GB voice', () => {
    expect(pickDefaultVoice(CHROME_MAC).name).toBe('Daniel');
  });

  it('a local "UK English Female" voice is still preferred when there is one', () => {
    const v = [...CHROME_MAC, voice('Microsoft Hazel - English (United Kingdom) UK English Female', 'en-GB', true)];
    expect(pickDefaultVoice(v).name).toMatch(/Hazel/);
  });

  it('only online voices: no default is chosen, and Play waits for a choice', () => {
    const online = CHROME_MAC.filter(isOnlineVoice);
    expect(pickDefaultVoice(online)).toBeNull();
    expect(needsVoiceChoice(online, null)).toBe(true);
    expect(needsVoiceChoice(online, online[0])).toBe(false);   // the operator chose one
    expect(needsVoiceChoice(CHROME_MAC, null)).toBe(false);    // a local one exists
    expect(needsVoiceChoice([], null)).toBe(false);            // voices not loaded yet
  });

  it('online voices are marked in the picker; local ones keep their name', () => {
    expect(voiceLabel(CHROME_MAC[3])).toMatch(/^Google UK English Female \(online: text leaves this computer\)$/);
    expect(voiceLabel(CHROME_MAC[1])).toBe('Daniel');
  });
});
