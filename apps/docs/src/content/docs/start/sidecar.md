---
title: Realtime sidecar
description: Add live queries to an existing MongoDB app without changing its server.
---

The `canopy-realtime` sidecar reads one change stream, applies your policies to every event and pushes each
user exactly the documents they may see. Your app keeps its API, its schema and its identity provider.

## 1. Install

```bash
bun add @canopy/realtime @canopy/policy mongodb
bun add -d @canopy/cli
```

`pnpm add`, `yarn add` and `npm install` take the same package names.

## 2. Write a policy

Policies are TypeScript files, one collection per file. A collection is reachable only when it is `exposed`,
and only through its policies:

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
      .named("customers read their orders"),
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

`auth("sub")` is the `sub` claim of the user's token. A missing claim denies access. Check the folder:

```bash
bunx canopy policies lint --dir canopy/policies
```

## 3. Check the deployment

```bash
bunx canopy doctor --mongodb-uri "$MONGODB_URI" --dir canopy/policies
```

`doctor` confirms the replica set, the server version and the change stream permission, and lists policy
fields without an index.

## 4. Start the sidecar

```bash
MONGODB_URI=mongodb+srv://canopy:PASSWORD@cluster0.example.mongodb.net/shop
CANOPY_POLICIES=./canopy/policies
CANOPY_PUBLISHABLE_KEYS=pk_shop_1
CANOPY_JWT_JWKS_URL=https://YOUR_TENANT.us.auth0.com/.well-known/jwks.json
CANOPY_JWT_ISSUER=https://YOUR_TENANT.us.auth0.com/
CANOPY_JWT_AUDIENCE=https://api.shop.example
CANOPY_JWT_ROLES_CLAIM=https://shop.example/roles
```

Save that as `canopy.env`, then:

```bash
node --env-file=canopy.env node_modules/@canopy/realtime/dist/bin/canopy-realtime.js
```

The sidecar is ready when `/readyz` answers. WebSockets connect on `/realtime/v1`; Prometheus metrics are on
port 9464.

## 5. Read live data

<!-- snippet: declare function getAccessTokenSilently(): Promise<string> -->

```tsx
import { createClient, type DocumentSchema } from "@canopy/client"
import { CanopyProvider, createReactDb } from "@canopy/react"

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
  const orders = db.orders.useQuery({ status: "open" }, { sort: { createdAt: -1 }, limit: 50 })
  if (orders.status === "loading") return <p>Loading</p>
  return orders.data.map((order) => <p key={String(order._id)}>{order.total}</p>)
}
```

The query filter is combined with the policies on the server, so `{ status: "open" }` returns only the open
orders this user may read. Keep writing through your own API: every change reaches open pages as it happens.

## Production checklist

- Serve the sidecar over TLS behind your load balancer.
- Give it its own MongoDB user with `read` on the app database and `readWrite` on the meta database.
- Keep the metrics port private: it binds `127.0.0.1` unless `METRICS_HOST` says otherwise (the image sets
  `0.0.0.0`), and `CANOPY_METRICS_TOKEN` makes it require a bearer token.
- Stop it with SIGTERM. Clients are told to reconnect and catch up through resume or a full resync.
