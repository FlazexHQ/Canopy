# ADR-0016: canopy.js as one library, and Canopy as separate container services

- **Status:** Accepted; amended by [ADR-0017](0017-rust-data-plane.md) on 2026-11-22: after Phase 5b the `api`
  and `realtime` roles are roles of the Rust data plane, and a TypeScript `control` service takes built in
  auth, the admin API and webhooks from the `api` role; partly superseded by
  [ADR-0018](0018-all-server-code-in-rust.md) on 2026-11-25 (the vendored core in Canopy.js, the
  `canopy-control` and `canopy-studio` images, embedding with `CANOPY_ROLE=all`)
- **Date:** 2026-11-22
- **Deciders:** project maintainers
- **Related:** [01 §2](../design/01-architecture.md#2-components), [01 §4](../design/01-architecture.md#4-deployment-modes),
  [05](../design/05-client-sdk.md), [ADR-0010](0010-edge-is-fanout-only.md)

## Context

Developers met Canopy as fourteen `@canopy/*` packages: they installed `@canopy/client`, a framework binding,
`@canopy/policy`, `@canopy/config` and `@canopy/schema` just to write an app, its policies and its config, and
ran the whole platform as one process (`canopy-server`) or embedded it in their own server. Two problems
followed. Installing and choosing packages was the first thing a new developer had to get right, and one
process meant that a failure in one surface (a realtime memory spike, a GraphQL bug) took REST, auth and
Studio down with it.

## Decision

The project splits into two repositories:

- **Canopy** (this repository) is the platform: the universal core (protocol, matcher, query, policy), the
  server packages, Studio, the CLI and the Rust crates. It ships as containers.
- **Canopy.js** is the TypeScript library, published as one package, `canopy.js`. Its root export is the
  client; subpaths carry the rest: `canopy.js/react`, `/vue`, `/svelte`, `/solid`, `/tanstack-db`,
  `/devtools`, the client entry points (`/auth`, `/rest`, `/persist`, ...), and the authoring DSLs
  `canopy.js/policy`, `canopy.js/schema` and `canopy.js/config`. Framework libraries are optional peers.

Canopy stays the source of truth for the universal core. Canopy.js vendors the files it needs into
`src/core` with `scripts/sync-core.ts`, which rewrites imports into relative paths, refuses any third party
import, and has a `--check` mode for CI. The protocol conformance vectors are vendored the same way.

The platform runs as separate services, each with its own health check and restart policy:

| Service | Image | Role |
|---|---|---|
| `database` | `mongo` | A replica set |
| `api` | `canopy` with `CANOPY_ROLE=api` | REST, GraphQL, auth, storage, admin API, webhooks |
| `realtime` | `canopy` with `CANOPY_ROLE=realtime` | Realtime transports and mutations |
| `studio` | `canopy-studio` | Studio as static files |
| `edge` | `caddy` | The one public entry, routing by path |

The `api` role turns realtime and Studio off and sends GraphQL subscriptions to the realtime service
(`CANOPY_REALTIME_URL`). The `realtime` role keeps the transactional write path, so realtime mutations keep
their idempotency records, and turns the admin API, Studio and webhooks off so they never run twice. Each
service has its own node id, so leases (migrations, webhook deliveries) stay correct. The edge answers a
Problem Details `503` with `CANOPY_UNAVAILABLE` for the routes of a service that is down. `CANOPY_ROLE=all`
(the default) keeps the single process for embedding and small deployments.

The edge here is the front door of a self hosted stack. The Cloudflare fan out tier of
[ADR-0010](0010-edge-is-fanout-only.md) is unchanged and still planned.

## Consequences

- **Positive:** a developer installs one package and runs `docker compose up`. A failing service costs only
  its own routes. REST and realtime scale independently. The DSL objects stay plain data (and `Symbol.for`
  brands), so policies and configs written against `canopy.js` load in the server unchanged.
- **Negative / costs:** two copies of the core exist. `sync-core --check` keeps them equal, but a core change
  now ships in two releases. Error classes from `canopy.js` are not `instanceof` the server's classes;
  `isCanopyError` checks a brand and works across both. Until `canopy.js` is on npm, Canopy resolves it from a
  checkout next to this repository (a root `overrides` entry), and container builds and CI need that
  checkout as a build context. GraphQL subscriptions run the client inside the server, so the server depends
  on `canopy.js` at run time.
- **Follow-ups:** publish `canopy.js`, then drop the override and the build context; split the Kubernetes and
  Helm manifests into the same services; serve GraphQL subscriptions from the realtime engine directly instead
  of through the client; move the examples that embed the server to Canopy.js once the images are published.

## Alternatives considered

| Option | Why not |
|---|---|
| Keep `@canopy/*` packages and add a meta package | Still many packages to version and explain; the meta package hides nothing about install size or peers |
| Everything from the root of `canopy.js` | The policy and schema DSLs both export `collection`, and every app would resolve every framework's types |
| Canopy.js owns the core and the server imports it | Puts server correctness (DLS) behind an SDK release; the Rust equivalence suites live in Canopy |
| One container with a process supervisor | A crash loop or memory spike in one surface still takes the others down |
