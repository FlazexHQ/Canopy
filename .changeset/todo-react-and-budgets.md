---
"@canopy/matcher": minor
"@canopy/realtime": patch
"@canopy/client": patch
"@canopy/react": patch
---

Add `@canopy/matcher/lite`, the matcher without the regex translator: the same results as the full entry,
except that `$regex` throws `UnsupportedQueryError`. The client uses it, which takes about 3.7 kB (min and
gzip) off the SDK; queries with `$regex` still work but trust the server for membership. `withRegexEngine`
selects the engine for custom builds.

Realtime now fails a single document `update`, `replace` or `delete` that finds no visible document with
`CANOPY_NOT_FOUND`, as REST does, instead of acknowledging zero matches; REST polling clients do the same.
The connection limit per subject now counts only connected sessions: at the limit, the subject's oldest
sessions that only wait for a resume are dropped before a new connection is refused, and a resume never
counts against it, so reloading a page many times no longer locks a user out.

The repository gains the `todo-react` example (optimistic, live, offline capable, with Playwright tests of
multiple tabs, multiple users, conflicts, rollback and offline replay).
