---
"@canopy/protocol": minor
---

Make errors and mutation outcomes easy to handle. `isCanopyError(error, code?)` narrows `error.code` and
recognizes Canopy errors from another copy of the package through a shared brand. `CANOPY_NOT_FOUND` now
decodes as `NotFoundError`, and `@canopy/client` exports `CanopyError`, `ErrorCode`, `NotFoundError` and
`UnauthorizedError`. Mutation handles that are not awaited never raise unhandled rejections (mark them with
`void`); failures still reach `onMutationError`. `client.staleMutations` lists the stale mutations, and
`onStaleMutations` listeners are called again when one is retried or discarded. `@canopy/react` adds
`useMutationError()` (the latest rolled back mutation, with `clear()`) and `useStaleMutations()`.
