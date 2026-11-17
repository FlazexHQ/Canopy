---
title: Embedding Canopy
description: Run Canopy realtime, or the whole platform, inside your own Node or Bun server.
---

Both the realtime engine and the platform server are libraries first. Embed them when you want one process
and one port.

## Realtime only

```ts
import { createServer } from "node:http"
import { attach, createRealtime } from "@canopy/realtime"
import express from "express"
import { MongoClient } from "mongodb"

const app = express()
const server = createServer(app)
const realtime = await createRealtime({
  mongo: new MongoClient(process.env.MONGODB_URI ?? ""),
  database: "shop",
  auth: {
    jwksUrl: "https://YOUR_TENANT.us.auth0.com/.well-known/jwks.json",
    issuer: "https://YOUR_TENANT.us.auth0.com/",
    audience: "https://api.shop.example",
    rolesClaim: "https://shop.example/roles",
  },
  policies: { dir: "./canopy/policies" },
})
await attach(realtime, server)
server.listen(3000)
```

Express, Fastify and Hono all run on a `node:http` server, so `attach()` works with each. On `Bun.serve`, use
`bunHandlers(realtime)` instead.

## The whole platform

`createCanopy()` builds the Data API, GraphQL, realtime, auth, the admin API and Studio from a resolved config:

<!-- snippet: declare const app: import("node:http").RequestListener -->

```ts
import { createServer } from "node:http"
import { loadConfig } from "@canopy/config/load"
import { createCanopy } from "@canopy/server"

const { config } = await loadConfig({ command: "start" })
const canopy = await createCanopy(config)
const server = createServer(
  canopy.node({ fallback: (request, response) => app(request, response) }),
)
await canopy.attach(server)
server.listen(config.server.port)
```

Requests Canopy does not serve go to `fallback`, so your own routes keep working. `canopy.attach()` accepts
WebSocket upgrades for `/realtime/v1` and for graphql-ws on `/graphql/v1`.

On Bun:

<!-- snippet: not checked -->

```ts
Bun.serve({ port: config.server.port, ...canopy.bun() })
```

On Deno and other fetch based runtimes, `canopy.fetch(request)` answers REST, GraphQL over HTTP and SSE,
auth, the SSE and long polling realtime transports and the health checks. WebSockets need `attach()` on Node
or `bun()` on Bun.

## Shutting down

Call `canopy.close()` (or `realtime.close()`) on SIGTERM. Readiness fails first, realtime clients are told to
reconnect within the drain window, and the MongoDB connection closes last.
