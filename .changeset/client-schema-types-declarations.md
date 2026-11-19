---
"@canopy/client": patch
---

The published declarations of `createClient` and `createRestClient` type check in an app that registers a
schema and compiles with `skipLibCheck: false`: `SchemaTypes` now satisfies the client's schema constraint
for a generic schema, with both `bundler` and `nodenext` module resolution.
