---
"@canopy/devtools": minor
---

Add `@canopy/devtools`. `attachDevtools(client)` mounts an in-page panel with the connection and transport, the subscriptions with their status and document counts, each subscription's documents with their cluster times, the pending mutations (with discard) and stale ones (with retry and discard), and a protocol log with `seq` and `ct`. It uses DOM APIs only, so it works with any framework and under a strict CSP. `watchMistakes(client)`, on by default in the panel, warns once about a subscription without `limit` whose result is large, a query the client cannot evaluate locally, and mutations rolled back by policies.
