---
"@canopy/client": minor
---

The REST reader adds `distinct(field, filter)` on typed paths (an array field gives its element values) and
`aggregate(pipeline)` under the caller's policies. Aggregation output is `unknown` unless `decode` checks it
with a Standard Schema validator, such as a collection definition; a document that does not match fails the
call with a `ValidationError` naming the document and the field.
