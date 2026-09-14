## What and why

<!-- What changes, and the reason. Link the issue if there is one. -->

## Evidence

<!-- The test that failed before this change and passes after it, a measurement, or a CI
     run. "It works on my machine" is not evidence. -->

## Checklist

- [ ] `npm test` passes locally
- [ ] `npm run scan:release-gate` passes
- [ ] `npm run scan:audit` passes
- [ ] Every UI string, doc line and manifest field I touched is true of the code ([claim discipline](../docs/CLAIM_DISCIPLINE.md))
- [ ] Anything deleted followed the deletion protocol (proven dead, gate added first, one scoped commit)
- [ ] No secrets, `.env` values or personal data in the diff
