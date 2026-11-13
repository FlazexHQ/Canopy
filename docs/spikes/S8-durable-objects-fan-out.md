# S8: How should Durable Objects fan-out be designed?

- **Date:** 2026-11-12
- **Status:** done with a local prototype. Go for the topology below; the cost model is accepted as the
  planning model. A calibration run on Cloudflare itself is open (see Decision).
- **Roadmap:** [12 §4](../plan/12-roadmap.md#4-technical-spikes), success criterion "cost model and topology
  accepted", method "prototype at 10k, then 100k simulated sockets".

## Question

Canopy Edge ([03 §14](../plan/03-realtime-engine.md#14-canopy-edge)) terminates WebSockets in Durable Objects
(DOs) and fans relayed change events out to them with DLS applied. Who holds the sockets, who receives the
relay, how are events routed between the two, and what does it cost at 10k and 100k connections?

## Platform facts (Cloudflare docs, read 2026-11-12)

| Item | Value |
|---|---|
| DO requests | 1M a month included, then $0.15 per million. HTTP, RPC, alarms and WebSocket messages count. |
| Incoming WebSocket messages | Billed 20:1 (100 messages are 5 requests). Protocol pings are free. |
| Outgoing WebSocket messages | Not billed. |
| Duration | 400k GB-s a month included, then $12.50 per million GB-s, at 128 MB per active object. |
| Hibernation | Objects eligible for hibernation accrue no duration while idle. `accept()` without the Hibernation API bills the whole connection. |
| `setWebSocketAutoResponse` | Answers a fixed request (our `ping`) without waking the object: no duration. |
| Sockets per DO | At most 32,768 hibernatable sockets; CPU and memory may lower that. |
| Attachments | `serializeAttachment` up to 16,384 bytes per socket, kept across hibernation. In memory state is reset. |
| Tags | Up to 10 tags of 256 characters per socket; `getWebSockets(tag)` looks them up. |
| Request rate | Soft limit of 1,000 requests per second per object. |
| Workers Paid | $5 a month minimum. |

## Method

`docs/spikes/S8-prototype/` (not part of the build):

- `worker.js` is a Worker with two DO classes, run in workerd through Miniflare 4.20260730.0.
  - **Connection DOs** accept hibernatable sockets (`ctx.acceptWebSocket(ws, [collection, "u:" + subject])`),
    keep `{ user, collection, sid }` in the attachment, answer `ping` through the auto response, and
    deliver event batches.
  - **Topic DOs** (one per collection) receive relay batches and forward each to the connection DOs.
  - Two routing modes: **broadcast** (every batch to every connection DO, which tests every socket against
    every event) and **index** (the topic knows which connection DO holds each subject, forwards an event
    only there, and the connection DO finds the sockets by tag).
- `bench.mjs` opens 10,000 real WebSockets from Node 24 (sharded by FNV hash of the subject, 1,000 or 5,000
  per DO), then times 7 runs per scenario from the relay POST until every expected frame arrived at the clients:
  1, 100 and 1,000 private events (each visible to one user) and 1 public event (visible to everyone), plus
  1,000 inbound client messages.
- 100k sockets do not fit one Windows machine (about 16k ephemeral ports), so `model.mjs` simulates 10k and
  100k sockets: request counts, DO busy time and monthly cost per topology, calibrated with the 10k
  measurements. Workload: 4 collections, every socket a different user, 30 inbound messages per socket per
  hour, 4 reconnects per socket per day, relay batches flushed every 50 ms or 250 ms.

Machine: Windows 11, a busy desktop (a game and other apps were running), so the latencies are upper bounds.

## Results

### Prototype at 10k sockets (median of 7, relay POST to the last frame received)

| Scenario | broadcast, 1,000/DO | index, 1,000/DO | broadcast, 5,000/DO | index, 5,000/DO |
|---|---|---|---|---|
| 1 private event | 30 ms (10 DOs, 10k checks) | 15 ms (1 DO, 1 check) | 33 ms | 11 ms |
| 100 private events | 50 ms (1M checks) | 16 ms | 31 ms | 16 ms |
| 1,000 private events | 171 ms (10M checks) | 67 ms | 143 ms | 61 ms |
| 1 public event | 572 ms (10k frames) | 463 ms | 447 ms | 459 ms |
| 1,000 inbound messages, acked | 263 ms | | 170 ms | |

- Index routing makes the cost of a private event independent of the number of sockets: one forward, one
  tag lookup, one frame. Broadcast pays one forward per connection DO and one check per socket per event;
  checks cost about 10 ns each, so forwards, not checks, are what grows.
- A public event to 10k sockets takes about 0.5 s end to end locally, about 45 µs per frame including the Node
  client that receives all of them; this is the upper bound used for frame cost in the model.
- 1,000 or 5,000 sockets per DO made no measurable difference locally, because workerd runs all objects of a
  process on one thread. On Cloudflare each DO is its own single thread, so smaller DOs fan a public event out
  in parallel.
- Local workerd grew by about 335 KB per socket. That is not a production figure: locally every socket stays
  in the process, while hibernated sockets on Cloudflare are held by the runtime outside the isolate. It is the
  main number the Cloudflare calibration run must replace.

### Model: monthly cost (USD, Workers Paid included), 50 ms batches

| Sockets | Events/s | Private share | Broadcast | Index | Index, DO busy |
|---|---|---|---|---|---|
| 10k | 10 | 100 % | 49 | 14 | 0.2 % |
| 10k | 100 | 99 % | 353 | 79 | 6.7 % |
| 10k | 1,000 | 99 % | 370 | 293 | 58 % |
| 100k | 10 | 99 % | 423 | 35 | 0.5 % |
| 100k | 100 | 99 % | 3,247 | 148 | 4.9 % |
| 100k | 1,000 | 100 % | 3,232 | 427 | 1.9 % |
| 100k | 1,000 | 99 % | 3,419 | 939 | 48.6 % |

With 250 ms batches, 100k sockets at 100 events/s (99 % private) cost $120 with index routing and $681 with
broadcast; at 1,000 events/s (99 % private) $666 and $853.

- **Forwards from topic to connection DOs dominate the bill.** Every forward is a billed request, so broadcast
  multiplies the relay rate by the number of connection DOs. Index routing removes that factor for events
  that concern few users.
- **Public events cost duration, not requests.** One public event per second to 100k sockets is 100k frames
  per second; outgoing frames are free, but the CPU time to send them is billed. At 1 % public events and
  1,000 events/s, connection DOs are busy about half the time, which is also where the latency budget ends.
- **Client traffic is cheap.** Inbound messages bill at 20:1 and pings are free with the auto response, so
  100k sockets sending 30 messages an hour cost about $16 a month.
- **Batching is the main knob.** 250 ms batches cut forwards up to 5 times at high event rates, at the price
  of up to 250 ms more latency.

## Decision

**Topology accepted:**

1. **Connection DOs** hold up to 1,000 hibernatable sockets, sharded by `hash(subject) % N`, so all sockets
   of a user share one DO and a subject's DO is computable without a lookup. Sockets carry
   `{ sid, subject, exp, policyHash }` in their attachment and are tagged by collection and by subject.
   Subscription descriptors that do not fit 16 KB go to the DO's SQLite storage. `ping` is the auto response.
2. **Topic DOs**, one per `hash(collection, id) % K` shard, receive the signed relay and keep a **routing
   index**: for each connection DO, the equality keys of its subscriptions on that collection (the same
   predicate index the core uses), registered when a subscription starts and dropped when it ends. An event
   goes only to connection DOs whose keys it can match; events without an indexable key (public reads,
   range predicates) go to every connection DO subscribed to the collection.
3. **Adaptive batching:** the relay flushes after 50 ms or 500 events, whichever comes first, and the topic
   forwards one batch per connection DO per flush.
4. Connection DOs re-check every event against the subscription with the compiled matcher before sending, so
   a stale or coarse index can only cost a forward, never leak a document.

**Cost model accepted** as the planning model (`model.mjs`): about $35 a month for 100k mostly idle
connections, $120 to $150 at 100 events per second, and about $1,000 when 1 % of 1,000 events per second
reach everyone. Broadcast routing is rejected: it costs 3 to 20 times more for the same delivery.

**Open, for Phase 5:** a calibration run on Cloudflare (10k sockets from a load generator, then 100k from
several machines) to replace the local frame cost and memory per socket with production numbers, and to
check how many sockets a DO can actually hold.
