---
"@canopy/graphql": patch
"@canopy/server": patch
---

Limit the size of GraphQL request bodies (1 MiB by default, the Data API's `rest.maxBodyBytes` on the server) and answer `413` before the body is parsed or the caller is authenticated. Persisted operation hashes are looked up as own properties only, so names such as `constructor` are not found.
