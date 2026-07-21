/**
 * Track W — state machine engine (W1 schema validation + W2 interpreter + W3 vocab).
 * Pure module: no fs, no express, no LLM. The hosting block owns persistence and
 * side-effect execution; this module only decides what is allowed and what happens.
 *
 * W1 schema (DATA, not code):
 * {
 *   id, label, version,
 *   states: ["Pending", ...],
 *   initialState: "Pending",
 *   terminalStates: ["Hired", ...],
 *   transitions: [{ trigger, from, to, sideEffects: [{ type, ...args }],
 *                   permissions?: { roles?: ["admin","hr"], ownerOnly?: true } }],  // W6 — declared, never hardcoded
 *   ui?: { colors: { "Pending": "gray", ... } }   // recolor is a schema hint (W2)
 * }
 */

// W3 — CLOSED side-effect vocabulary. No additions without a schema version bump.
// This closed list is Track W's safety property: a workflow block physically
// cannot trigger Tier 2/3 actions.
const SIDE_EFFECT_VOCAB = Object.freeze({
  moveRow:   ['toColumn'],
  setField:  ['field', 'value'],
  createTab: ['tab'],
  notify:    ['message'],
  copyTo:    ['collection'],
});

function validateWorkflow(def) {
  const errors = [];
  if (!def || typeof def !== 'object') return ['definition is not an object'];
  for (const f of ['id', 'states', 'transitions', 'terminalStates', 'initialState']) {
    if (def[f] === undefined) errors.push(`missing required field: ${f}`);
  }
  if (!Array.isArray(def.states) || !def.states.length) errors.push('states must be a non-empty array');
  const states = new Set(def.states || []);
  if (def.initialState && !states.has(def.initialState)) errors.push(`initialState "${def.initialState}" not in states`);
  for (const t of def.terminalStates || []) {
    if (!states.has(t)) errors.push(`terminalState "${t}" not in states`);
  }
  for (const [i, tr] of (def.transitions || []).entries()) {
    if (!tr.trigger) errors.push(`transitions[${i}]: missing trigger`);
    if (!states.has(tr.from)) errors.push(`transitions[${i}]: from "${tr.from}" not in states`);
    if (!states.has(tr.to)) errors.push(`transitions[${i}]: to "${tr.to}" not in states`);
    if (tr.permissions !== undefined) {
      if (typeof tr.permissions !== 'object' || tr.permissions === null) errors.push(`transitions[${i}]: permissions must be an object`);
      else {
        if (tr.permissions.roles !== undefined && (!Array.isArray(tr.permissions.roles) || tr.permissions.roles.some(r => typeof r !== 'string'))) {
          errors.push(`transitions[${i}]: permissions.roles must be an array of strings`);
        }
        if (tr.permissions.ownerOnly !== undefined && typeof tr.permissions.ownerOnly !== 'boolean') {
          errors.push(`transitions[${i}]: permissions.ownerOnly must be boolean`);
        }
      }
    }
    for (const [j, fx] of (tr.sideEffects || []).entries()) {
      const spec = SIDE_EFFECT_VOCAB[fx.type];
      if (!spec) { errors.push(`transitions[${i}].sideEffects[${j}]: "${fx.type}" is not in the closed vocabulary [${Object.keys(SIDE_EFFECT_VOCAB).join(', ')}]`); continue; }
      for (const arg of spec) if (fx[arg] === undefined) errors.push(`transitions[${i}].sideEffects[${j}] (${fx.type}): missing arg "${arg}"`);
    }
  }
  return errors;
}

/**
 * W6 — permission check for a single transition. Declared in the workflow
 * schema (DATA), enforced here — never hardcoded to any specific workflow.
 * ctx = { actor: { user, roles: [] }, owner: record.owner }. No declaration
 * on the transition = open (Tier 1 default). Pure, deterministic.
 */
function canTransition(tr, ctx = {}) {
  const p = tr.permissions;
  if (!p) return { allowed: true };
  const actor = ctx.actor || {};
  const roles = actor.roles || [];
  if (p.ownerOnly === true && actor.user && ctx.owner && actor.user === ctx.owner) return { allowed: true };
  if (Array.isArray(p.roles) && p.roles.some(r => roles.includes(r))) return { allowed: true };
  if (p.ownerOnly === true && !p.roles) {
    return { allowed: false, why: `only the record owner ("${ctx.owner}") may trigger "${tr.trigger}"` };
  }
  return { allowed: false, why: `trigger "${tr.trigger}" requires role [${(p.roles || []).join(', ')}]${p.ownerOnly ? ' or record ownership' : ''}` };
}

/**
 * W2 — interpreter. Given a record's current state and a trigger, return the
 * transition result. Pure: does not mutate, does not execute effects.
 * ctx (W6, optional) = { actor: { user, roles }, owner } — enforced when the
 * transition declares permissions.
 * Returns { ok, newState?, sideEffects?, terminal?, denied?, error? }.
 */
function applyTrigger(def, currentState, trigger, ctx = {}) {
  if ((def.terminalStates || []).includes(currentState)) {
    return { ok: false, error: `"${currentState}" is terminal — no transitions out` };
  }
  const tr = (def.transitions || []).find(t => t.from === currentState && t.trigger === trigger);
  if (!tr) {
    const valid = (def.transitions || []).filter(t => t.from === currentState).map(t => t.trigger);
    return { ok: false, error: `no transition for trigger "${trigger}" from "${currentState}"`, validTriggers: valid };
  }
  const perm = canTransition(tr, ctx);
  if (!perm.allowed) return { ok: false, denied: true, error: perm.why };
  return {
    ok: true,
    newState: tr.to,
    sideEffects: tr.sideEffects || [],
    terminal: (def.terminalStates || []).includes(tr.to),
    color: def.ui?.colors?.[tr.to] || null, // schema hint, not hardcoded (W2)
  };
}

function validTriggers(def, currentState) {
  return (def.transitions || []).filter(t => t.from === currentState).map(t => ({ trigger: t.trigger, to: t.to }));
}

module.exports = { SIDE_EFFECT_VOCAB, validateWorkflow, applyTrigger, validTriggers, canTransition };
