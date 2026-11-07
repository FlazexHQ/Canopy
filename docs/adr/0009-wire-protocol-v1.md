# ADR-0009: Wire protocol v1: JSON + EJSON, sequenced, resumable

- **Status:** Proposed
- **Date:** 2026-11-05
- **Related:** [04](../plan/04-wire-protocol.md)

## Context

Gateways (core and edge) and SDKs (official and future third-party) need a stable contract for subscriptions,
mutations, ordering, resume and fallback transports.

## Decision

- A Canopy-specific protocol, `canopy.v1+json`: JSON text frames with relaxed Extended JSON values (lossless
  exceptions for int64, Decimal128 and non-finite doubles), and `ct` as a uint64 decimal string.
- **Server-side merge boxes:** `changed` is per document, while `added`/`removed` carry subscription IDs.
- **A per-connection `seq`**, resume buffers, and explicit `resync`.
- The same message model over WebSocket, SSE + POST and long-poll.
- Capability flags, additive evolution within v1, test vectors for conformance, and RFCs for changes.

## Consequences

- **Positive:** easy to debug, independent of language, efficient (a document is sent once per connection),
  and open to third-party SDKs.
- **Negative:** JSON is larger and slower than binary (MessagePack is reserved as a capability); maintaining
  our own protocol means writing a spec and vectors.

## Alternatives considered

| Option | Why not |
|---|---|
| Socket.IO | Its protocol and client size come along, there is less control over ordering and resume semantics, and edge support is awkward |
| GraphQL subscriptions only | Couples realtime to GraphQL; no merge boxes, resume or optimistic ack semantics |
| Meteor DDP | Similar merge-box idea, but no resume or sequencing, and the ecosystem is tied to Meteor |
| MessagePack from day one | Harder to debug early on; kept as a later capability |
