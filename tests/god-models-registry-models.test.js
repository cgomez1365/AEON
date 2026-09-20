/**
 * The HOTSWAP CHAT MODEL dropdown reads the field the data is actually in.
 *
 * Found live, 2026-09-20 (operator: "model picker failed?"). The terminal's
 * hotswap dropdown (Terminal2.jsx) correctly showed every provider grouped
 * and marked "✓ key ready", but every group held only the disabled
 * "(no models listed)" placeholder — nothing was ever selectable, for any
 * provider, ever. Root cause: /api/settings/nervous-system's
 * buildNervousSystem() names this field `registryModels`
 * (src/blocks/settings/api/settings.js:566); /god/models read `p.models`,
 * a key that response never sets. The underlying data was real the whole
 * time — verified live, groq and openrouter's vault-stored connections
 * carry 14 and several hundred models respectively.
 */
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

let servers = [];
afterEach(() => { for (const s of servers) { try { s.close(); } catch {} } servers = []; });

async function mountWithNervousSystem(providers) {
  const app = express(); app.use(express.json());
  app.get('/api/settings/nervous-system', (req, res) => res.json({ providers }));

  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  process.env.PORT = String(server.address().port);

  delete require.cache[require.resolve('../src/kernel/routers/console.cjs')];
  const consoleFactory = require('../src/kernel/routers/console.cjs');
  app.use('/api/console', consoleFactory({ storage: { VAULT_ROOT: '/tmp/x', DATA_ROOT: '/tmp/y' } }));

  const port = server.address().port;
  return async () => (await fetch(`http://127.0.0.1:${port}/api/console/models`)).json();
}

describe('/god/models reads registryModels, not models', () => {
  it('a provider with a real model list (registryModels) is not reported empty', async () => {
    const getModels = await mountWithNervousSystem({
      groq: { id: 'groq', label: 'Groq', configured: true, registryModels: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'] },
      openrouter: { id: 'openrouter', label: 'OpenRouter', configured: true, registryModels: ['openrouter/free', 'anthropic/claude-sonnet-5'] },
    });
    const body = await getModels();
    expect(body.ok).toBe(true);
    const groq = body.groups.find((g) => g.provider === 'groq');
    const openrouter = body.groups.find((g) => g.provider === 'openrouter');
    expect(groq.hasKey).toBe(true);
    expect(groq.models).toEqual(['openai/gpt-oss-120b', 'openai/gpt-oss-20b']);
    expect(openrouter.models).toContain('openrouter/free');
  });

  it('a provider with genuinely no models still reports empty honestly, not a crash', async () => {
    const getModels = await mountWithNervousSystem({
      custom: { id: 'custom', label: 'Custom', configured: false, registryModels: [] },
    });
    const body = await getModels();
    const custom = body.groups.find((g) => g.provider === 'custom');
    expect(custom.models).toEqual([]);
    expect(custom.hasKey).toBe(false);
  });

  it('still tolerates a plain `models` field if some future caller sets one', async () => {
    const getModels = await mountWithNervousSystem({
      legacy: { id: 'legacy', label: 'Legacy', configured: true, models: ['old-style-field'] },
    });
    const body = await getModels();
    expect(body.groups.find((g) => g.provider === 'legacy').models).toEqual(['old-style-field']);
  });
});
