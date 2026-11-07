---
"@canopy/policy": minor
---

Add `ContextResolver`, which resolves declared context lookups (`$ctx`) with service privileges through an
injected reader and caches each result per lookup and substituted `where` clause, so subjects never share
results. A result with more than `max` documents, a reader error or a timeout (1 s by default) leaves the
lookup without a value, so the policies that use it do not match. `invalidate()` drops cached results that a
change of the source collection may affect (its pre or post image matches `where`, or the document was part
of the result), a lookup that is still running when such a change arrives is read again instead of cached,
and entries expire after their `ttl`. `retain()` and `onInvalidate()` let realtime keep live subscriptions
current. `PolicyEngine.contextNames()` lists the lookups a request needs.
