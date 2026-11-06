---
"@canopy/query": minor
"@canopy/policy": minor
"@canopy/rest": minor
---

Add the aggregation sanitizer and `POST /rest/v1/{coll}/_aggregate`. `securePipeline` in `@canopy/policy`
puts `USING(read)` and the readable field projection in front of a caller's pipeline, rewrites `$lookup`
and `$unionWith` with the prefix of the collection they read (which the caller must be able to read),
only joins on readable foreign fields, sanitizes `$facet` and nested pipelines recursively, and rejects
stages outside the allowlist, `$function`, `$accumulator`, `$where` and system variables other than
`$$NOW`, `$$ROOT`, `$$CURRENT` and `$$REMOVE`. `@canopy/query` gains `parseExpression` and the
`expressions` option of `parseFilter` for `$expr` with pipeline variables. Aggregations run with
`maxTimeMS`, a result cap and `allowDiskUse: false` for callers other than `service`.
