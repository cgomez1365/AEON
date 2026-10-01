/**
 * A043 / A044 / A020 — what the first screens claim.
 *
 * A043: the first screen of a local-first app was "Set up AEON's cloud — AEON
 *   needs Supabase (and optionally Firebase) credentials", with local use as
 *   the ghost button.
 * A044: the account screen promised the password held "even if the laptop is
 *   stolen" and called the account "air-gapped". The password gates AEON's
 *   screens and API; Vault documents are plain files and the key that opens
 *   stored API keys sits beside them, and AEON goes online for web search and
 *   downloads.
 * A020: nothing on first run said there is no password until an account
 *   exists.
 *
 * Source checks: these are words on screens, and the suite has no DOM.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('first-run wizard is local-first', () => {
  const src = read('src/blocks/security/components/SetupWizard.jsx');
  const step0 = src.slice(src.indexOf('{step === 0 && ('), src.indexOf('{step === 1 && ('));

  it('does not say AEON needs Supabase', () => {
    // The file header quotes the old screen as history; the screen is step 0.
    expect(step0.length).toBeGreaterThan(0);
    expect(step0).not.toMatch(/needs Supabase/);
    expect(step0).not.toMatch(/Set up AEON's cloud/);
  });

  it('starts AEON as the primary action and offers cloud as optional', () => {
    expect(step0).toMatch(/<button style=\{S\.btn\} onClick=\{skipEntirely\}>Start using AEON<\/button>/);
    expect(step0).toMatch(/Connect a cloud database \(optional\)/);
  });

  it('says there is no password yet, and offers to set one', () => {
    expect(step0).toMatch(/No password yet/);
    expect(step0).toMatch(/onClick=\{setPasswordFirst\}/);
    expect(src).toMatch(/navigate\('\/security'\)/);
  });

  it('does not promise the service-role key never leaves the machine', () => {
    expect(src).not.toMatch(/never leaves this machine/);
  });
});

describe('the account screen claims only what the password does', () => {
  const src = read('src/blocks/security/index.jsx');

  it('no stolen-laptop or air-gap claims', () => {
    expect(src).not.toMatch(/even if the laptop is stolen/);
    expect(src).not.toMatch(/air-gapped/i);
    expect(src).not.toMatch(/Stolen-laptop defense/);
  });

  it('says what does protect files on a lost computer', () => {
    expect(src).toMatch(/does not encrypt the files on this computer/);
    expect(src).toMatch(/FileVault/);
    expect(src).toMatch(/BitLocker/);
  });

  it('points at a Settings tab that exists', () => {
    expect(src).not.toMatch(/Settings → Connections/);
    expect(src).toMatch(/Settings → Services/);
    expect(read('src/blocks/settings/index.jsx')).toMatch(/\{ id: 'services',\s+label: 'Services' \}/);
  });
});
