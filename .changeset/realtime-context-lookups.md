---
"@canopy/realtime": minor
"@canopy/policy": minor
---

Enforce context lookups (`$ctx`) in realtime. Subscriptions and mutations over the socket resolve the
lookups their collection's policies use, and the change stream now also covers every lookup's source
collection. When a membership changes, the affected subjects' lookups are resolved again and their
subscriptions move to the new effective query without a `resync`: the client receives `added` for documents
that became visible and `removed` for those that did not stay. A session holds its lookups for as long as
it lives, lookups that fail with an error or a timeout are retried after `contextRetryMs` (5 s), and claim
changes, policy reloads that change the lookups, and stream restarts resolve them again. Pass `contexts` to
share one `ContextResolver` with the REST handler. New metrics: `canopy_ctx_lookup_failures_total`,
`canopy_ctx_invalidations_total` and `canopy_realtime_rebinds_total`. `ResolvedContext.failed` lists the
lookups that failed for a transient reason.
