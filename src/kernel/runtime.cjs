/**
 * Runtime shim — the ONE place AEON asks "am I running in the cloud?"
 *
 * BO-A3a stage 2. Measured at f94a6ae: 149 conditionals across 41 files, and
 * they are overwhelmingly SUBTRACTIVE —
 *
 *   if (isVercel) return res.json({ success: false, reason: 'cloud env — nothing to push' })
 *
 * Vercel mode largely turns AEON off. Two scheduled crons pointed at routes
 * that never existed and had been firing into a 404 on a schedule (removed
 * 08-03). Deletion is the right end state; this is not that.
 *
 * What this file does is make the surface COUNTABLE. Every runtime read routes
 * through isCloud(), a scanner counts the call sites, and a gate asserts the
 * count only ever falls. That converts stage 3 — deleting the branches block by
 * block — from a gamble across 41 files into an afternoon with a ratchet
 * behind it.
 *
 * NOTHING BEHAVIOURAL CHANGES HERE. isCloud() is exactly `!!process.env.VERCEL`,
 * the same expression the nine server-side `const isVercel = ...` declarations
 * used. If that ever stops being true, this comment is a lie and the tests
 * pinning it should fail.
 *
 * Deliberately NOT cached in a module-level constant: tests set and delete
 * process.env.VERCEL between cases, and a snapshot taken at require-time would
 * freeze whichever value happened to be present when the module first loaded.
 */

/** True when running on Vercel's serverless platform. */
function isCloud() {
  return !!process.env.VERCEL;
}

/** True when running on the operator's own machine. The common case. */
function isLocal() {
  return !isCloud();
}

/** 'cloud' | 'local' — the string form several call sites already build by hand. */
function runtimeName() {
  return isCloud() ? 'cloud' : 'local';
}

module.exports = { isCloud, isLocal, runtimeName };
