# ADR-0005: Custom compiled matcher, verified by differential testing

- **Status:** Proposed (to be confirmed by spike S4)
- **Date:** 2026-11-05
- **Related:** [02 §6](../plan/02-document-level-security.md#6-allowed-operators), [03 §6](../plan/03-realtime-engine.md#6-candidate-selection-the-predicate-index), [05 §5](../plan/05-client-sdk.md#5-live-queries)

## Context

The matcher is the hottest code path (events × candidates) and the most security-sensitive one. If it disagrees
with MongoDB, realtime and REST give different answers, which can mean a data leak. It also ships in the client
SDK (≤ 15 kB budget) for optimistic predictions, and in the edge worker.

## Decision

- Build **`@canopy/matcher`**:
  - compiles filters into closures;
  - implements BSON comparison order and type bracketing, array traversal and `null`/missing semantics, sort
    order, projection, and update operators (the updater);
  - covers only the **matcher-safe operator set**.
- **MongoDB is the test oracle.** Generated documents and queries run through both the matcher and a real
  `find()` on MongoDB 7.0, 8.0 and the latest 8.x, and must agree.
- Anything outside the verified set (non-simple collation, `$text`, geo, PCRE-only regex, `$expr`) is never
  matched in-process. It goes to the polling observer on the server, and gets no local prediction on the client.
- Spike S4 compares this approach with adopting an existing library (for example Mingo or sift) behind the same
  interface. A library is adopted only if it passes the differential suite and meets the speed and size budgets.

## Consequences

- **Positive:** full control over performance, allocation and bundle size; one implementation shared by server,
  edge and client; semantics that can be proven equivalent for the supported set.
- **Negative:** an ongoing maintenance burden, and every new operator needs differential coverage before it
  becomes matcher-safe.

## Alternatives considered

| Option | Why not (pending S4) |
|---|---|
| Adopt Mingo | Broad operator coverage, but larger bundles, and fidelity to MongoDB must still be proven by the same tests |
| Adopt sift | Small and fast, but narrower semantics; fidelity unproven |
| Evaluate every event in MongoDB (`$match` per subscriber) | Database load grows with subscriber count (see ADR-0004) |
