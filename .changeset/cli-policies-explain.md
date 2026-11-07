---
"@canopy/cli": minor
"@canopy/policy": patch
---

Add `canopy policies explain <collection>`: it shows how DLS decides an operation (`--op`, default read)
for a stated caller (`--as` claims as JSON, `--roles`), policy by policy, with the effective filter for the
caller's `--filter` and the hidden fields. It runs offline from the policy files, takes context lookup
values from `--ctx`, and with `--mongodb-uri` resolves the lookups and counts the matching documents.
MongoDB failures are printed in the diagnostic format with their fix. Typed `context()` lookups also check
the `ttl` format.
