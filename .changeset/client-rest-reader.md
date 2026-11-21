---
"@canopy/client": minor
"@canopy/protocol": patch
---

`@canopy/client/rest` is a stateless reader of the Data API: `createRestClient({ url, publishableKey, auth,
schema }).from("todos").find({ done: false }).fields({ title: 1 }).limit(20).page({ signal })` reads a page
under the caller's Document Level Security, with `page.next` to follow the cursor, plus `findById` and
`count` (with its exactness). Building a query sends nothing; only `page`, `findById` and `count` fetch. It
asks for the caller's token on every request, sends canonical Extended JSON (IDs too, so a string that looks
like an ObjectId stays a string), validates every response envelope, keeps the server's typed errors with
their hint, details and request ID, honours `AbortSignal` and an optional `timeoutMs`, and never opens a
WebSocket. `createServerClient` now reads through it, and its errors carry the same details.
`errorFromWire` takes optional error options.
