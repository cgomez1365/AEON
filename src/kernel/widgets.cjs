/**
 * Widget catalogue — the CONSUMER side of the widget contract.
 *
 * Until 2026-08-04 this contract had a producer and no consumer:
 * blockStandard.cjs:195 passed `manifest.widget` straight through to the
 * registry, `master` was the only block of 17 that declared one, and nothing
 * anywhere rendered it. "Add a block and settings gains a control surface"
 * was true of the data model and false of the product — a claim-discipline
 * violation (Bible p30) sitting at the centre of the pitch.
 *
 * This module turns the declaration into a catalogue settings can render, and
 * — the half that makes it least-privilege rather than decoration (Bible p04)
 * — states the scope each widget may reach, derived from its own manifest.
 *
 * TWO RULES, both enforced here rather than trusted to block code:
 *
 *  1. A widget may only name an endpoint inside its OWN block namespace.
 *     A block does not get to point its settings card at another block's
 *     route. This is the "refused something undeclared" gate (DoD #4).
 *
 *  2. Absence is the correct rendering of absence. A block declaring no
 *     widget contributes NOTHING — no placeholder, no empty card, no
 *     disabled control. It is simply not in the catalogue.
 *
 * Refusals are returned, never swallowed (R-05). A malformed widget
 * declaration is an operator-visible fact, not a silent omission.
 */

// Endpoint must live under the block's own /api/<id>/ prefix. Anchored, and
// the trailing slash matters: /api/masterfoo must not pass as /api/master.
function ownNamespace(id) {
  return `/api/${id}/`;
}

/**
 * Scope a widget may reach, derived from the manifest and nothing else.
 * This is the same information createScopedDeps() uses server-side, restated
 * for the surface the operator actually looks at — so what settings SAYS a
 * widget can touch and what the kernel LETS it touch have one source.
 */
function deriveScope(manifest) {
  const perms = (manifest && manifest.contract && manifest.contract.permissions) || {};
  const storage = (manifest && manifest.contract && manifest.contract.storage) || {};
  return {
    filesystem: perms.filesystem || 'none',
    network: perms.network || 'none',
    secrets: perms.secrets === true,
    shell: perms.shell === true,
    ai: perms.ai === true,
    storage: storage.scope === 'block' ? 'block' : (storage.scope || 'none'),
  };
}

/**
 * Human-readable one-liner for the card. Says what the widget may touch, so
 * the operator can read least privilege rather than take it on faith.
 */
function describeScope(scope) {
  const granted = [];
  if (scope.filesystem && scope.filesystem !== 'none') granted.push(`filesystem: ${scope.filesystem}`);
  if (scope.network && scope.network !== 'none') granted.push(`network: ${scope.network}`);
  if (scope.secrets) granted.push('secrets');
  if (scope.shell) granted.push('shell');
  if (scope.ai) granted.push('AI');
  if (scope.storage && scope.storage !== 'none') granted.push(`storage: ${scope.storage}`);
  return granted.length ? granted.join(' · ') : 'no host access';
}

/**
 * Build the catalogue from a block registry (normalized manifests).
 *
 * @param {Array} registry  entries from blockStandard.normalizeManifest
 * @returns {{ widgets: Array, refused: Array }}
 */
function buildWidgetCatalogue(registry) {
  const widgets = [];
  const refused = [];
  const list = Array.isArray(registry) ? registry : [];

  for (const block of list) {
    if (!block || !block.id) continue;
    const w = block.widget;

    // Rule 2 — absence renders as absence. Not a refusal; nothing was claimed.
    if (w === null || w === undefined) continue;

    const refuse = (reason) => refused.push({ id: block.id, reason });

    if (typeof w !== 'object' || Array.isArray(w)) {
      refuse('widget must be an object');
      continue;
    }
    if (typeof w.endpoint !== 'string' || !w.endpoint) {
      refuse('widget.endpoint is required');
      continue;
    }

    // Rule 1 — own namespace only. A widget pointing at another block's route
    // is reaching for something its manifest never declared.
    const prefix = ownNamespace(block.id);
    if (!w.endpoint.startsWith(prefix)) {
      refuse(`widget.endpoint must start with ${prefix} — declared ${w.endpoint}`);
      continue;
    }
    // No traversal out of the namespace by way of the path itself.
    if (w.endpoint.includes('..')) {
      refuse('widget.endpoint must not contain ".."');
      continue;
    }

    const scope = deriveScope(block);
    widgets.push({
      id: block.id,
      label: typeof w.label === 'string' && w.label ? w.label : (block.label || block.id),
      endpoint: w.endpoint,
      // Clamp refresh: 0/absent means "do not poll". Floor of 5s so a manifest
      // cannot ask settings to hammer a route.
      refresh_ms: Number.isFinite(w.refresh_ms) && w.refresh_ms > 0
        ? Math.max(5000, Math.floor(w.refresh_ms))
        : 0,
      scope,
      scopeLabel: describeScope(scope),
      ready: block.readiness ? block.readiness.ready !== false : true,
    });
  }

  widgets.sort((a, b) => a.id.localeCompare(b.id));
  refused.sort((a, b) => a.id.localeCompare(b.id));
  return { widgets, refused };
}

module.exports = { buildWidgetCatalogue, deriveScope, describeScope, ownNamespace };
