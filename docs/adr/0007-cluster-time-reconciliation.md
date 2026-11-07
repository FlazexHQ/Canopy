# ADR-0007: Cluster-time reconciliation and echo-before-ack

- **Status:** Proposed (validated by spikes S2 and S7)
- **Date:** 2026-11-05
- **Related:** [03 §5.3](../plan/03-realtime-engine.md#53-snapshot-consistency-register-then-snapshot), [03 §9](../plan/03-realtime-engine.md#9-mutations-over-the-socket-and-echo-before-ack), [05 §4 to §6](../plan/05-client-sdk.md#4-local-store)

## Context

Live queries must line snapshots up with the event stream exactly. Optimistic UI must know when a mutation's
effect is reflected in server state, without adding version fields to user documents (ADR-0011).

## Decision

- **Cluster time (`ct`) is the version.**
  - Snapshots are taken at a known time `T` (a snapshot session); buffered events with `ct ≤ T` are discarded.
  - Every cached document carries the `ct` of its state, and incoming state applies only if `ct ≥ current`.
    Ties are applied because `set` values are absolute, so reapplying is idempotent.
- **Echo-before-ack.** A gateway acknowledges a socket mutation only after it has processed the change events
  caused by that mutation, so its fan-out to the connection comes first. Correlation is per document,
  `(ns, _id, ct ≥ T)`, because cluster time is **not unique per event**: events in a transaction share one, and
  since MongoDB 8.0 unrelated events can too. If the echo times out (2 s), the ack carries post-images.
- The SDK drops an optimistic layer when it receives an echoed ack, or when post-images arrive.

## Consequences

- **Positive:**
  - no schema changes;
  - no flicker when optimistic layers are dropped;
  - REST and realtime results line up through `ct`;
  - duplicates and replays are harmless.
- **Negative:** relies on driver access to snapshot and operation times (S2) and on careful correlation (S7).
  Edge mode only guarantees order per document.

## Alternatives considered

| Option | Why not |
|---|---|
| A version field in every document (`_v`) | Changes the user's schema |
| Client-side timestamps | Clock skew; not authoritative |
| A heartbeat document in the app DB as a watermark | Writes into the user's database |
| CRDTs | Outside the 1.0 scope (online-first) |
