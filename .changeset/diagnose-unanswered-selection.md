---
"@canopy/protocol": patch
---

`diagnoseMongoError` reports a server selection timeout in which no listed server ever answered as
"cannot reach MongoDB" instead of "no member matched the connection string". Deno on Windows reports a
refused connection that way, without a network error.
