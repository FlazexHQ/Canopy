# @canopy/realtime

Live queries for an existing MongoDB app. Canopy Realtime reads one change stream, applies your Document Level
Security policies to every event, and pushes each user exactly the documents they may see over WebSockets.
Your app keeps its API, its schema and its auth provider; nothing is added to your database.

It runs two ways:

- **Sidecar:** the `canopy-realtime` process or container next to your app. No code changes on the server.
- **Embedded:** `createRealtime()` plus `attach()` on your own Node or Bun HTTP server.

## Sidecar quickstart (about 10 minutes)

You need:

- MongoDB 8.0 or newer running as a **replica set** or sharded cluster (Atlas works; a standalone server has
  no change streams).
- An identity provider that publishes a JWKS, such as Auth0, Clerk, Cognito or Keycloak.
- Bun 1.4 or newer, or Node.js 24 or newer. Docker is optional.

> Canopy is not on npm yet. Until the first release, run these steps from a clone of this repository
> (`bun install && bun run build`), or start with [`examples/express-dropin`](../../examples/express-dropin),
> which walks through the same steps on a complete Express, Mongoose and Auth0 app.

### 1. Install (1 minute)

In your app's repository:

```bash
bun add @canopy/realtime @canopy/policy mongodb
bun add -d @canopy/cli
```

With another package manager, use `pnpm add`, `yarn add` or `npm install` with the same package names.

### 2. Write a policy (3 minutes)

Policies are TypeScript files, one collection per file. A collection is reachable only when it is `exposed`,
and only through its policies. This one lets users read their own orders and hides an internal field:

```ts
// canopy/policies/orders.ts
import { allow, auth, collection } from "@canopy/policy"

export default collection("orders", {
  exposed: true,
  realtime: true,
  policies: [
    allow
      .read("authenticated")
      .where({ customerId: auth("sub") })
      .named("customers read their own orders"),
    allow.read("staff").named("staff read every order"),
  ],
  fields: {
    read: {
      default: { omit: ["margin"] },
      staff: { only: ["*"] },
    },
  },
})
```

`auth('sub')` is the `sub` claim of the user's token. A missing or malformed claim denies access, as does any
error while evaluating a policy. Roles such as `staff` come from a token claim you name in step 4.

Check the policies:

```bash
bunx --package @canopy/cli canopy policies lint --dir canopy/policies
```

Policy tests sit next to the policies in `*.test.ts` files and run in memory and, with `--mongodb-uri`, against
MongoDB, which must agree:

```ts
// canopy/policies/orders.test.ts
import { as, describePolicies } from "@canopy/policy/testing"

describePolicies("orders", ({ doc, expect }) => {
  const order = doc({ _id: "o1", customerId: "user_1", total: 40, margin: 12 })
  expect(as.user({ sub: "user_1" }))
    .can.read(order)
    .withoutFields(["margin"])
  expect(as.user({ sub: "user_2" })).cannot.read(order)
  expect(as.user({ sub: "user_9" }, { roles: ["staff"] }))
    .can.read(order)
    .withFields(["margin"])
  expect(as.anon()).cannot.read(order)
})
```

```bash
bunx --package @canopy/cli canopy policies test --dir canopy/policies --mongodb-uri "$MONGODB_URI"
```

### 3. Check the deployment (1 minute)

```bash
bunx --package @canopy/cli canopy doctor --mongodb-uri "$MONGODB_URI" --dir canopy/policies
```

`doctor` confirms the replica set, the MongoDB version and the change stream permission, loads the policies,
and lists policy fields that have no index. It never creates indexes.

### 4. Start the sidecar (2 minutes)

Put the configuration in `canopy.env` (keep it out of version control if the URI holds a password):

```bash
MONGODB_URI=mongodb+srv://canopy:PASSWORD@cluster0.example.mongodb.net/shop
CANOPY_POLICIES=./canopy/policies
CANOPY_PUBLISHABLE_KEYS=pk_shop_1
CANOPY_JWT_JWKS_URL=https://YOUR_TENANT.us.auth0.com/.well-known/jwks.json
CANOPY_JWT_ISSUER=https://YOUR_TENANT.us.auth0.com/
CANOPY_JWT_AUDIENCE=https://api.shop.example
CANOPY_JWT_ROLES_CLAIM=https://shop.example/roles
```

Then start it with Bun or Node:

```bash
bun --env-file=canopy.env node_modules/@canopy/realtime/dist/bin/canopy-realtime.js
```

```bash
node --env-file=canopy.env node_modules/@canopy/realtime/dist/bin/canopy-realtime.js
```

Or build and run the container from a clone of this repository, mounting the policies at `/app/policies`:

```bash
docker build -f deploy/docker/canopy-realtime.Dockerfile -t canopy-realtime .
```

```bash
docker run --rm -p 8080:8080 --env-file canopy.env -e CANOPY_POLICIES=/app/policies -v "$PWD/canopy/policies:/app/policies:ro" canopy-realtime
```

From inside a container, `localhost` is the container itself. For a replica set on your own machine use
`mongodb://host.docker.internal:27017/shop?directConnection=true`.

