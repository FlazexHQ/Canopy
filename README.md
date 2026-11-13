# Canopy

> **Canopy** is a working name. The final name, npm scope and GitHub organization are still being decided.

Canopy is an open source, self hostable backend platform for MongoDB: realtime live queries, Document Level
Security (rules in the style of Postgres Row Level Security), auth, generated REST and GraphQL APIs, and an admin
dashboard. It works with an existing MongoDB deployment without changing its schema.

**Status: Phases 1 to 4 are implemented** (DLS core and realtime, Data API and optimistic SDK, auth, server and
Studio, GraphQL and the framework bindings). Phase 5 (scale and edge) has not started. Nothing is published to
npm yet, so every quickstart starts from a clone of this repository.

| Package                | Contents                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `@canopy/protocol`     | The `canopy.v1` wire protocol: message types, the EJSON-lite codec, error codes and test vectors           |
| `@canopy/matcher`      | BSON comparison order, filter matching, sort, projection and update operators, checked against MongoDB     |
| `@canopy/query`        | Parsing and validation of untrusted filters, updates and live queries: operator allowlists and limits      |
| `@canopy/policy`       | Document Level Security: the policy DSL, compiler, field rules, explain, lint and the policy test runner   |
| `@canopy/schema`       | Collection schemas: inference from sampled documents, `$jsonSchema` validators and TypeScript generation   |
| `@canopy/auth`         | API keys and bring your own identity provider tokens (JWKS), turned into DLS request contexts              |
| `@canopy/auth-builtin` | Built in app user auth on Better Auth: email and password, magic links, OTP, OAuth, anonymous users, MFA   |
| `@canopy/config`       | The config file: `defineConfig`, `env()` markers, identity provider presets and a validating loader        |
| `@canopy/node-http`    | Serves Web standard fetch handlers on `node:http` and Express                                              |
| `@canopy/rest`         | The Data API: DLS enforced REST endpoints and the transactional write path shared with realtime mutations  |
| `@canopy/graphql`      | The GraphQL API: a schema generated per role set from policies and schemas, with subscriptions and limits  |
| `@canopy/realtime`     | The realtime engine and the `canopy-realtime` sidecar                                                      |
| `@canopy/server`       | The server: REST, GraphQL, realtime, auth and policies composed from one config with `createCanopy`        |
| `@canopy/studio`       | The built Studio assets and a fetch style handler that serves them at `/studio`                            |
| `@canopy/client`       | The client SDK: document cache, live queries, optimistic mutations, offline queue, reconnect and resume    |
| `@canopy/react`        | React bindings: `CanopyProvider`, `useQuery`, `useCanopyStatus` and `createReactDb`                        |
| `@canopy/vue`          | Vue bindings: `useQuery` returning `ShallowRef`s, `useMutation` and a plugin                               |
| `@canopy/svelte`       | Svelte 5 bindings: `createQuery` returns a reactive object that is also a store                            |
| `@canopy/solid`        | Solid bindings: `createQuery` with signals and a context                                                   |
| `@canopy/tanstack-db`  | Canopy collections as TanStack DB collections, synced from live queries                                    |
| `@canopy/devtools`     | An in page panel for the connection, subscriptions, store and pending mutations, plus development warnings |
| `@canopy/cli`          | The `canopy` command: init, dev, doctor, policies, type generation, indexes and realtime images            |
| `@canopy/testing`      | Private test support: a MongoDB replica set harness and value generators                                   |

## Canopy Realtime in two minutes

Policies are code. A collection is only reachable when it is exposed, and only through its policies:

```ts
// canopy/policies/todos.ts
import { allow, auth, collection } from "@canopy/policy"

export default collection("todos", {
  exposed: true,
  realtime: true,
  policies: [allow.read("authenticated").where({ ownerId: auth("sub") })],
  fields: { read: { default: { omit: ["internalNotes"] } } },
})
```

Run it as a sidecar next to an existing app (the app database is never modified):

