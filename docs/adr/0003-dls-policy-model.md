# ADR-0003: DLS policy model: RLS semantics, stored in MongoDB, authored as code

- **Status:** Proposed
- **Date:** 2026-11-05
- **Related:** [02](../plan/02-document-level-security.md)

## Context

Concept 2 requires "granular read/write security rules inside MongoDB collections, similar to PostgreSQL RLS".
The rules must:

- compile into **MongoDB filters** for queries and writes;
- compile into **in-memory predicates** for realtime events;
- run on the edge;
- be testable, versioned and editable in a UI;
- never require changes to user documents.

## Decision

- **Semantics follow Postgres RLS:**
  - permissive policies are ORed and restrictive ones are ANDed;
  - `using` and `check` clauses, with `check` defaulting to `using` on updates;
  - role-scoped policies, with a `service` role that bypasses everything;
  - nothing exposed by default;
  - a missing variable never matches (SQL `NULL` semantics).
- **The rule language is the MongoDB query language** plus three value-only variables (`$auth`, `$ctx`,
  `$now`). `using` is limited to a matcher-safe operator set.
- **Storage:** one document per collection in `canopy.policies`, with clauses stored as canonical EJSON strings
  and history kept in `canopy.policy_history`. Policies are **authored** with a typed TS DSL that compiles to
  that JSON, or in Studio.
- Membership-style rules use declared **`$ctx` lookups** (cached, invalidated live) instead of joins.

## Consequences

- **Positive:**
  - familiar to Supabase and Postgres developers;
  - one source compiles to both enforcement forms;
  - no new language to learn;
  - works with Git, Studio and edge bundles alike.
- **Negative:**
  - less expressive than SQL subqueries (`$ctx` covers the common cases);
  - not enforced inside `mongod`, so direct database clients bypass it, which must be documented loudly;
  - matcher-safe limits on `using`.
- **Follow-ups:** differential tests ([ADR-0005](0005-custom-matcher-with-differential-testing.md)), the lint
  rules, and the policy test runner.

## Alternatives considered

| Option | Why not |
|---|---|
| Firebase-style rules (custom expression language) | A new language to learn and implement. Hard to compile into list-query filters, so list queries become "rules are not filters" errors. |
| Parse-style ACL fields on documents | Changes the user's schema (`_rperm`/`_wperm`) and breaks the drop-in promise |
| OPA/Rego or Cedar with partial evaluation | Powerful, but adds a second language and a heavy runtime. Turning partial evaluation output into Mongo filters and realtime matchers is complex and slow. |
| Atlas App Services-style JSON rules | Similar idea, but lacking permissive/restrictive and check semantics; Canopy's model is a superset |
| MongoDB views with `$$USER_ROLES` | Role-level, not per user or claim. Read-only. |
