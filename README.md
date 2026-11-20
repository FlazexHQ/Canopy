# Canopy

> **Canopy** is a working name. The final name, npm scope and GitHub organization are still being decided.

Canopy is an open source, self hostable backend platform for MongoDB: realtime live queries, Document Level
Security (rules in the style of Postgres Row Level Security), auth, generated REST and GraphQL APIs, and an admin
dashboard. It works with an existing MongoDB deployment without changing its schema.

**Status: Phases 1 to 4 are implemented** (DLS core and realtime, Data API and optimistic SDK, auth, server and
Studio, GraphQL and the framework bindings), and the repository is working through the audit plan in
[`plans/README.md`](plans/README.md) before Phase 5 (scale and edge). Nothing is published to npm yet and no
license has been chosen, so every quickstart starts from a clone of this repository.

| Package                | Contents                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `@canopy/protocol`     | The `canopy.v1` wire protocol: message types, the EJSON-lite codec, error codes and test vectors           |
| `@canopy/matcher`      | BSON comparison order, filter matching, sort, projection and update operators, checked against MongoDB     |
| `@canopy/query`        | Parsing and validation of untrusted filters, updates and live queries: operator allowlists and limits      |
| `@canopy/policy`       | Document Level Security: the policy DSL, compiler, field rules, explain, lint and the policy test runner   |
| `@canopy/schema`       | Schemas in code (`@canopy/schema/define`), inference from sampled documents and `$jsonSchema` validators   |
| `@canopy/auth`         | API keys and bring your own identity provider tokens (JWKS), turned into DLS request contexts              |
| `@canopy/auth-builtin` | Built in app user auth on Better Auth: email and password, magic links, OTP, OAuth, anonymous users, MFA   |
| `@canopy/config`       | The config file: `defineConfig`, `env()` markers, identity provider presets and a validating loader        |
| `@canopy/node-http`    | Serves Web standard fetch handlers on `node:http` and Express                                              |
| `@canopy/rest`         | The Data API: DLS enforced REST endpoints and the transactional write path shared with realtime mutations  |
| `@canopy/graphql`      | The GraphQL API: a schema generated per role set from policies and schemas, with subscriptions and limits  |
| `@canopy/realtime`     | The realtime engine and the `canopy-realtime` sidecar                                                      |
| `@canopy/storage`      | File storage with DLS policies on file metadata, on GridFS or S3 compatible stores, signed URLs, resumable |
| `@canopy/server`       | The server: REST, GraphQL, realtime, auth and policies composed from one config with `createCanopy`        |
| `@canopy/studio`       | The built Studio assets and a fetch style handler that serves them at `/studio`                            |
| `@canopy/client`       | The client SDK: document cache, live queries, optimistic mutations, offline queue, reconnect and resume    |
| `@canopy/react`        | React bindings: `CanopyProvider`, `useQuery`, `useCanopyStatus` and `createReactDb`                        |
| `@canopy/vue`          | Vue bindings: `useQuery` returning `ShallowRef`s, `useMutation` and a plugin                               |
| `@canopy/svelte`       | Svelte 5 bindings: `createQuery` returns a reactive object that is also a store                            |
| `@canopy/solid`        | Solid bindings: `createQuery` with signals and a context                                                   |
| `@canopy/tanstack-db`  | Canopy collections as TanStack DB collections, synced from live queries                                    |
| `@canopy/devtools`     | An in page panel for the connection, subscriptions, store and pending mutations, plus development warnings |
| `@canopy/cli`          | The `canopy` command: init, dev, doctor, policies, schema pull, diff and push, indexes and realtime images |
| `@canopy/testing`      | Private test support: a MongoDB replica set harness and value generators                                   |

## Quickstart: sign up and see a live query in five minutes

