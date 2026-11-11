---
"@canopy/policy": minor
"@canopy/rest": minor
---

Run an update by id without a transaction when its `check` cannot fail. That is the case when every condition of `CHECK(update)` is also a condition of the update's target and the update writes no top level field those conditions read, so the document still satisfies the check after the write. A policy without an explicit `check` falls back to its `using` clause, so owner style rules such as "users update their own documents" now take one majority write instead of a transaction with a read back and a commit. Updates that write a checked field, checks that ask for more than the target, operators whose field references cannot be read statically (such as `$expr`) and writes with a mutation ID keep the transaction. `@canopy/policy` exports the `checkImplied` rule.
