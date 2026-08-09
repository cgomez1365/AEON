/**
 * Master M1 — scaffold a block as a build ENVELOPE, never as files on disk.
 *
 * The old documented path was "copy src/blocks/master/, rename the folder,
 * edit the manifest, ship" — which lands code in src/blocks/ having touched
 * no gate: no manifest validation, no code scan, no complexity gate, no
 * approval queue. This module produces the same shape buildPipeline already
 * accepts, so a scaffolded block enters through the airlock like every other
 * source.
 *
 * Two rules this file exists to enforce by construction:
 *
 *   Folder is truth — the caller supplies one id; it becomes the folder name,
 *   the manifest id and the route. They cannot drift apart.
 *
 *   Ask for nothing extra — permissions start at the floor. Every widening is
 *   an explicit argument, and the ones that carry a consequence (storage and
 *   memory both require filesystem:write) are derived here rather than left
 *   for the operator to get wrong and the validator to reject.
 *
 * No validation lives here. staging.cjs owns that (guardrail 5); this module
 * only has to emit something that can pass it.
 */

const ID_RE = /^[a-z][a-z0-9_]*$/;

/** Lucide-ish default; the operator can change it in the manifest afterwards. */
const DEFAULT_ICON = 'Box';

/**
 * Derive a display label from an id the same way the kernel does
 * (my_block → "My Block"), so a scaffold with no explicit label matches what
 * blockStandard.labelFromFolder() would have produced anyway.
 */
function labelFromId(id) {
  return String(id).split('_').filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function buildManifest(opts) {
  const {
    id, label, description, category, tier,
    icon, navGroup, navOrder,
    api, widget, storage, memory,
    network, ai, secrets,
  } = opts;

  // v1.1 couples these: declaring either storage or memory means the block
  // writes to disk, and validateManifest rejects the combination without
  // filesystem:write. Derive it instead of asking twice and trusting the answer.
  const wantsStorage = storage !== 'none';
  const wantsMemory = memory !== 'none';
  const filesystem = (wantsStorage || wantsMemory) ? 'write' : 'none';

  const manifest = {
    manifestVersion: '1.1.0',
    id,
    label: label || labelFromId(id),
    icon: icon || DEFAULT_ICON,
    route: `/${id}`,
    description: description || `${label || labelFromId(id)} block.`,
    category: category || 'tools',
    tier: tier || 'plugin',
    version: '1.0.0',
    nav: {
      group: navGroup || 'tools',
      order: Number(navOrder) || 50,
      label: label || labelFromId(id),
      icon: icon || DEFAULT_ICON,
      hidden: false,
    },
    requires: { apis: [], env: [], local: [], blocks: [] },
    provides: { routes: true, api: !!api, models: [] },
    api_routes: !!api,
    contract: {
      inputs: [],
      outputs: [],
      events: [],
      permissions: {
        filesystem,
        network: network || 'internal',
        secrets: !!secrets,
        shell: false,          // never scaffolded true — Tier 3 is a deliberate act
        ai: !!ai,
      },
      storage: {
        type: wantsStorage ? storage : 'none',
        scope: 'block',
        local: {
          // v1.1: local stores are never search-indexed. The Vault is the
          // indexed surface; a block's operational state is not.
          indexed: false,
          retention: wantsStorage ? 'operational' : 'ephemeral',
        },
        // New blocks are scoped. 'compatibility' exists only to grandfather
        // blocks written before the storage contract and is rejected by
        // validateManifest for anything declaring v1.1.
        access: 'scoped',
      },
      memory: {
        mode: memory || 'none',
        indexed: wantsMemory,
        userConfigurable: wantsMemory,
      },
    },
  };

  if (widget) {
    manifest.widget = {
      endpoint: `/api/${id}/widget`,
      label: label || labelFromId(id),
      refresh_ms: 30000,
    };
  }

  return manifest;
}

function indexJsx(id, label, api, widget) {
  const title = label || labelFromId(id);
  return `import React${api ? ', { useEffect, useState }' : ''} from 'react';

/**
 * ${title} — block UI.
 *
 * Default-export one component. Fetch only endpoints this block's own api/
 * provides, or the kernel guarantees (/core, /api/ai, /blocks/registry).
 * Calling anything else is the rule-2 violation the collision gate exists
 * to catch, and it will not survive a route change in another block.
 */
export default function ${title.replace(/[^A-Za-z0-9]/g, '')}() {
${api ? `  const [state, setState] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    // Report the failure. A catch that swallows leaves the panel looking
    // empty rather than broken, which is strictly harder to debug.
    fetch('/api/${id}/status')
      .then((r) => r.json())
      .then(setState)
      .catch((e) => setError(e.message));
  }, []);

