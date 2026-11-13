---
title: Rate limits
description: Limit how much one caller can ask of the Data API, GraphQL and realtime.
---

Canopy limits the data plane per caller, in memory, with token buckets: a caller starts with a full bucket
(the burst), spends one token per request and earns tokens back at a steady rate. Short bursts pass; a sustained
excess gets `CANOPY_RATE_LIMITED`.

| Traffic                                      | Costs one token | Default                    |
| -------------------------------------------- | --------------- | -------------------------- |
| REST and GraphQL requests                    | each request    | 50 per second, burst 200   |
| Realtime `sub`, `mut` and `auth` frames      | each frame      | 20 per second, burst 100   |
| Anonymous realtime connections per address   | each connection | 50 open at a time          |

Pings, `unsub` and `bye` are free, so a connection never gets cut off for staying alive. A batched GraphQL request
costs one token however many operations it holds (the `maxBatch` limit bounds it).

## Who is counted

A caller is the API key together with the subject of its token, so every signed in user has a budget of their own
and one noisy user cannot use up another's. Anonymous callers all share the publishable key, so they are counted
by client address as well. The address is the socket peer, or, when the peer is one of `server.trustedProxies`,
the rightmost `X-Forwarded-For` hop that is not a trusted proxy. Behind a load balancer, list its address
there; without it every anonymous caller looks like the balancer and shares one budget.

The `service` role (secret keys) is exempt by default, because servers legitimately burst. Set
`exemptService: false` to limit it too.

## What a refused caller sees

REST answers `429` with a `Retry-After` header (whole seconds) and the `CANOPY_RATE_LIMITED` problem, before any
policy or database work. GraphQL answers `429` with the same header and a `CANOPY_RATE_LIMITED` error in
`errors`; over graphql-ws the operation fails with that error. Both include `retryAfterSeconds` in the error
details, and browsers can read `Retry-After` when CORS is configured.

Realtime keeps the connection and answers in the reply of the frame it refused, with the same code:

| Frame  | Reply                                              |
| ------ | -------------------------------------------------- |
| `sub`  | `nosub` with `err`                                 |
| `mut`  | `ack` with `ok: false` and `err`                   |
| `auth` | an `err` frame (the connection stays authenticated) |

A connection over the anonymous address cap is refused at the handshake with an `err` frame and close code
`4029`, which the SDK treats as "reconnect with extended backoff".

## Configuration

```ts
export default defineConfig({
  rateLimits: {
    requests: { perSecond: 100, burst: 400 },
    messages: { perSecond: 40, burst: 200 },
    anonymousConnectionsPerAddress: 100,
    exemptService: true,
  },
})
```

`rateLimits: false` turns every limit off. Each value also has a variable: `CANOPY_RATE_LIMITS=false`,
`CANOPY_RATE_LIMIT_REQUESTS`, `CANOPY_RATE_LIMIT_REQUEST_BURST`, `CANOPY_RATE_LIMIT_MESSAGES`,
`CANOPY_RATE_LIMIT_MESSAGE_BURST`, `CANOPY_RATE_LIMIT_ANONYMOUS_CONNECTIONS` and
`CANOPY_RATE_LIMIT_EXEMPT_SERVICE`. See the [configuration reference](/reference/configuration/#ratelimits).

## Limits are per instance

Counters live in the memory of one process. With several instances behind a load balancer each counts on its
own, so the effective limit is the setting times the number of instances, and a restart resets the buckets.
This stops a runaway client or a naive scraper; it is not a billing meter. Sharing the counters between
instances is not built yet.

## Metrics

`canopy_http_rate_limited_total{surface="rest"|"graphql"}` and
`canopy_realtime_rate_limited_total{kind="message"|"connection"}` count the refusals on the metrics port. A
steady rate of them means a client is looping, or the limits are too low for the app.

Failed sign ins to the admin surface and to built in auth have their own limits and are not part of this.
