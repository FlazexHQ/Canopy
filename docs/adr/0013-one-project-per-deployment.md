# ADR-0013: One project per deployment until 1.0

- **Status:** Accepted
- **Date:** 2026-11-18
- **Deciders:** maintainers
- **Related:** [00 §7](../design/00-vision.md#7-non-goals-for-10), [12 §7 Q6 and Q9](../design/12-roadmap.md#7-open-questions), item F6 of the [improvement plan](../plans/README.md)

## Context

The improvement plan asks whether one Canopy deployment should serve several projects (several app databases,
each with its own policies, keys, auth users and Studio view) before 1.0. Q9 already recommends "one app
database for 1.0" and the vision lists a hosted multi tenant control plane as a non goal. Multi project
support touches every layer: the meta database layout, the policy cache keys, the change stream (one per app
database), API key scopes, built in auth (users per project), the admin roles and Studio, metrics labels, and
the rate limits.

## Decision

Canopy 1.0 serves **one project per deployment**: one app database, one meta database, one auth database. Run
one deployment per project; several deployments may share a MongoDB cluster, as long as each has its own
three databases (`mongodb.database`, `mongodb.metaDatabase`, `mongodb.authDatabase`).

What keeps the door open, and must stay true until the decision is revisited:

- every Canopy collection lives in the meta or auth database named by the config, never in a fixed one;
- policies, API keys, webhooks, storage metadata and settings are read through stores built from the config,
  so a project id can be added to their keys without changing their callers;
- no code assumes the app database name outside the config.

## Consequences

- **Positive:** no tenant isolation bugs to defend against before the outside security audit; the policy,
  realtime and storage designs stay simple; a deployment is still cheap (one process and three databases).
- **Negative / costs:** hosting many small projects costs one process each; a future hosted offering needs a
  control plane in front of many deployments, or the migration this ADR defers.
- **Follow-ups:** revisit after 1.0 together with Q6 (hosted cloud).

## Alternatives considered

| Option | Why not |
|---|---|
| Several app databases in one deployment now | Touches every package and every security boundary right before the 1.0 security audit, for a need no user has reported yet |
| A project id in every meta document now, unused | Costs an index field everywhere and tests nobody runs; the stores can add it later behind the same interfaces |
