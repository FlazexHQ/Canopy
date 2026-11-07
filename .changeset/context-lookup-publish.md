---
"@canopy/server": minor
"@canopy/cli": minor
---

Publish context lookups (`_context`) through the policy lifecycle: `PolicyStore.publishContexts()` validates
them against every stored collection, refuses `ctx-` lint errors, versions them with `expectedVersion`,
records `policy_history` and audits `context.publish`; `rollbackContexts()` republishes an earlier version.
The admin API gains `GET /contexts`, `POST /contexts/validate`, `POST /contexts/publish`,
`GET /contexts/history` and `POST /contexts/rollback`. `canopy policies push` now publishes changed context
lookups first, so new lookups exist before the collections that use them, and `policies history` and
`policies rollback` accept `_context`. Clauses sent as EJSON values keep their BSON types (an ObjectId no
longer becomes a string).