You need [Bun](https://bun.com) 1.4 or newer, Node.js 24 or newer, and a MongoDB replica set: `bun run db:up`
starts one in Docker on `localhost:27017`; without Docker, `bun packages/testing/scripts/mongod.ts --version
8.0.34 --dir .canopy/mongo` downloads the official binaries and starts one there.

```bash
git clone https://github.com/FlazexHQ/Canopy.git
cd Canopy
bun install
bun run build
bun run db:up
node examples/auth-notes/src/server.ts
```

Open <http://localhost:3000/>, create an account with an email address and a password, and add a note. Open
the page in a second tab: the note is already there, and notes you add or delete in one tab show up in the
other at once, because the list is a live query. Open a private window and create a second account: it sees
none of the first account's notes. That is a document level security policy, enforced by the server:

```ts
// examples/auth-notes/src/policies.ts (shortened)
import { allow, auth, collection } from "@canopy/policy"

export const notes = collection("notes", {
  exposed: true,
  realtime: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub") }),
    allow.insert("authenticated").check({ ownerId: auth("sub") }),
  ],
})
```

and the page declares the collection once, in `web/canopy.schema.ts`, and reads the list with the client SDK.
The schema types every query and write, and generates each new note's ObjectId:

<!-- snippet: declare const userId: string -->

```ts
import { createClient } from "@canopy/client"
import { createAuth } from "@canopy/client/auth"
import { collection, defineSchema, t } from "@canopy/schema/define"

// web/canopy.schema.ts (shortened)
const schema = defineSchema(
  collection("notes", { text: t.string(), ownerId: t.string(), createdAt: t.date() }),
)

const auth = createAuth({ url: location.origin })
const canopy = createClient({
  url: location.origin,
  publishableKey: "pk_notes_local",
  auth,
  schema,
})

canopy
  .from("notes")
  .find({ ownerId: userId })
  .sort({ createdAt: -1 })
  .limit(100)
  .subscribe(({ data, status }) => render(data, status))

const added = canopy
  .from("notes")
  .insert({ text: "Buy milk", ownerId: userId, createdAt: new Date() })
render(added.id) // the new note's ObjectId, before the server has answered
await added // resolves once the server has stored it, rejects if a policy refused it
```

A page that only needs one read, such as a server rendered list, can fetch it over HTTP without opening a
socket. `createRestClient` from `@canopy/client/rest` takes the same options:

<!-- snippet: declare const userId: string -->

```ts
import { createAuth } from "@canopy/client/auth"
import { createRestClient } from "@canopy/client/rest"
import { collection, defineSchema, t } from "@canopy/schema/define"

const schema = defineSchema(
  collection("notes", { text: t.string(), ownerId: t.string(), createdAt: t.date() }),
)
const auth = createAuth({ url: location.origin })
const rest = createRestClient({
  url: location.origin,
  publishableKey: "pk_notes_local",
  auth,
  schema,
})

const recent = rest.from("notes").find({ ownerId: userId }).sort({ createdAt: -1 }).limit(20)
const first = await recent.page()
render(first.data)
if (first.page.next !== null) render((await recent.page({ after: first.page.next })).data)
```

The [built in auth quickstart](apps/docs/src/content/docs/start/built-in-auth.md) walks through the same app
step by step, and [`examples/auth-notes`](examples/auth-notes) has its browser tests.
The [client SDK guide](apps/docs/src/content/docs/guides/client.md#run-from-a-clone) has a runnable
JavaScript and TypeScript program that signs in, subscribes and fetches a REST page.

## Other ways in

- **Next to an existing app.** The `canopy-realtime` sidecar adds live queries to a MongoDB app without
  changing its server, with tokens from your identity provider (Auth0, Clerk, Cognito, Keycloak and any
  JWKS issuer): the [sidecar quickstart](packages/realtime/README.md#sidecar-quickstart-about-10-minutes), and
  [`examples/express-dropin`](examples/express-dropin), which turns an Express, Mongoose and Auth0 helpdesk
  into a live dashboard with no server code changes.
- **The whole platform from one config.** `canopy init` and `canopy dev --with-mongo` run REST, GraphQL,
  realtime, auth and Studio together: [`packages/cli/README.md`](packages/cli/README.md) and
  [`packages/server/README.md`](packages/server/README.md).
- **Optimistic and offline.** [`examples/todo-react`](examples/todo-react) shows optimistic writes, conflicts,
  an offline queue and the fallback transports.

Check a deployment and test policies with `canopy doctor` and `canopy policies test --mongodb-uri ...`.

## Requirements

- [Bun](https://bun.com) 1.4 or newer (primary runtime and the repository's package manager)
- Node.js 24 or newer (fully supported secondary runtime)
- A MongoDB replica set: Docker for `bun run db:up`, or the official binaries through
  `packages/testing/scripts/mongod.ts`

Change streams and transactions need a replica set; they do not work on a standalone server. `bun run db:smoke`
checks both against `mongodb://localhost:27017/?replicaSet=rs0`.

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
