---
"@canopy/cli": patch
---

`canopy policies push --expect-version` accepts `_context=<n>` next to the collection pairs, so a push can
pin the version of the context lookup document explicitly. A stale pin refuses the push before anything is
published.
