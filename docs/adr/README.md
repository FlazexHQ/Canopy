# Architecture Decision Records

ADRs record **why** an important decision was made and which alternatives were rejected. RFCs propose changes
([13 §3](../plan/13-open-source.md#3-contribution-model)); ADRs record the outcome.

**Lifecycle:** `Proposed` → `Accepted` → (`Superseded by ADR-NNNN` | `Deprecated`). Every ADR below is
**Proposed** and is to be accepted or revised in Phase 0 ([12 §3.0](../plan/12-roadmap.md#30-phase-0-foundations-and-spikes-3-weeks)).

| ADR | Title | Status |
|---|---|---|
| [0001](0001-typescript-6-and-bun.md) | TypeScript 6 with Bun as the primary runtime | Proposed |
| [0002](0002-monorepo-tooling.md) | Monorepo tooling: Bun, Turborepo, Changesets, Biome, Vitest | Proposed |
| [0003](0003-dls-policy-model.md) | DLS policy model: RLS semantics, stored in MongoDB, authored as code | Proposed |
| [0004](0004-single-change-stream-in-process-matching.md) | One change stream per deployment with in-process matching | Proposed |
| [0005](0005-custom-matcher-with-differential-testing.md) | Custom compiled matcher, verified by differential testing | Proposed |
| [0006](0006-write-enforcement-in-transactions.md) | Write enforcement inside MongoDB transactions | Proposed |
| [0007](0007-cluster-time-reconciliation.md) | Cluster-time reconciliation and echo-before-ack | Proposed |
| [0008](0008-auth-better-auth-and-byo-jwks.md) | Auth: Better Auth embedded, plus bring-your-own JWKS | Proposed |
| [0009](0009-wire-protocol-v1.md) | Wire protocol v1: JSON + EJSON, sequenced, resumable | Proposed |
| [0010](0010-edge-is-fanout-only.md) | The edge is a fan-out tier only | Proposed |
| [0011](0011-no-user-schema-intrusion.md) | No changes to the user's schema | Proposed (amended 2026-11-18) |
| [0012](0012-license-apache-2.md) | License: Apache-2.0 | Proposed |
| [0013](0013-one-project-per-deployment.md) | One project per deployment until 1.0 | Accepted |
| [0014](0014-rust-native-core.md) | A native core in Rust | Accepted (direction) |
| [0015](0015-reach-through-mongodb.md) | Reach further through MongoDB, not through more languages | Accepted (direction) |
| [0016](0016-canopy-js-and-container-services.md) | canopy.js as one library, and Canopy as separate container services | Accepted |

New ADRs copy [0000-template.md](0000-template.md) and take the next number.
