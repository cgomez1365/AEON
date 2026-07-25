/**
 * Dynamic earlyware registry (BO4).
 *
 * A block registers cross-cutting middleware (auth guard, no-store shield) by a
 * STABLE id via the kernel's registerEarlyMiddleware hook. Re-registering the
 * same id REPLACES the prior entry instead of appending — so a Security rescan,
 * which re-requires and re-runs guardian.cjs every time, leaves exactly ONE
 * Guardian in the chain instead of stacking a new one per rescan.
 *
 * Anonymous (unlabeled) registrations always append: they can't be
 * de-duplicated, so this preserves the pre-BO4 behavior for them.
 */
function createEarlyware() {
  const entries = []; // { id, fn }

  function register(fn, id = 'anonymous') {
    if (typeof fn !== 'function') return { replaced: false, count: entries.length };
    if (id !== 'anonymous') {
      const existing = entries.findIndex((e) => e.id === id);
      if (existing >= 0) {
        entries[existing] = { id, fn };
        return { replaced: true, count: entries.length };
      }
    }
    entries.push({ id, fn });
    return { replaced: false, count: entries.length };
  }

  function remove(id) {
    const existing = entries.findIndex((e) => e.id === id);
    if (existing < 0) return false;
    entries.splice(existing, 1);
    return true;
  }

  // Express middleware: run each registered fn early, in registration order,
  // threading a shared `next` so any one can short-circuit. A thrown handler is
  // surfaced to the outer next(err), never swallowed.
  function middleware(req, res, next) {
    let i = 0;
    const run = (err) => {
      if (err) return next(err);
      const entry = entries[i++];
      if (!entry) return next();
      try { entry.fn(req, res, run); } catch (e) { next(e); }
    };
    run();
  }

  return {
    register,
    remove,
    middleware,
    list: () => entries.map((e) => e.id),
    get count() { return entries.length; },
  };
}

module.exports = { createEarlyware };
