# ADR-0011: No changes to the user's schema

- **Status:** Proposed
- **Date:** 2026-11-05, amended 2026-11-18
- **Related:** [00 §5](../design/00-vision.md#5-design-principles), [01 §6](../design/01-architecture.md#6-where-canopy-writes-data),
  [ADR-0015](0015-reach-through-mongodb.md), [15](../design/15-mongodb-depth.md)

## Context

Concept 1 promises to drop into "any existing Mongo project without altering your current database schema or
API layer". Teams will only adopt it if they can trust that Canopy leaves their data alone.

## Decision

- Canopy **never** writes fields into user documents and **never** creates collections in the app DB on its
  own. It only writes app data on behalf of callers through its APIs.
- All Canopy state lives in separate databases (`canopy`, `canopy_auth`) on the same deployment.
- Anything that changes the database is **opt-in, explicit and run by the CLI with admin credentials**:
  enabling pre-/post-images (`collMod`) and creating suggested indexes.
- **Amendment (2026-11-18, Q16):** an admin may also have Canopy apply search and vector search indexes,
  validators, views and materialized view targets in the app DB. Each change runs only from an explicit admin
  action (the CLI, Studio or the admin API, with admin credentials), is shown as a plan before it is applied,
  and writes an entry to the audit log. Nothing is applied at startup or as a side effect of configuration
  alone. Collections Canopy creates this way belong to the user afterwards and are never removed silently.
- An automated Phase 1 test checks this: collections, indexes and sample documents are compared before and
  after running the full test suite in sidecar mode, and the same check runs with the server started from a
  configuration that declares search indexes, views and materialized views, which must change nothing until an
  admin applies them.

## Consequences

- **Positive:** trustworthy drop-in adoption; easy removal (stop the container, drop the `canopy` databases).
- **Negative:**
  - versions and correlation need cluster time (ADR-0007);
  - membership must be tracked in memory when pre-images are off;
  - per-document ACL fields can't be used;
  - the meta DB must be co-located for transactions.

## Alternatives considered

| Option | Why not |
|---|---|
| Version or ACL fields in documents (as Parse does) | Breaks the drop-in promise and existing queries and indexes |
| Heartbeat or outbox collections in the app DB | Small, but still a change to the user's database |
| Enabling pre-/post-images automatically | Convenient, but silently changes collection options and storage costs |
