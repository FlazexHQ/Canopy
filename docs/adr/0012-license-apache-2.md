# ADR-0012: License: Apache-2.0

- **Status:** Proposed (needs maintainer decision and counsel review in Phase 0)
- **Date:** 2026-11-05
- **Related:** [13 §1](../plan/13-open-source.md#1-license)

## Context

The project will be open-sourced. Its growth depends on adoption inside companies, especially through the
drop-in sidecar. A future hosted offering is possible but not decided (Q6 in
[12 §7](../plan/12-roadmap.md#7-open-questions)).

## Decision

Release every package and app under **Apache-2.0**, with DCO sign-off for contributions.

## Consequences

- **Positive:** maximum adoption and enterprise approval; an explicit patent grant; familiar from Supabase's
  model.
- **Negative:** third parties may offer hosted versions without contributing back. The mitigation is to compete
  on quality, velocity and an official hosted offering, not on license restrictions.

## Alternatives considered

| Option | Why not |
|---|---|
| MIT | No explicit patent grant |
| AGPL-3.0 (server) + Apache-2.0 (SDKs) | Deters hosted forks, but many companies ban AGPL, which hurts the drop-in wedge |
| BSL / FSL (source-available, converting later) | Not open source at release; damages community trust for an infrastructure project |
| SSPL | Not OSI-approved |
