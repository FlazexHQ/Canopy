# ADR-0006: Write enforcement inside MongoDB transactions

- **Status:** Proposed (cost validated by spike S3)
- **Date:** 2026-11-05
- **Related:** [02 §9.3](../plan/02-document-level-security.md#93-write-path-transactional)

## Context

`check` rules (WITH CHECK) must hold for the **resulting** document. MongoDB update operators (`$inc`, `$push`,
`$rename`, positional updates, array filters) have subtle semantics, so predicting post-images in application
code risks drifting from what MongoDB actually writes. Writes also need idempotency for retries and offline
replays.

## Decision

Every non-service write that has a `check` or an idempotency key runs in **one multi-document transaction**
(`writeConcern: majority`):

1. insert the idempotency record into `canopy.mutations` (duplicate key → return the stored result);
2. resolve target `_id`s under `USING(op) ∧ USING(read)`;
3. apply the write;
4. verify `countDocuments({ _id: { $in: ids }, $nor: [CHECK] }) === 0`, or abort;
5. read back the readable post-images.

Writes without a `check` or idempotency key that touch a single document take a **fast path**: one atomic
operation with the policy filter.

## Consequences

- **Positive:** MongoDB is the final judge, so there is no semantic drift; retries and offline replays are
  idempotent; `check` can use operators that aren't matcher-safe (`$jsonSchema`, `$expr`).
- **Negative:** extra latency (measured in S3); the app DB and meta DB must be on the same deployment; requires
  a replica set or sharded cluster, which realtime needs anyway.

## Alternatives considered

| Option | Why not |
|---|---|
| Predict post-images in-process and check before writing | Risk of semantic drift on complex updates; races without a transaction |
| Collection validators (`$jsonSchema` via `collMod`) | Changes the user's schema and can't reference JWT claims |
| Write, then revert through the change stream if the check fails | Racy, and others briefly see the invalid state |
