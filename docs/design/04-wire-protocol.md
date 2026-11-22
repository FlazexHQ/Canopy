# 04: Wire protocol (`canopy.v1`)

> This is the contract between Canopy gateways (core or edge) and SDKs. It is specified independently of any
> implementation, so third-party SDKs (Swift, Kotlin, Dart, Python) can be written against it later.

## 1. Goals

- One message model for every transport: WebSocket, SSE with HTTP POST, and long-polling.
- Ordered, sequenced delivery that can be resumed; explicit `resync` when it can't be resumed.
- Server-side merge boxes, so a document is sent once per connection, not once per subscription.
- Small and easy to debug: JSON with relaxed Extended JSON values. A binary encoding is optional later.
- Additive evolution within v1, plus capability negotiation.

## 2. Transports

| Transport | Endpoint | Direction | Use |
|---|---|---|---|
| **WebSocket** | `GET /realtime/v1` with `Sec-WebSocket-Protocol: canopy.v1+json` | both | Default |
| **SSE + POST** | `POST /realtime/v1/sessions`, `GET …/sessions/{sid}/events`, `POST …/sessions/{sid}/messages` | server → client via SSE, client → server via POST | Proxies that block WebSockets |
| **Long-poll** | `GET …/sessions/{sid}/poll?after={seq}&wait=25` | server → client | Last resort |

The SDK's selection and fallback logic is described in [05 §8](05-client-sdk.md#8-fallback-transports-and-fallback-syncing).

## 3. Versioning and negotiation

- The protocol version is carried in the subprotocol (`canopy.v1+json`) and in `hello.v`. A server that can't
  speak the requested version closes with `4010`.
- Capabilities are negotiated through string flags: the client sends `hello.caps`, and the server's `welcome.caps`
  is the intersection it will use. Initial flags:
  - `batch`: the server may send `batch` containers;
  - `diff`: `changed` carries `set`/`unset` diffs instead of full documents;
  - `msgpack`: reserved for a later binary encoding.
- The optional `welcome.capabilities` object advertises endpoint features independently of `hello.caps`.
  Its `mutations` boolean indicates whether the endpoint has a realtime write path. `true` still requires
  each write to pass authorization. `false` tells SDKs to reject realtime writes, including queued writes,
  with `CANOPY_UNAVAILABLE` and roll back their optimistic changes. Applications can write through their own
  API or [Canopy REST](06-data-api.md). When the object is absent, mutation support is unknown and SDKs
  may send writes as usual.
- Within v1, changes are **additive only**. Clients must ignore unknown fields and unknown message types.
  Servers keep supporting v(N−1) for at least 12 months after vN ships.

## 4. Encoding

- UTF-8 JSON text frames. Every message has a `t` (type) field. Short keys are used on purpose; the full names
  are in the tables below.
- **Values** use *relaxed* Extended JSON v2, with three exceptions so values stay lossless:
  - int64 values outside ±2^53 use `{"$numberLong": "…"}`;
  - non-finite doubles use `{"$numberDouble": "Infinity"}`;
  - Decimal128 always uses `{"$numberDecimal": "…"}`.
- The SDK's **EJSON-lite** codec (`@canopy/protocol`) maps these to small wrapper classes (`ObjectId`, `Long`
  backed by `bigint`, `Decimal128`, `Binary`, `Timestamp`) and to `Date`. It does not need the full `bson`
  package.
- **`ct`** (cluster time) is the decimal string form of the uint64 `(seconds << 32) | increment`. Compare
  values with `BigInt`.
- **`id`** is the EJSON value of the document's `_id`. Clients key their cache on the canonical string
  `c + '/' + canonicalEJSON(id)`.

## 5. Client → server messages

| `t` | Fields | Meaning |
|---|---|---|
| `hello` | `v`, `key` (publishable or secret key), `token?` (user JWT), `resume?: {sid, seq}`, `caps?`, `sdk` | Must be the first frame, sent within 10 s. Carrying credentials in the first frame keeps tokens out of URLs and access logs. |
| `auth` | `token` | Replace the user token (refresh). An empty token downgrades the connection to `anon`. |
| `sub` | `id`, `c`, `q: {filter?, sort?, limit?, fields?}`, `o?: {buffer?}` | Subscribe to a live query. `id` is unique per connection and chosen by the client. |
| `unsub` | `id` | Stop a subscription |
| `mut` | `id` (UUIDv7 mutation ID, also the idempotency key), `c`, `op`, `args` | Mutation; see the `op` table below |
| `ping` | `ts` | App-level heartbeat |
| `bye` | n/a | Graceful close; the server discards the session (no resume) |

