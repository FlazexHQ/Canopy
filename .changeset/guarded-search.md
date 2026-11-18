---
"@canopy/policy": minor
"@canopy/rest": minor
"@canopy/config": minor
"@canopy/server": minor
---

Atlas Search and vector search in Data API aggregations: `collections.<name>.search: true` allows `$search` and `$vectorSearch` as the first stage, with the read policy and field rules applied right after it. Every field a search uses must be readable for the caller, unknown operators and options are refused, and a deployment without search answers 503.
