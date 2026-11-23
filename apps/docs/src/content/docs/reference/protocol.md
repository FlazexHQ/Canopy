---
title: Wire protocol
description: The canopy.v1 realtime protocol, for SDK authors and gateways.
---

`canopy.v1` is the protocol between clients and Canopy realtime. It runs over a WebSocket on `/realtime/v1`
with the subprotocol `canopy.v1+json`, or over server sent events and long polling with the same frames. Values
are Extended JSON (canonical for ObjectId, dates, Decimal128, Long and binary).

Conformance vectors in the repository (`conformance/protocol/*.json`) describe exact exchanges; every official SDK and
binding runs them in CI.

## Client frames

| `t`     | Fields                                           | Meaning                                                                                                 |
| ------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `hello` | `v`, `key`, `token?`, `resume?`, `caps?`, `sdk?` | The first frame: protocol version, publishable key, user token and an optional `{ sid, seq }` to resume |
| `auth`  | `token`                                          | Replaces the user token; an empty token downgrades to `anon`                                            |
| `sub`   | `id`, `c`, `q`, `o?`                             | Subscribes to a live query `q = { filter, sort, limit, fields }` on collection `c`                      |
| `unsub` | `id`                                             | Ends a subscription                                                                                     |
| `mut`   | `id`, `c`, `op`, `args`                          | A mutation; `id` is a UUIDv7 that is also the idempotency key                                           |
| `ping`  | `ts`                                             | Application heartbeat                                                                                   |
| `bye`   |                                                  | Graceful close; the server discards the session                                                         |

Mutation operations are `insert`, `insertMany`, `update`, `updateMany`, `replace`, `delete` and `deleteMany`.

## Server frames

Every server frame except `pong` and `batch` carries `seq`, which increases by one per frame on a session
(the frames inside a `batch` carry their own). A client that sees a gap reconnects and resumes from its last
`seq`.

| `t`         | Fields                                                          | Meaning                                                                            |
| ----------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `welcome`   | `sid`, `v`, `resumed`, `hb`, `pv`, `ct`, `caps`, `limits`       | The handshake result: session id, heartbeat interval, policy version, cluster time |
| `added`     | `c`, `id`, `d?`, `ct`, `s`                                      | A document enters the subscriptions `s`                                            |
| `changed`   | `c`, `id`, `ct`, `set?`, `unset?`, `d?`, `replace?`, `refetch?` | A document changed; applied once to the cache                                      |
| `removed`   | `c`, `id`, `ct`, `s`                                            | A document leaves the subscriptions `s`                                            |
| `ready`     | `s`, `ct`, `explain?`                                           | The initial snapshot of subscription `s` is complete                               |
| `nosub`     | `s`, `err?`                                                     | A subscription ended, with the reason                                              |
| `ack`       | `m`, `ok`, `ct?`, `echo?`, `res?`, `replayed?`, `err?`          | The result of mutation `m`, sent after its change events                           |
| `wm`        | `ct`                                                            | A watermark: everything up to `ct` has been delivered                              |
| `resync`    | `reason`, `s?`                                                  | Gap free delivery is no longer guaranteed; snapshot again                          |
| `reconnect` | `retryAfterMs`, `reason`                                        | The server is draining; reconnect elsewhere and resume                             |
| `err`       | `code`, `msg`                                                   | A connection level error                                                           |
| `pong`      |                                                                 | The answer to `ping`                                                               |
| `batch`     | `m`                                                             | Several sequenced frames delivered together                                        |

## Cluster times

`ct` is a MongoDB cluster time on the wire: the decimal string of the 64 bit value
`(seconds << 32) | increment`. Two of them compare by length first, then character by character. Clients use it to order server
state, to drop optimistic changes once the server has caught up with an acknowledged mutation, and to hand
over from server rendered snapshots to live subscriptions.

## Close codes

| Code | Meaning             | The client                                  |
| ---- | ------------------- | ------------------------------------------- |
| 1000 | Normal              | Does not reconnect                          |
| 1012 | Service restart     | Reconnects at once and resumes              |
| 4001 | Unauthorized        | Refreshes its token, reconnects and resumes |
| 4003 | Forbidden           | Does not reconnect                          |
| 4008 | Hello timeout       | Reconnects and resumes                      |
| 4009 | Frame too large     | Reconnects and resumes                      |
| 4010 | Unsupported version | Does not reconnect                          |
| 4029 | Rate limited        | Waits 30 s, then reconnects and resumes     |
| 4040 | Slow consumer       | Reconnects and resumes                      |
| 4400 | Protocol error      | Reconnects without resuming                 |
| 4500 | Internal error      | Reconnects with backoff and resumes         |

`closeReaction(code)` in `@canopy/protocol` returns the exact behavior for each code; unknown codes reconnect
with backoff.