`mut.op` values and their `args`:

| `op` | `args` |
|---|---|
| `insert` | `{ doc }` |
| `insertMany` | `{ docs }` (≤ 1,000) |
| `update` | `{ id, update, where? }`. `where` is an extra precondition filter used for compare-and-set. |
| `updateMany` | `{ filter, update }` (requires `bulk: true` in `args`; capped by `maxBulk`) |
| `replace` | `{ id, doc, where? }` |
| `delete` | `{ id, where? }` |
| `deleteMany` | `{ filter }` (requires `bulk: true`) |

Example:

```json
{"t":"hello","v":1,"key":"canopy_pk_8f…","token":"eyJhbGciOiJFZERTQSIs…","caps":["batch","diff"],"sdk":"canopy-js/0.1.0"}
{"t":"sub","id":"s1","c":"todos","q":{"filter":{"status":"active"},"sort":{"createdAt":-1},"limit":50}}
{"t":"mut","id":"0192f6a1-7c2e-7b1a-9d3e-5f0a1b2c3d4e","c":"todos","op":"update","args":{"id":{"$oid":"6728f0c2a1b2c3d4e5f60718"},"update":{"$set":{"done":true}},"where":{"done":false}}}
```

## 6. Server → client messages

Every server message carries `seq` except `pong`. Sequence numbers increase by one per message on a
connection, and `welcome` is `seq: 0`.

