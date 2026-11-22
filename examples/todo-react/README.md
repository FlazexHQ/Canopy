# todo-react

A React todo list on Canopy that is optimistic, live across tabs and users, and keeps working offline.
One Node server (`src/app.ts`) hosts everything:

- the REST API (`/rest/v1`);
- realtime over WebSocket (`/realtime/v1`), with the SSE and long-poll fallbacks for networks that block
  WebSockets;
- a development token issuer (`POST /dev/token`) that stands in for an identity provider;
- the React app, bundled with esbuild.

Realtime commits mutations through the same write path as REST, so a mutation keeps one idempotency
record whichever way it is sent.

## What it shows

- **Optimistic writes.** Adding, ticking, renaming and deleting show up at once and are confirmed by the
  server's echo, without flicker.
- **Document level security.** Shared todos are visible to and editable by every user, private ones only
  by their owner, and only owners may delete (`src/policies.ts`). A refused change rolls back and the app
  says why.
- **Conflicts.** A rename carries a `where: { v }` precondition and bumps `v`, so when two people rename the
  same todo, the second rename fails with `ConflictError` and rolls back to the first.
- **Offline.** Changes made offline are queued in IndexedDB (`indexedDbPersister()`), shown at once, and
  sent in order with their original mutation IDs once the browser is back online, even after the page was
  closed. Query results are cached too (`cacheDocuments`), so a reload starts with the last known list,
  marked `stale` until the server answers. Changes older than the server's idempotency window are not
  replayed silently; the app offers to send or discard them.
- **Fallback transports.** The client loads `canopy.js/fallback` only when two WebSocket handshakes
  fail, then works over SSE and probes WebSocket again every minute.

## Run it

You need a MongoDB replica set (`bun run db:up` at the repository root starts one on `localhost:27017`)
and Node.js 24 or later, or Bun.

```bash
bun install
bun run build
node examples/todo-react/src/server.ts
```

Open <http://localhost:3000/?user=alice> and <http://localhost:3000/?user=bob> side by side. Settings come
from the environment: `PORT`, `MONGODB_URI`, `TODO_DB`, `CANOPY_META_DB`, `CANOPY_PUBLISHABLE_KEY`,
`TODO_DISABLE_WEBSOCKETS=1` (to try the SSE fallback) and `TODO_DEV_ISSUER_KEY` (an Ed25519 private JWK, so
several servers accept the same tokens).

The development issuer signs a token for anyone who asks. It exists only to keep the example self
contained: a real app gets its tokens from its identity provider (`auth.getToken`) and configures Canopy
with that provider's JWKS.

## Tests

```bash
CANOPY_TEST_MONGODB_URI="mongodb://localhost:27017/?replicaSet=rs0" bunx vitest run --project todo-react
cd examples/todo-react
node node_modules/@playwright/test/cli.js install chromium
CANOPY_TEST_MONGODB_URI="mongodb://localhost:27017/?replicaSet=rs0" node node_modules/@playwright/test/cli.js test
```

The Playwright suite (`e2e/`) starts two servers on one database, a regular one and one that refuses
WebSockets. It covers two tabs of one user, two users with different visibility, a refused delete, a
rename conflict, changes queued offline and replayed online or after closing the page, and SSE clients
working alongside WebSocket clients.
