---
title: The Canopy platform
description: Run canopy-server with the Data API, GraphQL, realtime, auth and Studio from one config file.
---

The platform server serves everything from one process. Start a project with the CLI, which never overwrites
a file and never touches your app database:

```bash
bunx --package @canopy/cli canopy init --mongodb-uri "mongodb://localhost:27017/app?replicaSet=rs0"
```

`init` writes `canopy/canopy.config.ts`, starter policy templates and one policy file per collection it finds,
each with `exposed: false` until you open it up.

## The config file

```ts
// canopy/canopy.config.ts
import { builtin, defineConfig, env } from "@canopy/config"

export default defineConfig(({ mode }) => ({
  mongodb: { uri: env("MONGODB_URI") },
  publicUrl: mode === "production" ? "https://api.example.com" : "http://localhost:8080",
  masterKey: env.secret.optional("CANOPY_MASTER_KEY"),
  auth: builtin({ emailPassword: true, twoFactor: true, passkeys: true }),
  keys: {
    publishable: env.list.optional("CANOPY_PUBLISHABLE_KEYS"),
    secret: env.list.optional("CANOPY_SECRET_KEYS"),
  },
  policies: { dir: "./policies" },
  graphql: { maxDepth: 8 },
  collections: {
    posts: { relations: { author: { to: "users", local: "authorId" } } },
  },
}))
```

Read variables with `env()` rather than `process.env`: missing ones are reported together and secrets stay
redacted in `canopy config print`. Every setting is in the [configuration reference](/reference/configuration/).

## Develop

```bash
bunx --package @canopy/cli canopy dev --with-mongo
```

`dev --with-mongo` starts a single node replica set: in Docker when it runs, otherwise from the official MongoDB
binaries, downloaded once into a per user cache, with the data in `.canopy/mongodb` (`--mongo-binary` picks the
binaries even with Docker). It then loads `.env` files, hot reloads policies, generates development keys when
none are configured, and prints the REST, realtime, GraphQL and Studio URLs. The first time, it also prints a
one time setup token: open Studio and claim the project with it to become its owner.

## Run in production

```bash
node node_modules/@canopy/server/dist/bin/canopy-server.js --config canopy/canopy.config.ts
```

or build the container from `deploy/docker/canopy.Dockerfile`. An invalid config stops the process before it
connects, with every problem listed.

| Path                  | What                                                 |
| --------------------- | ---------------------------------------------------- |
| `/rest/v1`            | The [Data API](/guides/rest/)                        |
| `/graphql/v1`         | [GraphQL](/guides/graphql/), with graphql-ws on Node |
| `/realtime/v1`        | Realtime over WebSocket, SSE and long polling        |
| `/auth/v1`            | Built in auth                                        |
| `/admin/v1`           | The admin API                                        |
| `/studio`             | [Studio](/guides/studio/)                            |
| `/healthz`, `/readyz` | Liveness (always `200`), and readiness: `503` while MongoDB does not answer a ping, the change stream is down or the server drains |
| `/metrics`            | Prometheus metrics on the metrics port (see below)   |

The metrics port (9464) binds `127.0.0.1` by default, so only a scraper on the same machine reaches it. The
container images bind `0.0.0.0`; there, publish the port only on a private network, or set
`CANOPY_METRICS_TOKEN` and configure the scraper with `authorization: { credentials: <token> }`, which sends
it as a bearer token.

## Create the first admin

```bash
bunx --package @canopy/cli canopy migrate
bunx --package @canopy/cli canopy admin create --email you@example.com --role owner
```

The command prints a generated password that must be changed at the first Studio login.