| `t` | Fields | Meaning |
|---|---|---|
| `welcome` | `sid`, `v`, `resumed`, `hb` (heartbeat ms), `pv` (policy bundle hash), `ct`, `caps`, `capabilities` (optional), `limits` | Handshake result. `resumed: true` means replay follows. |
| `added` | `c`, `id`, `d?`, `ct`, `s` (sub IDs entering) | The document enters subscriptions `s`. `d` is omitted when the client already holds the document with every needed field. |
| `changed` | `c`, `id`, `ct`, `set?`, `unset?`, `d?` with `replace: true`, `refetch?` | Document-level change, applied once to the cache. `set` values are absolute, so applying them twice is harmless. |
| `removed` | `c`, `id`, `ct`, `s` (sub IDs leaving) | The document leaves subscriptions `s` |
| `ready` | `s`, `ct` | The initial snapshot of subscription `s` is complete as of `ct` |
| `nosub` | `s`, `err?` | The subscription ended (by request, denied, dropped collection or policy change) |
| `ack` | `m`, `ok`, `ct?`, `echo?`, `res?: {matched, modified, insertedIds?, docs?}`, `replayed?`, `err?` | Mutation result. With `echo: true`, every resulting event has already been delivered on this connection ([03 §9](03-realtime-engine.md#9-mutations-over-the-socket-and-echo-before-ack)). |
| `wm` | `ct` | Progress heartbeat: the gateway has processed events up to `ct`. Informational ("synced at"). |
| `resync` | `reason`, `s?` (sub IDs; omitted means all) | Gap-free delivery can't be guaranteed. Re-subscribe and diff. |
| `reconnect` | `retryAfterMs`, `reason` | The server is draining. Reconnect after the delay and attempt a resume. |
| `err` | `code`, `msg` | Connection-level error. Fatal only if a close frame follows. |
| `batch` | `m: Message[]` | A container. Each inner message carries its own `seq`. |
| `pong` | `ts` | Heartbeat reply |

Example:

```json
{"t":"welcome","seq":0,"sid":"n3.Zq8c…","v":1,"resumed":false,"hb":25000,"pv":"sha256:9f2c…","ct":"7704617278242816001","caps":["batch","diff"],"capabilities":{"mutations":true},"limits":{"subs":100}}
{"t":"added","seq":1,"c":"todos","id":{"$oid":"6728f0c2a1b2c3d4e5f60718"},"d":{"_id":{"$oid":"6728f0c2a1b2c3d4e5f60718"},"title":"Ship v0.1","done":false,"createdAt":{"$date":"2026-11-05T09:30:00Z"}},"ct":"7704617278242816001","s":["s1"]}
{"t":"ready","seq":2,"s":"s1","ct":"7704617278242816001"}
{"t":"changed","seq":3,"c":"todos","id":{"$oid":"6728f0c2a1b2c3d4e5f60718"},"ct":"7704617295422685185","set":{"done":true}}
{"t":"ack","seq":4,"m":"0192f6a1-7c2e-7b1a-9d3e-5f0a1b2c3d4e","ok":true,"ct":"7704617295422685185","echo":true,"res":{"matched":1,"modified":1}}
```

## 7. Errors and close codes

**Error codes** are shared with REST Problem Details ([06 §10](06-data-api.md#10-errors)):

| Code | Typical cause |
|---|---|
| `CANOPY_UNAUTHORIZED` / `CANOPY_TOKEN_EXPIRED` | Bad or expired token or key |
| `CANOPY_FORBIDDEN` | Operation not granted at all, key revoked, or user banned |
| `CANOPY_NOT_FOUND` | Unexposed collection or invisible document |
| `CANOPY_POLICY_VIOLATION` | A write failed `check` |
| `CANOPY_INVALID_QUERY` | Bad operator, a reference to an unreadable path, or a limit exceeded |
| `CANOPY_CONFLICT` | `where` precondition failed, or a mutation ID was reused by another subject |
| `CANOPY_RATE_LIMITED` / `CANOPY_LIMIT_SUBSCRIPTIONS` / `CANOPY_SUBSCRIPTION_TOO_LARGE` / `CANOPY_BULK_LIMIT` | Limits |
| `CANOPY_COLLECTION_DROPPED` | DDL on a subscribed collection |
| `CANOPY_TIMEOUT` / `CANOPY_UNAVAILABLE` / `CANOPY_INTERNAL` | Server-side problems |

`CANOPY_RATE_LIMITED` for a frame that is over the caller's message budget travels in the reply of that frame
(`nosub.err` for `sub`, `ack.err` with `ok: false` for `mut`, an `err` frame for `auth`) and the connection stays
open; refused frames did no work and may be sent again. A connection refused at the handshake because its
address has too many anonymous connections gets an `err` frame and close code `4029`.

**WebSocket close codes** and how the SDK should react:

| Code | Meaning | SDK reaction |
|---|---|---|
| `1000` | Normal (`bye`) | None |
| `1012` | Service restart, preceded by `reconnect` | Reconnect after `retryAfterMs`, then resume |
| `4001` | Unauthorized or token expired | Refresh the token, then reconnect |
| `4003` | Forbidden (key revoked, user banned) | Do **not** reconnect; surface the error |
| `4008` | No `hello` received in time | Reconnect with backoff |
| `4009` | Inbound frame too large | Report a bug, reconnect |
| `4010` | Unsupported protocol version | Do not reconnect; surface "upgrade SDK" |
| `4029` | Rate limited | Reconnect with extended backoff (at least 30 s) |
| `4040` | Slow consumer | Reconnect immediately, then resume |
| `4400` | Protocol error | Report a bug, reconnect with backoff |
| `4500` | Internal error | Reconnect with backoff |

## 8. Sequencing, resume and resync

1. The client stores the `sid` from `welcome` and the highest `seq` it has **fully applied**.
2. On reconnect it sends `hello { resume: { sid, seq } }`.
3. If the session is still held and its buffer covers `seq + 1` onwards, the server replies with
   `welcome { resumed: true }` and replays the missing messages in order. The client drops duplicates
   (`seq ≤ last`).
4. Otherwise the server replies with `welcome { resumed: false, sid: <new> }`. The client re-sends `sub` for every
   active subscription and reconciles the snapshots against its cache ([05 §9](05-client-sdk.md#9-resume-and-resync)).
   Pending mutations are re-sent with the **same** mutation IDs, so server-side idempotency makes this safe.
5. `resync` without a disconnect follows the same reconciliation, for the listed subscriptions only.

Delivery semantics: at most once per connection, with gap detection. Gaps are repaired by replay when possible
and by re-snapshot otherwise. Data loss is never silent.

## 9. Heartbeats and liveness

- The client sends `ping` when it has sent nothing for `hb` milliseconds (25 s by default). The server answers
  `pong`.
- The server closes a connection that has been silent for `2 × hb + 10 s`. The client treats `2 × hb` without
  any inbound frame as a dead connection and starts reconnecting.
- On Node, the server also sends protocol-level ping frames, which browsers answer automatically. This catches
  half-open TCP connections behind NATs.
- `wm` messages are sent at most once per second, and only while the gateway is idle for that connection, so
  clients can show "synced as of …".

## 10. Fallback transports (SSE and long-polling)

- `POST /realtime/v1/sessions` with `apikey` and `Authorization` headers and the `hello` payload as the JSON body
  returns `welcome`, including `sid`.
- `GET /realtime/v1/sessions/{sid}/events` returns `text/event-stream`. Each SSE event's `data:` holds one
  protocol message and its `id:` is the `seq`, so `Last-Event-ID` doubles as the resume position. The SDK uses
  `fetch()` streaming rather than `EventSource`, so the auth headers can still be sent.
- `POST /realtime/v1/sessions/{sid}/messages` takes a JSON array of client messages (`sub`, `unsub`, `mut`,
  `auth`, `ping`).
- `GET /realtime/v1/sessions/{sid}/poll?after={seq}&wait=25` returns a JSON array of messages. If nothing
  arrives within `wait` seconds, it returns an empty array.
- `DELETE /realtime/v1/sessions/{sid}` is the same as `bye`.
- **EventSource-only environments** first call `POST /realtime/v1/tickets` (with auth headers) and receive a
  single-use ticket valid for 30 s, which goes in the query string. Tokens never appear in URLs.
- **Session affinity.** `sid` is prefixed with the node ID (`n3.…`). Multi-node deployments must route
  `/realtime/v1/sessions/{sid}/…` to that node, for example with a load-balancer rule or the
  `X-Canopy-Session` header. A request that lands on the wrong node gets `409 CANOPY_SESSION_MOVED`, and the
  client creates a new session and resyncs.

> **Implementation notes (Phase 2).** `createHttpTransport()` in `@canopy/realtime` serves these endpoints on
> top of the same connection handler as WebSockets. Requests for a session carry its key in `apikey` (or a
> ticket on `events` and `poll`); the token is checked when the session opens and on `auth`. The `batch`
> capability is not negotiated over HTTP. Delivered frames are kept (1 MiB by default) until a poll's
> `after` or a stream's `Last-Event-ID` passes them, so retries are lossless; a position older than that
> gets `410` with `close: 4000`. When the server closes a session, SSE sends `event: close` with
> `{code, reason}` and polls answer with a problem carrying `close`. A `hello.resume` from any transport
> takes over a session that is still attached elsewhere.

## 11. Edge relay protocol

This is the link from core to edge in mode D ([03 §14](03-realtime-engine.md#14-canopy-edge)).

```http
POST /__canopy/relay HTTP/1.1
Host: edge.example.com
Content-Type: application/json
Content-Encoding: br
X-Canopy-Relay-Timestamp: 1793871004
X-Canopy-Relay-Signature: ed25519=Base64Url(sig over "timestamp.body")

{"v":1,"stream":"app:app","from":1201,"to":1203,"pv":"sha256:9f2c…",
 "events":[{"seq":1201,"ct":"7704617295422685185","c":"todos","op":"update","id":{"$oid":"…"},
            "pre":{…},"post":{…},"diff":{"set":{"done":true}}}]}
```

- **Integrity.** The core holds an Ed25519 relay key; the edge holds only the public key. Requests whose
  timestamp is more than 60 s off are rejected, which prevents replay.
- **Ordering and dedupe.** Relay `seq` is per stream and monotonic. Topic Durable Objects persist the last
  applied `seq` and drop duplicates. On a gap they call `GET /relay/v1/replay?stream=…&from=…` on the core,
  which keeps a bounded relay buffer. If the gap can't be filled, they send `resync` to their subscribers.
- **Sharding.** Topic DOs are sharded by `hash(c, id) % K`, so per-document order is preserved. Across
  documents in different shards, ordering at the edge is not total. This is a documented weakening of
  [03 G3](03-realtime-engine.md#1-responsibilities-and-guarantees) in edge mode.
- `pv` changes trigger a policy-bundle refetch before newer events are applied.

## 12. Conformance and evolution

- **Test vectors.** `packages/protocol/vectors/*.json` contains scripted server streams and the expected client
  cache and query states after each step. They cover added, changed and removed, multiple subscriptions per
  document, resume, resync, acks with and without echo, and coalesced frames. Every SDK (and every framework
  binding through it) must pass them.
- **Server conformance.** Scripted client sessions are replayed against a gateway backed by a seeded MongoDB.
  The expected outputs are compared after normalizing `ct` values.
- **Change process.** Any protocol change requires an RFC ([13 §3](13-open-source.md#3-contribution-model)).
  It must update the vectors and the compatibility table, and it may be released only behind a capability flag
  until both the server and the official SDK support it.