```bash
MONGODB_URI="mongodb://localhost:27017/app?replicaSet=rs0" CANOPY_POLICIES=./canopy/policies CANOPY_JWT_JWKS_URL="https://YOUR_TENANT.auth0.com/.well-known/jwks.json" CANOPY_JWT_ISSUER="https://YOUR_TENANT.auth0.com/" CANOPY_JWT_AUDIENCE="https://api.example.com" CANOPY_PUBLISHABLE_KEYS=canopy_pk_dev bun packages/realtime/dist/bin/canopy-realtime.js
```

or embed it in a Node server (Express, Fastify and Hono all run on one):

```ts
const realtime = await createRealtime({
  mongo,
  database: "app",
  auth,
  policies: { dir: "./canopy/policies" },
})
await attach(realtime, server)
```

and read live data in React:

```tsx
const canopy = createClient({
  url: "https://api.example.com",
  publishableKey: "canopy_pk_dev",
  auth: { getToken },
})
const db = createReactDb(canopy)
const { data, status } = db.todos.useQuery({ done: false }, { sort: { createdAt: -1 }, limit: 50 })
```

Check a deployment and test policies with `canopy doctor` and `canopy policies test --mongodb-uri ...`. To run the
whole platform (REST, GraphQL, realtime, auth and Studio) from one config, see
[`packages/server/README.md`](packages/server/README.md) and `canopy dev` in
[`packages/cli/README.md`](packages/cli/README.md).

The full walkthrough is the [sidecar quickstart](packages/realtime/README.md#sidecar-quickstart-about-10-minutes),
and [`examples/express-dropin`](examples/express-dropin) turns an Express, Mongoose and Auth0 helpdesk into a live
dashboard with no server code changes.

## Requirements

- [Bun](https://bun.com) 1.4 or newer (primary runtime and the repository's package manager)
- Node.js 24 or newer (fully supported secondary runtime)
- Docker, for the local MongoDB replica set

## Getting started

```bash
bun install
bun run db:up      # single node MongoDB replica set on localhost:27017
bun run db:smoke   # checks change streams and transactions against it
```

Connect with `mongodb://localhost:27017/?replicaSet=rs0`. Change streams and transactions need a replica set;
they do not work on a standalone server.

## Common tasks

| Task                           | Command                                                         |
| ------------------------------ | --------------------------------------------------------------- |
| Type check every project       | `bun run typecheck`                                             |
| Lint and check formatting      | `bun run lint`                                                  |
| Format                         | `bun run format`                                                |
| Run every test suite           | `bun run test:all`                                              |
| Include the MongoDB suites     | set `CANOPY_TEST_MONGODB_URI` to a replica set URI              |
| Run tests through Turborepo    | `bun run test`                                                  |
| Add a changeset                | `bun run changeset`                                             |
| Run Canopy locally from source | `bun run dev` (uses `deploy/dev/`, needs the replica set above) |
| Stop the database              | `bun run db:down`                                               |

## Repository layout

| Path              | Contents                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `packages/`       | The `@canopy/*` libraries (not published yet)                                                   |
| `apps/`           | `studio` (the admin dashboard) and `docs` (the documentation site)                              |
| `examples/`       | Runnable example apps with end to end tests                                                     |
| `deploy/`         | Docker Compose files and deployment assets                                                      |
| `docs/`           | Design documents, decision records and spike write ups, from [`docs/README.md`](docs/README.md) |
| `plans/`          | The improvement plan and its status                                                             |
| `tools/`          | Standalone repository tools (`repo-check`), not workspace members                               |
| `tsconfig.*.json` | Shared TypeScript 6 settings: `server`, `universal`, `web` and `edge`                           |

## Contributing

The contribution guide, Code of Conduct, security policy and governance model are being drafted and will be
published before the project accepts outside contributions. Commits follow Conventional Commits and are signed
off (`git commit -s`).

Never report a security vulnerability in a public issue. Use GitHub private vulnerability reporting.

## License

The license has not been ratified yet. Apache 2.0 is proposed. Until a `LICENSE` file is added, no license is
granted.