` : ''}  return (
    <div className="admin-card">
      <h2>${title}</h2>
${api ? `      {error && <p style={{ color: 'var(--bad, #f85149)' }}>{error}</p>}
      {!error && !state && <p>Loading…</p>}
      {state && <pre>{JSON.stringify(state, null, 2)}</pre>}
` : `      <p>Replace this with the block's UI.</p>
`}    </div>
  );
}
`;
}

function apiCjs(id, widget) {
  return `const express = require('express');

/**
 * ${id} — block API.
 *
 * NOTE: single named param, NO default. blockHost dispatches on
 * factory.length === 1; giving \`deps\` a default value makes length 0 and
 * misroutes this file into the plugin pattern.
 *
 * Routes are auto-mounted under /api/*. Declare every route you add in the
 * manifest so the collision gate can see it before it reaches a user.
 */
module.exports = function (deps) {
  const router = express.Router();

  router.get('/${id}/status', (_req, res) => {
    res.json({ ok: true, block: '${id}', ts: Date.now() });
  });
${widget ? `
  // Declared in the manifest as widget.endpoint — the dashboard reads this
  // to render the block's quick-view. Keep it cheap; it is polled.
  router.get('/${id}/widget', (_req, res) => {
    res.json({
      ok: true,
      label: '${labelFromId(id)}',
      stats: [{ label: 'Status', value: 'ready' }],
    });
  });
` : ''}
  return router;
};
`;
}

function readme(id, label, description, api, widget) {
  const title = label || labelFromId(id);
  return `# ${title}

${description || `${title} block.`}

## What it owns

_One paragraph: what this block is responsible for. Be specific — a block that
"handles data" cannot be reviewed._

## What it reads

${api ? `- \`GET /api/${id}/status\` — its own\n` : '- Nothing outside its own UI state yet.\n'}
## What it writes

_Nothing yet. If this changes, declare it in \`contract.storage\` and set
\`permissions.filesystem\` to \`write\` — the validator rejects the combination
without it._
${widget ? `
## Widget

\`GET /api/${id}/widget\` — declared in \`block.manifest.json\`. The dashboard
renders it automatically; no dashboard change is needed.
` : ''}`;
}

/**
 * Build a complete envelope payload from scaffold options.
 * Returns { ok, payload } or { ok: false, error }.
 * The caller passes `payload` to buildPipeline.submitBuild() or validateBuild().
 */
function scaffold(opts = {}) {
  const id = String(opts.id || '').trim();
  if (!id) return { ok: false, error: 'id is required' };
  if (!ID_RE.test(id)) {
    return {
      ok: false,
      // Say the rule, not just "invalid" — BO-D2e: blaming the input for a
      // vocabulary the product never stated is not a diagnosis.
      error: `id "${id}" must be lowercase letters, digits and underscores, starting with a letter (e.g. my_block)`,
    };
  }

  const api = !!opts.api;
  const widget = !!opts.widget && api; // a widget endpoint needs an api/ to serve it
  const label = (opts.label || '').trim() || labelFromId(id);

  const manifest = buildManifest({
    id,
    label,
    description: opts.description,
    category: opts.category,
    tier: opts.tier,
    icon: opts.icon,
    navGroup: opts.navGroup,
    navOrder: opts.navOrder,
    api,
    widget,
    storage: opts.storage || 'none',
    memory: opts.memory || 'none',
    network: opts.network || 'internal',
    ai: !!opts.ai,
    secrets: !!opts.secrets,
  });

  const files = [
    { path: 'index.jsx', content: indexJsx(id, label, api, widget) },
    { path: 'README.md', content: readme(id, label, opts.description, api, widget) },
  ];
  if (api) files.push({ path: `api/${id}.cjs`, content: apiCjs(id, widget) });

  return {
    ok: true,
    payload: {
      spec: opts.spec || `Scaffolded "${label}" via Master.`,
      manifest,
      files,
      estimatedDailyCost: 0,
      meta: { scaffoldedBy: 'master', scaffoldVersion: '1.0.0' },
    },
  };
}

module.exports = { scaffold, labelFromId, ID_RE };
