/**
 * The welcome screen says what a cloud key does to the Vault, and links the
 * terms AEON is used under (audit #3 and #25, 2026-10-03).
 *
 * It recommended a free cloud key and said nothing about indexing — with no
 * local embedding model, that key is also what indexes the Vault, so its text
 * goes to that provider. And nothing in the app or the launcher linked the
 * Terms of Use, the License or the Privacy notice.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TERMS_URL, LICENSE_URL, PRIVACY_URL } from '../src/utils/help.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wizard = fs.readFileSync(path.join(ROOT, 'src/blocks/security/components/SetupWizard.jsx'), 'utf8');

describe('welcome screen', () => {
  it.each([['TERMS_URL', TERMS_URL], ['LICENSE_URL', LICENSE_URL], ['PRIVACY_URL', PRIVACY_URL]])(
    '%s points at a file on main that exists in this repository, and the screen links it', (name, url) => {
      const m = /^https:\/\/github\.com\/cgomez1365\/AEON\/blob\/main\/(.+)$/.exec(url);
      expect(m, url).not.toBeNull();
      expect(fs.existsSync(path.join(ROOT, m[1])), `${m[1]} is not in the repository`).toBe(true);
      expect(wizard).toContain(`href={${name}}`);
    },
  );

  it('says that, with no local embedding model, a cloud key also indexes the Vault through its provider', () => {
    const text = wizard.replace(/\s+/g, ' ');
    expect(text).toMatch(/With no local embedding model, a cloud key .* is also used to index your Vault, so its text goes to that provider/);
  });
});
