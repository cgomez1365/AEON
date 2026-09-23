/**
 * Manifest route auth, enforced.
 *
 * Audit 2026-08-11 P0-02. 234 of 239 declared routes carry `"auth": true` in
 * their block manifest. blockHost.cjs contained zero occurrences of the string
 * "auth" — the declaration was read by nothing. The only protection was the
 * global guard, and authGate.guard() returns next() unconditionally when
 * guardActive() is false. With the guard off, a same-machine caller could reach
 * Settings' credential-export and connection-mutation handlers unauthenticated.
 *
 * Loopback is not authentication. The Bible's §11 lineage card says "the
 * manifest became executable governance"; for auth that sentence was false.
 * This module makes it true.
 *
 * ── The lockout constraint ──────────────────────────────────────────────
 * Enforcement is conditional on an operator account EXISTING. Before setup
 * there is nobody who could hold a session, so requiring one would make first
 * run impossible — and the standing rule is that security must never lock the
 * owner out of their own machine. Pre-account traffic is already handled by
 * authGate's first-run lockdown, which refuses off-machine callers outright.
 *
 * So the rule is precisely: once an account exists, a route that declares
 * auth:true requires a valid session — whether or not the global guard is on.
 * Turning the guard off is a convenience for the operator's own kernel traffic;
 * it was never meant to publish their credentials.
 */

/**
 * Compile a manifest route path into a matcher.
 * `/api/writer/doc/:id` matches `/api/writer/doc/abc` but not `/api/writer/doc`.
 *
 * Case-insensitive because Express routes case-insensitively: with a
 * case-sensitive matcher `/API/connections` reached the GET /api/connections
 * handler and this guard never recognised it (measured 2026-09-23).
 */
function compilePath(routePath) {
  const source = String(routePath || '')
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')  // escape regex metachars, keep : and *
    .replace(/:[A-Za-z0-9_]+/g, '[^/]+')     // :param -> one segment
    .replace(/\*/g, '.*');                   // wildcard
  return new RegExp(`^${source}/?$`, 'i');
}

/**
 * Does a declared method cover the request's method?
 *  - `ALL` covers every method. The generator emits it for computed verb lists
 *    (files' /api/notes, resume_grader's /grade); comparing `r.method === method`
 *    meant nothing ever matched it and those routes were never protected.
 *  - HEAD is served by the GET handler in Express, so a GET declaration covers it.
 */
function methodCovers(declared, method) {
  return declared === method || declared === 'ALL' || (declared === 'GET' && method === 'HEAD');
}

/**
 * Build the list of protected routes from a manifest.
 * Only routes that explicitly declare auth:true are protected — an absent or
 * false `auth` is left to the global guard, exactly as before.
 */
function protectedRoutes(manifest) {
  const routes = Array.isArray(manifest?.routes) ? manifest.routes : [];
  return routes
    .filter((r) => r && r.auth === true && r.path)
    .map((r) => ({
      method: String(r.method || 'GET').toUpperCase(),
      path: r.path,
      re: compilePath(r.path),
    }));
}

/** The path a block route was declared against, independent of mount point. */
function requestPath(req) {
  const url = req.originalUrl || req.url || '';
  return url.split('?')[0];
}

/**
 * Express middleware factory.
 *
 * @param {object} manifest  the block manifest
 * @param {object} sessions  sessionValidator instance (injected, so tests can
 *                           drive it without touching the real auth store)
 */
function manifestAuthGuard(manifest, sessions) {
  const protectedList = protectedRoutes(manifest);
  if (!protectedList.length) return (req, res, next) => next();

  return function manifestAuth(req, res, next) {
    // No account yet: nobody can hold a session. Requiring one here would make
    // first-run setup impossible. See the lockout constraint above.
    if (!sessions.hasAccount()) return next();

    const method = String(req.method || 'GET').toUpperCase();
    const p = requestPath(req);

    // OPTIONS/preflight and the documented pre-auth routes stay reachable —
    // judged on the FULL path. Inside a block router mounted at /api, req.path
    // is mount-relative ('/health'), which no pre-auth rule names, so GET
    // /api/health answered 401 here while the global gate let it through.
    if (sessions.isPreAuthRequest({ method, path: p, originalUrl: p, headers: req.headers, query: req.query })) return next();

    const hit = protectedList.find((r) => methodCovers(r.method, method) && r.re.test(p));
    if (!hit) return next();

    const session = sessions.validateSession(req);
    if (session.ok) {
      req.aeonSession = session;
      return next();
    }

    // Fail closed. R-05: say which declaration refused, so this is debuggable
    // rather than a mystery 401.
    return res.status(401).json({
      success: false,
      error: 'UNAUTHORIZED_SESSION',
      requires_auth: true,
      reason: session.reason || 'no-session',
      declaredBy: `${manifest?.id || 'block'} manifest: ${hit.method} ${hit.path}`,
    });
  };
}

module.exports = { manifestAuthGuard, protectedRoutes, compilePath, methodCovers };
