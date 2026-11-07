# ADR-0004: One change stream per deployment with in-process matching

- **Status:** Proposed
- **Date:** 2026-11-05
- **Related:** [03 §3 to §7](../plan/03-realtime-engine.md), spike S1

## Context

Thousands of clients subscribe to different filtered queries under different DLS contexts. Every change must
reach exactly the subscribers allowed to see it, in order, with low latency, and without overloading MongoDB.

## Decision

- Each Canopy node opens **one change stream on the app DB** (plus a small one on the meta DB). In hub mode,
  a single leader-elected stream feeds a bus instead.
- Events are matched **in memory** against observers (deduplicated effective queries). Candidates are narrowed
  first by a **predicate index** (equality conjuncts, usually the user or tenant fields from policies), a
  **membership index** and a **path index**.
- Queries that aren't matcher-safe fall back to a **polling observer** (re-query and diff, throttled).

## Consequences

- **Positive:**
  - MongoDB serves a constant number of streams;
  - the cost per event grows with the number of *affected* subscribers rather than the total;
  - authorization needs no database round trip per subscriber;
  - one ordered stream gives total order per node.
- **Negative:**
  - every node processes every event in independent mode, which needs hub mode at very high scale;
  - stateful observers use memory;
  - correctness depends on the matcher matching MongoDB's semantics (ADR-0005).

## Alternatives considered

| Option | Why not |
|---|---|
| One change stream per subscription or client | Each stream is a server-side cursor that scans the oplog; thousands of them would overwhelm MongoDB |
| One stream per collection | More streams and no cross-collection ordering, with little benefit over `$match` on one stream |
| Re-query the database per event per subscriber (as Supabase Postgres Changes does for RLS) | Cost grows with subscriber count, which Supabase's own docs describe as a scaling limit |
| Poll and diff everything (Meteor's polling driver) | Simple, but costly and slow. Kept only as a fallback. |
