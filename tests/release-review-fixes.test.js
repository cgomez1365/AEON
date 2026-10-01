/**
 * 3.1.0 review fixes: text that claims to be complete is complete, and the
 * first-run strip agrees with its own copy (Bible §08).
 *
 * - PRIVACY.md is presented as the full list of what AEON sends. Three flows
 *   the code has were missing: Orion Search opening its top web results from
 *   their own sites, a pack installed from an https link, and the launchers
 *   installing Node.js through a package manager.
 * - Settings' Get Started strip marked Supabase "optional" but still needed it
 *   for "You're running", and counted a ready local model as nothing.
 *
 * Text and source only: nothing is started, written or fetched.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const code = (f) => read(f).replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

describe('the privacy notice names every outbound flow the code has', () => {
  const privacy = read('PRIVACY.md');
  const readme = read('README.md');

  it('Orion Search opens its top three web results from their own sites, and the notice says so', () => {
    const orion = code('src/blocks/orion_search/api/orion.cjs');
    expect(orion).toMatch(/results\.filter\(r => r\.source === 'web' && r\.url\)\.slice\(0, 3\)/);
    expect(orion).toMatch(/await fetch\(url, \{[^}]*'User-Agent': 'AEON\//);
    expect(privacy).toMatch(/Orion Search then opens the top three web results from their own sites[^.]*sees your IP address/);
    expect(readme).toMatch(/the top results Orion Search opens to read/);
    expect(readme).toMatch(/the sites of the top three web results Orion Search reads/);
  });

  it('a pack installed from an https link is downloaded from that address, and the notice says so', () => {
    expect(code('src/kernel/store.cjs')).toMatch(/else if \(source\.url\)[\s\S]{0,200}await fetch\(source\.url\)/);
    expect(read('src/blocks/master/InstallPanel.jsx')).toMatch(/kind: 'url', body: \{ url: v \}/);
    expect(privacy).toMatch(/\*\*Packs from a link\.\*\* If you install a pack from an `https` link/);
  });

  it('the launchers can install Node.js through a package manager, and the notice names each one', () => {
    expect(read('launch.command')).toMatch(/brew install "\$NODE_FORMULA"/);
    expect(read('LAUNCH.bat')).toMatch(/winget install -e --id OpenJS\.NodeJS\.LTS/);
    expect(read('launch.sh')).toMatch(/deb\.nodesource\.com\/setup_lts\.x/);
    expect(read('launch.sh')).toMatch(/rpm\.nodesource\.com\/setup_lts\.x/);
    expect(privacy).toMatch(/\*\*Node\.js, if the launcher installs it\.\*\*[^\n]*Homebrew \(macOS\), winget \(Windows\)[^\n]*NodeSource's setup script on apt and dnf systems/);
  });
});

describe('the Get Started strip agrees with its own copy', () => {
  const ui = read('src/blocks/settings/index.jsx');
  const strip = ui.slice(ui.indexOf('function GetStartedStrip()'), ui.indexOf('function sciFor('));

  it('is found', () => {
    expect(strip.length).toBeGreaterThan(200);
  });

  it('Supabase, marked optional, no longer decides whether AEON is running', () => {
    expect(strip).toMatch(/title="Connect Supabase \(optional\)"/);
    expect(strip).not.toMatch(/allDone = [^;]*supabase/);
    expect(strip).toMatch(/const allDone = st\.key \|\| st\.local;/);
  });

  it('a ready local model completes step 1, as its copy promises', () => {
    expect(strip).toMatch(/run local models, no key needed/);
    expect(strip).toMatch(/fetch\('\/core\/provider-health'\)/);
    expect(strip).toMatch(/const localReady = !!providers\.local\?\.configured;/);
    expect(strip).toMatch(/<Step n="1" done=\{st\.key \|\| st\.local\}/);
    // provider-health's `configured` for local is the runtime plus a ready chat model.
    expect(read('services/ai.js')).toMatch(/if \(p === 'local'\) \{ const lr = _getLocalRT\(\); return !!\(lr && lr\.isAvailable\(\)\); \}/);
  });

  it('a key added as a Settings → Keys connection counts, not only one in .env', () => {
    expect(strip).toMatch(/Object\.entries\(providers\)\.some\(\(\[p, v\]\) => p !== 'local' && v\?\.configured\)/);
  });
});
