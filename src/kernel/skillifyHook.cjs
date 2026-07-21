/**
 * skillifyHook.cjs
 *
 * Called after any agent is deployed or registered.
 * Non-blocking — reads the agent config, compares capabilities to existing
 * skills in skills-lock.json, appends missing capability slugs to the
 * Skillify queue. Skillify drains the queue on its next trigger cycle.
 *
 * Fire-and-forget. All errors are swallowed — this is a telemetry hook,
 * not a critical path. The agent runner must never block on this.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { VAULT_ROOT } = require('../../services/storage.js');

const LOCK_FILE    = path.join(VAULT_ROOT, 'skills-lock.json');
const QUEUE_FILE   = path.join(VAULT_ROOT, 'Agents', 'skillify', 'queue.json');

/**
 * skillifyHook(agentSlug, agentConfig)
 *
 * @param {string} agentSlug    - kebab-case agent identifier (e.g. 'aeon', 'mnemosyne')
 * @param {object} agentConfig  - agent config object; must have .capabilities: string[]
 *                                Optional: .skills: string[] (already-mapped skill slugs)
 */
function skillifyHook(agentSlug, agentConfig) {
  try {
    if (!agentSlug || !agentConfig) return;

    const capabilities = Array.isArray(agentConfig.capabilities)
      ? agentConfig.capabilities
      : [];

    if (capabilities.length === 0) return;

    // Read existing skills-lock.json — graceful if missing
    let lock = { skills: {} };
    try { lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch {}
    const existingSlugs = new Set(Object.keys(lock.skills || {}));

    // Read current queue — graceful if missing or malformed
    let queue = [];
    try { queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); } catch {}
    if (!Array.isArray(queue)) queue = [];

    const now = new Date().toISOString();
    let appended = 0;

    for (const capability of capabilities) {
      // Normalize: "web-search" or "web_search" both produce slug "web-search"
      const slug = capability.toLowerCase().replace(/_/g, '-');

      // Already in skills-lock → no action needed
      if (existingSlugs.has(slug)) continue;

      // Already queued (avoid duplicates for same capability + agent combo)
      const alreadyQueued = queue.some(
        item => item.capability === slug && item.agent === agentSlug && item.action === 'create'
      );
      if (alreadyQueued) continue;

      queue.push({
        action: 'create',
        capability: slug,
        agent: agentSlug,
        queued_at: now,
      });
      appended++;
    }

    if (appended > 0) {
      fs.mkdirSync(path.dirname(QUEUE_FILE), { recursive: true });
      fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf8');
    }

  } catch (e) {
    // Non-critical — never throw
    console.warn('[SKILL] skillifyHook failed (non-critical):', e.message);
  }
}

module.exports = { skillifyHook };
