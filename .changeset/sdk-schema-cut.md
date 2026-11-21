---
"@canopy/cli": major
"@canopy/client": major
---

Remove `canopy gen types` and `canopy dev --types`. Use `canopy pull` to create a schema and `canopy schema diff` to check drift in CI.

Derived live queries now expose only reads at runtime. Call write methods on the collection returned by `client.from()`. Move any intended write filter to `updateMany()` or a mutation condition.
