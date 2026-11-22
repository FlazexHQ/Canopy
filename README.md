# Canopy

> **Canopy** is a working name. The final name, npm scope and GitHub organization are still being decided.

Canopy is an open source, self hostable backend platform for MongoDB: realtime live queries, Document Level
Security (rules in the style of Postgres Row Level Security), auth, generated REST and GraphQL APIs, and an admin
dashboard. It works with an existing MongoDB deployment without changing its schema.

**Status: Phases 1 to 4 are implemented** (DLS core and realtime, Data API and optimistic SDK, auth, server and
Studio, GraphQL and the framework bindings), and the repository is working through the plans in
[`docs/plans/`](docs/plans/README.md). Phase 5 built the native core in Rust; Phase 5b moves every data path
(REST, GraphQL, writes, storage, realtime and a MongoDB wire endpoint) into one Rust data plane, while
developers keep working in TypeScript ([plan 004](docs/plans/004-rust-data-plane.md)). Scale and edge follow
in Phase 6 and MongoDB depth in Phase 7. Nothing is published to npm yet and no license has been chosen, so
every quickstart starts from a clone of this repository.

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
| `@canopy/cli`          | The `canopy` command: init, dev, doctor, policies, schema pull, diff and push, indexes and realtime images |
| `@canopy/testing`      | Private test support: a MongoDB replica set harness and value generators                                   |
| `@canopy/sdk-e2e`      | Private end to end tests of the server through canopy.js                                                   |

Applications use Canopy through **canopy.js**, the TypeScript library, which lives in its own repository
([FlazexHQ/Canopy.js](https://github.com/FlazexHQ/Canopy.js), cloned next to this one): the client, the React, Vue, Svelte, Solid and TanStack DB
bindings, devtools, and the policy, schema and config DSLs, all in one package (`canopy.js`,
`canopy.js/react`, `canopy.js/policy`, ...). Canopy depends on it for Studio, GraphQL subscriptions and the
end to end tests; until it is on npm, the root `package.json` points `canopy.js` at that checkout, so clone
both side by side and run `bun install && bun run build` in Canopy.js first.

## Run Canopy as containers

The quickest way to run the whole platform is the container stack: each part of Canopy is its own container
with its own health check and restart policy, so one that fails leaves the others up.

| Service    | Serves                                                                                                |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| `database` | MongoDB as a single node replica set (change streams and transactions need one)                       |
| `api`      | The Data API (`/rest/v1`), GraphQL, built in auth, storage, the admin API and webhooks                |
| `realtime` | Realtime connections (`/realtime/v1`): live queries and optimistic mutations                          |
| `studio`   | The admin dashboard (`/studio`), static files with no database access of its own                      |
| `edge`     | The one public entry: routes each path to its service and answers 503 only for a service that is down |

```bash
git clone https://github.com/FlazexHQ/Canopy.git
git clone https://github.com/FlazexHQ/Canopy.js.git
cd Canopy
bun run stack:up
```

Then open <http://localhost:8080/studio> and claim the project with the setup token from
`docker compose -f deploy/compose/canopy.yaml logs api`. Policies are read from `deploy/compose/policies`
(`CANOPY_POLICY_DIR` picks another folder) and reloaded when they change; write them with
`canopy.js/policy`. `deploy/compose/production.yaml` is the same stack against your own replica set, with
every secret required and automatic HTTPS when `CANOPY_SITE` is a domain name. The api and realtime services
run one image, `deploy/docker/canopy.Dockerfile`, with `CANOPY_ROLE` set to `api` or `realtime`; without
it the image runs the whole platform in one process.

Projects using canopy.js can start their own development stack with `bun run canopy-stack up --build ../Canopy`
from the project directory. Adjust the checkout path to match your layout. The command uses the Canopy.js
checkout next to Canopy by default. The local build is required while the images are unpublished.
See [Run Canopy in the canopy.js README](https://github.com/FlazexHQ/Canopy.js#run-canopy).

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
import { createClient } from "canopy.js"
import { createAuth } from "canopy.js/auth"
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
socket. `createRestClient` from `canopy.js/rest` takes the same options:

<!-- snippet: declare const userId: string -->

```ts
import { createAuth } from "canopy.js/auth"
import { createRestClient } from "canopy.js/rest"
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
| Run the container stack        | `bun run stack:up`, then `bun run stack:down`                   |
| Stop the database              | `bun run db:down`                                               |

## Repository layout

| Path              | Contents                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `packages/`       | The `@canopy/*` libraries (not published yet)                                                   |
| `apps/`           | `studio` (the admin dashboard) and `docs` (the documentation site)                              |
| `examples/`       | Runnable example apps that embed the server, with end to end tests                              |
| `deploy/`         | The container stack (`compose/`), Dockerfiles, the edge (`compose/edge/Caddyfile`) and binaries |
| `crates/`         | The Rust core crates and the data plane (`canopy-gateway`), one Cargo workspace                 |
| `docs/`           | Design, ADRs, spikes, reviews and work plans, from [`docs/README.md`](docs/README.md)           |
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
