---
title: Rate limited
description: Too many requests, messages or failed sign ins from this caller.
---

**Code:** `CANOPY_RATE_LIMITED` (HTTP 429)

Canopy limits the data plane per caller with token buckets: REST and GraphQL requests, realtime frames that
start work, anonymous connections per address, and failed authentications per address. Over the budget, REST
and GraphQL answer `429` with `Retry-After`, and realtime answers in the reply of the refused frame.

## Fix

- Wait for `Retry-After` (REST, GraphQL) or `details.retryAfterSeconds` before retrying.
- Look for a client that loops: `canopy_http_rate_limited_total` and `canopy_realtime_rate_limited_total` on
  the metrics port count the refusals.
- Behind a load balancer, list it in `server.trustedProxies`, or every anonymous caller shares its budget.
- Raise the limits in `rateLimits` if real traffic needs more; see [rate limits](/guides/rate-limits/).
