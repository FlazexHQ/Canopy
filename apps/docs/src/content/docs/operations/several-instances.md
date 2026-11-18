---
title: Several instances
description: What each Canopy process keeps to itself, and how to route traffic when you run more than one.
---

Canopy runs as one process or as several behind a load balancer. Everything durable lives in MongoDB (the app
database, `canopy` and `canopy_auth`), and every instance opens its own change stream on the deployment, so a
write made through one instance reaches the realtime subscribers of every other. Give each instance its own
`server.nodeId` (`CANOPY_NODE_ID`): it prefixes session IDs and names the instance in logs and metrics.

## Shared through MongoDB

| State                                   | How the other instances learn about it                         |
| --------------------------------------- | -------------------------------------------------------------- |
| Documents and their changes             | each instance's change stream                                  |
| API keys created or revoked in Studio   | a change stream on the keys collection; connections close      |
| Session and user revocations            | a change stream on `canopy_auth`; checked on every request     |
| Policies published in Studio or the CLI | reloaded from the meta database when `policies.watch` is on   |
| Built in auth sign in limits            | counted in `canopy_auth`, so they hold across instances        |
| Idempotency records of mutations        | documents in `canopy`, so a retry may land on any instance     |
| Admin accounts, settings, audit log     | documents in `canopy`                                          |

Policies loaded from files are read by each instance from its own disk: deploy the same files everywhere.

## Kept in each process

| State                                           | Consequence with several instances                                      |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| Realtime sessions (WebSocket and HTTP fallback) | a session lives on the instance that opened it (see routing below)      |
| Resume buffers                                  | a client that reconnects to another instance gets a new session and a `resync` |
| Data plane rate limits                          | each instance counts on its own: the effective limit is the setting times the instance count |
| Admin login and setup attempt limits            | per instance, like the rate limits                                      |
| Policy, schema and GraphQL schema caches        | rebuilt from MongoDB or the policy files; never authoritative           |
| Tickets of the HTTP fallback                    | belong to their session, so they live where the session lives          |

None of this loses data: a client that lands on another instance resubscribes, and the snapshot it gets is
taken at a known cluster time. It costs a snapshot per subscription instead of a cheap resume.

## Routing

WebSockets need nothing special: a connection stays on the instance that accepted it.

The HTTP fallback (SSE and long polling) is a series of requests, and every request after
`POST /realtime/v1/sessions` must reach the instance that opened the session. Session IDs start with the node ID
(`n2.k3x…`), and every request about a session carries it in the path, `/realtime/v1/sessions/{sid}/…`
(including `POST …/tickets`). Either:

- route by that prefix, for example in NGINX:

  ```nginx
  map $uri $canopy_node {
    ~^/realtime/v1/sessions/(?<node>[^./]+)\. $node;
    default "";
  }
  # then pick the upstream named by $canopy_node, falling back to the pool when it is empty
  ```

- or turn on sticky sessions (cookie or client address affinity) in the load balancer.

A request that reaches the wrong instance is answered `409 CANOPY_SESSION_MOVED` with close code `4000`; the SDK
opens a new session there. Without either kind of routing a round robin balancer bounces sessions on every
request, so clients that cannot use WebSockets keep reconnecting.

## Drain

On `SIGTERM` an instance stops accepting connections, tells connected clients to reconnect after a delay, and
waits up to `realtime.drainWindowMs` (30 s by default) for them to go. Give the orchestrator a termination
grace period a little longer than that, and keep at least one other instance up during a rollout (a
disruption budget). The [Kubernetes manifests](/operations/kubernetes/) do both.