The sidecar is ready when `curl localhost:8080/readyz` prints `ok`. It listens for WebSockets on
`/realtime/v1` and serves Prometheus metrics on port 9464 at `/metrics`.

### 5. Read live data in the browser (3 minutes)

```bash
bun add canopy.js canopy.js/react
```

<!-- snippet: declare function getAccessTokenSilently(): Promise<string> -->

```tsx
import { createClient, type DocumentSchema } from "canopy.js"
import { CanopyProvider, createReactDb, useCanopyStatus } from "canopy.js/react"

interface Order {
  readonly _id: string
  status: "open" | "paid" | "shipped"
  total: number
  createdAt: Date
}

const canopy = createClient<DocumentSchema<{ orders: Order }>>({
  url: "http://localhost:8080",
  publishableKey: "pk_shop_1",
  auth: { getToken: () => getAccessTokenSilently() },
})
const db = createReactDb(canopy)

function Orders() {
  const status = useCanopyStatus()
  const orders = db.orders.useQuery({ status: "open" }, { sort: { createdAt: -1 }, limit: 50 })
  if (orders.status === "loading") return <p>Loading…</p>
  return (
    <>
      <p>{status}</p>
      <ul>
        {orders.data.map((order) => (
          <li key={String(order._id)}>{order.total}</li>
        ))}
      </ul>
    </>
  )
}

export function App() {
  return (
    <CanopyProvider client={canopy}>
      <Orders />
    </CanopyProvider>
  )
}
```

`getToken` returns the user's access token from your identity provider (here the Auth0 React SDK); it is
called on every connect and before the token expires. The query filter is combined with the policies on the
server, so `{ status: 'open' }` returns only the open orders this user may read.

Keep writing through your own API. Every insert, update and delete reaches the open pages as it happens,
filtered per user.

Without React, subscribe directly:

```ts
const stop = canopy
  .from("orders")
  .find({ status: "open" })
  .sort({ createdAt: -1 })
  .limit(50)
  .subscribe(({ data, status }) => render(data, status))
```

## Configuration

| Variable                        | Default               | Meaning                                                               |
| ------------------------------- | --------------------- | --------------------------------------------------------------------- |
| `MONGODB_URI`                   | required              | Connection string. The path names the app database.                   |
| `CANOPY_DB`                     | the URI path          | The app database, when the URI has no path.                           |
| `CANOPY_META_DB`                | `canopy`              | Where Canopy keeps its own state (checkpoints, stored policies).      |
| `CANOPY_POLICIES`               | unset                 | A policy directory. Unset means policies stored in the meta database. |
| `CANOPY_PUBLISHABLE_KEYS`       | unset                 | Comma separated keys clients must send. Unset accepts any key.        |
| `CANOPY_SECRET_KEYS`            | unset                 | Comma separated keys that act as the `service` role. Server use only. |
| `CANOPY_JWT_JWKS_URL`           | unset                 | The identity provider's JWKS. HTTPS, except on `localhost`.           |
| `CANOPY_JWT_ISSUER`             | required with JWKS    | The expected `iss`.                                                   |
| `CANOPY_JWT_AUDIENCE`           | required with JWKS    | The expected `aud`.                                                   |
| `CANOPY_JWT_ROLES_CLAIM`        | unset                 | The claim that lists roles, for example `https://shop.example/roles`. |
| `CANOPY_JWT_ALGORITHMS`         | asymmetric algorithms | Comma separated allowlist. `none` and HMAC algorithms are refused.    |
| `CANOPY_REALTIME_FULL_DOCUMENT` | `auto`                | `auto`, `updateLookup` or `images` (pre and post images).             |
| `CANOPY_CHECKPOINTS`            | stored in the meta DB | `off` disables resume checkpoints.                                    |
| `CANOPY_RESUME_WINDOW`          | `120s`                | How long a dropped client can resume without a full resync.           |
| `CANOPY_DRAIN_WINDOW`           | `30s`                 | How long SIGTERM waits for clients to move before closing.            |
| `CANOPY_NODE_ID`                | `n1`                  | Identifies this instance in logs and metrics.                         |
| `CANOPY_CORS_ORIGINS`           | unset                 | Browser origins (or `*`) allowed on the SSE and long-poll endpoints.  |
| `CANOPY_LOG_LEVEL`              | `info`                | `debug`, `info`, `warn` or `error`. Logs are JSON lines on stderr.    |
| `PORT`                          | `8080`                | WebSocket and health endpoints (`/healthz`, `/readyz`).               |
| `METRICS_PORT`                  | `9464`                | Prometheus metrics at `/metrics`.                                     |

## Production checklist

- Serve the sidecar over TLS (`wss://`) behind your load balancer or reverse proxy; pages served over HTTPS
  cannot open plain `ws://` sockets.
- Give the sidecar its own MongoDB user with `read` on the app database and `readWrite` on the meta database.
- Keep the metrics port private.
- Canopy enforces your policies for its own clients. Anyone holding MongoDB credentials still bypasses them,
  so keep those credentials on the server.
- Send SIGTERM to stop. Clients are told to reconnect, then catch up through resume or a full resync, so no
  change is dropped silently.

## Embedded mode

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

On `Bun.serve`, use `bunHandlers(realtime)` instead of `attach()`.
