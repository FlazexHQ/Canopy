---
"@canopy/server": minor
"@canopy/studio": minor
"@canopy/schema": major
"@canopy/cli": major
"@canopy/graphql": patch
"@canopy/storage": patch
---

Canopy runs as separate containers. `CANOPY_ROLE` picks what one `canopy-server` process runs: `all` (the
default), `api` (REST, GraphQL, auth, storage, the admin API and webhooks, with GraphQL subscriptions sent to
`CANOPY_REALTIME_URL`) or `realtime` (realtime connections and mutations only). `planServerRole` and
`parseServerRole` expose the same split to embedders. `@canopy/studio` adds `canopy-studio`, a standalone
server for Studio, and `studioService`. The client SDK and framework bindings moved to `canopy.js`, one package
in its own repository: generated types and `canopy pull` now import from `canopy.js` and `canopy.js/schema`,
and `canopy init` scaffolds config and policy files that import `canopy.js/config` and `canopy.js/policy`.
