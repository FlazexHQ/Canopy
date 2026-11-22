# ADR-0010: The edge is a fan-out tier only

- **Status:** Proposed (topology validated by spike S8)
- **Date:** 2026-11-05
- **Related:** [03 §14](../design/03-realtime-engine.md#14-canopy-edge), [04 §11](../design/04-wire-protocol.md#11-edge-relay-protocol)

## Context

Concept 3 calls for a "serverless/edge-ready socket worker". Change streams are long-lived server-side cursors
that need a stable connection near the database. Edge functions are request-scoped and globally distributed.

## Decision

- Ingestion (change streams, checkpoints, `$ctx` invalidation) **always runs in a long-lived core process**.
- **Canopy Edge** (Cloudflare Workers + Durable Objects with hibernatable WebSockets):
  - terminates client sockets;
  - receives signed, sequenced event batches from the core relay;
  - evaluates DLS with cached policy bundles;
  - delegates snapshots and writes to the core REST API using the user's JWT.
- Collections served from the edge must have pre-/post-images enabled, so visibility decisions are stateless,
  which suits hibernation.

## Consequences

- **Positive:** global, low-latency socket termination; cheap idle connections; database load doesn't depend on
  the number of edge sockets; DLS stays authoritative in the core for reads and writes.
- **Negative:** another moving part (relay, replay, bundle distribution); order is guaranteed only per document
  at the edge; requires pre-/post-images; Cloudflare-specific until other platforms are added.

## Alternatives considered

| Option | Why not |
|---|---|
| Run change streams at the edge | Not reliable or economical: long-lived cursors, driver and TCP constraints, many duplicate streams |
| Edge as a dumb TCP or WebSocket proxy | No fan-out or authorization benefit; the core still holds every socket |
| No edge tier | Simplest, and remains the default. Edge is optional and comes later (Phase 6). |
