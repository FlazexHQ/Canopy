---
"@canopy/graphql": patch
---

Serializing an invalid `Date` as `DateTime` (or any value Extended JSON cannot encode) now fails with the
usual `CANOPY_INVALID_QUERY` GraphQL error instead of an internal error raised while describing the value.
