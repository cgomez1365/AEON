/**
 * Capabilities — the seam between a Settings toggle and the code it governs.
 *
 * WHY THIS EXISTS
 * Settings shipped thirteen toggles that nothing read. Eight of them claimed
 * to govern what the agent may do — "Shell commands: off", "File system
 * access: off" — and governed nothing, which is the worst shape a defect can
 * take: the operator believes they have restricted something, acts on that
 * belief, and the product never contradicts them. A cosmetic setting that
 * does nothing is untidy; a SECURITY setting that does nothing is a lie the
 * operator cannot detect (§08).
 *
 * The toggles were not wired because there was nowhere to wire them TO. Each
 * consumer would have had to fetch a pref, pick a default, and decide what an
 * unset value means — so each would have picked differently, and a capability
 * would be off in one caller and on in another. This module is the single
 * answer, and it is deliberately synchronous and cheap so a caller on a hot
 * path has no excuse to cache a stale copy.
 *
 * HOW A FUTURE BLOCK USES IT
 *   const caps = require('../../kernel/capabilities.cjs');
 *   if (!caps.enabled('tool_shell')) return refuse('shell is disabled in Settings');
 *
 * That is the whole contract. Declare the capability in CAPABILITIES below,
 * flip `implemented` to true in the same commit that adds the enforcement,
 * and Settings stops rendering it as inactive on its own.
 *
 * THE `implemented` FLAG IS NOT DECORATION
 * It is what keeps the UI honest. A capability declared here but not yet
 * enforced anywhere renders disabled in Settings with a plain explanation,
 * so the operator is never shown a control that does not control anything.
 * Setting it to true while nothing calls enabled() for that key re-creates
 * the exact defect this module exists to remove — so the gate in
 * tests/capabilities.test.js greps for a real caller and fails without one.
 */

const settingsAuthority = require('../../services/settings.js');

/**
 * Every capability the product offers, whether or not it is wired yet.
 *
 *   default      — the value when the operator has never touched it.
 *   implemented  — is there real enforcement behind this today?
 *   summary      — shown in Settings; plain language, no jargon.
 *   pending      — for unimplemented ones: what is missing, in the
 *                  operator's terms rather than the codebase's.
 */
const CAPABILITIES = {
  // ── Wired ────────────────────────────────────────────────────────
  telemetry_enabled: {
    default: true,
    implemented: true,
    summary: 'Record how long model calls take, how many tokens they use, and how often they fail.',
  },
  auto_sync: {
    default: true,
    implemented: true,
    summary: 'Push block data to the Supabase relay when it changes.',
  },

  // ── Declared, not yet enforced ───────────────────────────────────
  // These stay listed rather than deleted: the agent tool registry is real
  // infrastructure (src/kernel/agentToolRegistry.cjs) and these are the
  // permissions it will read. What does NOT exist yet is any block declaring
  // an agent_tool for them to govern — collectTools() returns an empty array
  // on this install — so enforcing them today would gate nothing while
  // implying otherwise.
  tool_filesystem: {
    default: true, implemented: false,
    summary: 'Let the agent read and write files on this computer.',
    pending: 'No agent tool requests file access yet, so this cannot restrict anything. The File Manager\'s own add-only lock is what governs file changes today.',
  },
  tool_shell: {
    default: true, implemented: false,
    summary: 'Let the agent run commands on this computer.',
    pending: 'No agent tool runs shell commands yet. The terminal\'s own > prefix is what runs commands today, and it acts on your instruction rather than the agent\'s.',
  },
  tool_web_search: {
    default: true, implemented: false,
    summary: 'Let the agent search the web.',
    pending: 'Deep Research and Orion Search run searches when you ask them to, and neither routes through the agent toolset yet.',
  },
  tool_email: {
    default: false, implemented: false,
    summary: 'Let the agent send email.',
    pending: 'No email tool is installed.',
  },
  tool_crm: {
    default: true, implemented: false,
    summary: 'Let the agent add and edit clients and invoices.',
    pending: 'No agent tool reaches the CRM yet.',
  },
  tool_memory: {
    default: true, implemented: false,
    summary: 'Let the agent save facts to memory on its own.',
    pending: 'The agent cannot write to memory at all today — Memory Core\'s automatic capture setting is what governs saving, and it runs after a conversation rather than as an agent action.',
  },
  tool_autopilot: {
    default: false, implemented: false,
    summary: 'Let the agent start and stop the autopilot pipeline.',
    pending: 'No autopilot tool is installed.',
  },
  tool_deploy: {
    default: false, implemented: false,
    summary: 'Let the agent deploy to Vercel, Cloudflare, or another host.',
    pending: 'No deploy tool is installed. Deployment runs from the build pipeline, which asks for approval separately.',
  },
  sound_effects: {
    default: false, implemented: false,
    summary: 'Play a sound on notifications and events.',
    pending: 'AEON has no sound system yet.',
  },
  auto_backup: {
    default: false, implemented: false,
    summary: 'Snapshot settings to Supabase every six hours.',
    pending: 'There is no scheduler to run the snapshot on. Settings are still included in a manual cloud push.',
  },
};

/**
 * Is a capability on?
 *
 * An UNIMPLEMENTED capability always answers with its default, never the
 * stored preference. That is deliberate: if a caller appears before the
 * enforcement does, it must not silently start honouring a toggle that
 * Settings is simultaneously telling the operator is inactive. The two
 * surfaces agree or the flag is wrong.
 *
 * Unknown keys answer false and warn. A typo'd capability name should fail
 * closed and loudly, not read as "off" forever in silence.
 */
function enabled(key) {
  const spec = CAPABILITIES[key];
  if (!spec) {
    console.warn(`[CAPABILITIES] unknown capability "${key}" — refusing. Declare it in src/kernel/capabilities.cjs.`);
    return false;
  }
  if (!spec.implemented) return spec.default;

  try {
    const prefs = settingsAuthority.loadSettings()?.prefs || {};
    return prefs[key] === undefined ? spec.default : !!prefs[key];
  } catch {
    // Settings unreadable — fall back to the declared default rather than
    // failing the caller. A capability check must not be the thing that
    // takes down a request.
    return spec.default;
  }
}

/** Everything Settings needs to render a toggle honestly. */
function describe() {
  return Object.entries(CAPABILITIES).map(([key, spec]) => ({
    key,
    default: spec.default,
    implemented: spec.implemented,
    summary: spec.summary,
    pending: spec.pending || null,
    value: enabled(key),
  }));
}

module.exports = { enabled, describe, CAPABILITIES };
