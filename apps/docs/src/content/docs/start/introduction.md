---
title: Introduction
description: What Canopy is, how its pieces fit together and what it needs from MongoDB.
---

Canopy turns a MongoDB deployment into a backend for web and mobile apps. One engine enforces your access
rules everywhere data leaves the database: live queries, the REST Data API, GraphQL, Studio's "view as user"
and the edge.

## The pieces

| Piece              | Package                                   | What it does                                                               |
| ------------------ | ----------------------------------------- | -------------------------------------------------------------------------- |
| Policies           | `@canopy/policy`                          | Document Level Security rules, written in TypeScript and tested like code  |
| Realtime           | `@canopy/realtime`                        | One change stream, fanned out to every live query the user may see         |
| Data API           | `@canopy/rest`                            | Transactional REST reads and writes with OpenAPI                           |
| GraphQL            | `@canopy/graphql`                         | A schema generated per role set, with relations, subscriptions and limits  |
| Auth               | `@canopy/auth-builtin`                    | Built in users, sessions, TOTP and passkeys, or your own identity provider |
| Server             | `@canopy/server`                          | All of the above in one process, plus the admin API and Studio             |
| Client SDK         | `canopy.js`                          | A document cache with live queries, optimistic writes and offline support  |
| Framework bindings | `canopy.js/react`, `vue`, `svelte`, `solid` | Hooks, composables, runes and signals over the client                      |
| CLI                | `@canopy/cli`                             | Policies, types, migrations, keys, user import and remote projects         |

## Three ways to run it

- **Sidecar.** `canopy-realtime` runs next to an existing app. The app keeps its API and its auth provider;
  Canopy adds live queries with the same rules.
- **Embedded.** `createRealtime()` or `createCanopy()` inside your own Node or Bun server.
- **Platform.** `canopy-server` (or the container) serves the Data API, GraphQL, realtime, auth, the admin
  API and Studio from one config file.

## Requirements

- MongoDB 8.0 or newer as a **replica set** or sharded cluster. Change streams and transactions do not work on
  a standalone server. Atlas works.
- Bun 1.4 or newer, Node.js 24 or newer, or Deno. Every runtime works on Windows, Linux and macOS.
- Packages install with Bun, pnpm, Yarn or npm.

## Guarantees

- **Fail closed.** Unknown operators, missing claims, policy errors and timeouts deny access.
- **No silent data loss.** Live queries start from a snapshot at a known cluster time, events arrive in order
  with sequence numbers, and when Canopy cannot prove a gap free stream it tells the client to resync.
- **Echo before ack.** A mutation is acknowledged only after its change events, so optimistic state is
  replaced without flicker.
