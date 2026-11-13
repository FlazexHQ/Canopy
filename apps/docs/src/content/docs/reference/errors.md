---
title: Error codes
description: The stable CANOPY_* error codes, their HTTP statuses and the client error classes.
---

Every error Canopy returns carries one of these codes, on every surface: REST problem documents, GraphQL
`extensions.code`, realtime `nosub`, `ack` and `err` frames, and the client's error classes. Codes are stable;
messages are for people and may change.

| Code                            | HTTP | Client class           | Meaning                                                                           |
| ------------------------------- | ---- | ---------------------- | --------------------------------------------------------------------------------- |
| `CANOPY_UNAUTHORIZED`           | 401  | `UnauthorizedError`    | No valid API key or token                                                         |
| `CANOPY_TOKEN_EXPIRED`          | 401  | `UnauthorizedError`    | The token expired; refresh it and retry                                           |
| `CANOPY_FORBIDDEN`              | 403  | `ForbiddenError`       | The caller may not use this operation or collection at all                        |
| `CANOPY_NOT_FOUND`              | 404  | `NotFoundError`        | No such document or collection, or none the caller may see                        |
| `CANOPY_POLICY_VIOLATION`       | 403  | `PolicyViolationError` | A write failed a policy's `where` or `check`, or a field rule                     |
| `CANOPY_INVALID_QUERY`          | 400  | `InvalidQueryError`    | A malformed or disallowed filter, sort, projection or update; also GraphQL limits |
| `CANOPY_CONFLICT`               | 409  | `ConflictError`        | A `where` precondition did not hold                                               |
| `CANOPY_DUPLICATE_KEY`          | 409  | `CanopyError`          | A unique index refused the write                                                  |
| `CANOPY_PAYLOAD_TOO_LARGE`      | 413  | `CanopyError`          | The body or document is over the size limit                                       |
| `CANOPY_VALIDATION_FAILED`      | 422  | `ValidationError`      | The collection's validator refused the document                                   |
| `CANOPY_RATE_LIMITED`           | 429  | `RateLimitError`       | Too many requests or messages; wait for `Retry-After` (REST, GraphQL) or `retryAfterSeconds` |
| `CANOPY_LIMIT_SUBSCRIPTIONS`    | 429  | `CanopyError`          | Too many live queries on one connection                                           |
| `CANOPY_SUBSCRIPTION_TOO_LARGE` | 400  | `CanopyError`          | A live query's result is over the limit; add or lower `limit`                     |
| `CANOPY_BULK_LIMIT`             | 400  | `CanopyError`          | A bulk write matched more documents than allowed                                  |
| `CANOPY_COLLECTION_DROPPED`     | 410  | `CanopyError`          | The collection was dropped or renamed under a live query                          |
| `CANOPY_SESSION_MOVED`          | 409  | `CanopyError`          | The realtime session was resumed on another connection                            |
| `CANOPY_PROTOCOL_ERROR`         | 400  | `CanopyError`          | A malformed protocol frame                                                        |
| `CANOPY_TIMEOUT`                | 504  | `CanopyError`          | The operation took too long and was abandoned                                     |
| `CANOPY_UNAVAILABLE`            | 503  | `CanopyError`          | Canopy or MongoDB is not available; retry with backoff                            |
| `CANOPY_INTERNAL`               | 500  | `CanopyError`          | An unexpected error; the message is withheld and the request id logged            |
| `CANOPY_AUTH_HOOK_FAILED`       | 500  | `CanopyError`          | The claims hook of built in auth failed, so no token was issued                   |
| `CANOPY_CONFIG_INVALID`         |      |                        | The configuration does not validate; local only, never sent                       |

Codes without a class of their own arrive as `CanopyError`; check `error.code`.

```ts
import { isCanopyError, PolicyViolationError } from "@canopy/client"

try {
  await canopy.update("todos", id, { $set: { ownerId: "someone else" } })
} catch (error) {
  if (error instanceof PolicyViolationError) showToast("You cannot do that")
  else if (isCanopyError(error) && error.code === "CANOPY_UNAVAILABLE") retryLater()
  else throw error
}
```
