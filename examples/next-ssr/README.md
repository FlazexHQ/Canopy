# next-ssr

A Next.js App Router page on Canopy that is rendered on the server and then stays live in the browser.

- `canopy/server.ts` runs Canopy (`createCanopy`) with one public collection: anyone with the publishable key
  reads the `articles` whose `published` is `true`.
- `app/page.tsx` is a Server Component. It reads the latest articles with `createServerClient` from
  `canopy.js/server`, under the same policies, and passes the result through `dehydrate`.
- `app/articles.tsx` is a Client Component. `Hydrate` seeds its live query with the server's result, so the
  first paint already has the list (marked `stale`), and the socket takes over from the cluster time of that
  read: articles published, unpublished or edited later show up without a reload.

## What it shows

- **Server rendering with DLS.** The HTML contains the published articles and never the drafts: the server
  read goes through the policies like every other read.
- **Hydration without a second fetch or a flash.** The browser's live query starts from the server's
  documents and only receives the changes after them.
- **Live updates.** A document written to MongoDB by anything (here, the tests write directly) reaches the
  page; one that leaves the policy's filter (unpublished) disappears.

## Run it

You need a MongoDB replica set (`bun run db:up` at the repository root starts one on `localhost:27017`)
and Node.js 24 or later. Next.js uses the built packages, so build them first:

```bash
bun install
bun run build
cd examples/next-ssr
node canopy/server.ts
```

and in a second terminal:

```bash
cd examples/next-ssr
node node_modules/next/dist/bin/next dev
```

Open <http://localhost:3000/> and insert a document with `mongosh`:

```js
use next_ssr
db.articles.insertOne({ title: "Hello", published: true, publishedAt: new Date() })
```

Settings come from the environment: `MONGODB_URI`, `ARTICLES_DB`, `CANOPY_PORT` and `SITE_URL` (the origin
Canopy accepts cross origin calls from) for Canopy; `NEXT_PUBLIC_CANOPY_URL` and `NEXT_PUBLIC_CANOPY_KEY`
for both.

## Tests

```bash
bun run build
cd examples/next-ssr
node node_modules/@playwright/test/cli.js install chromium
CANOPY_TEST_MONGODB_URI="mongodb://localhost:27017/?replicaSet=rs0" node node_modules/@playwright/test/cli.js test
```

The suite starts Canopy, builds and starts the Next.js app, checks the server rendered HTML, and follows
live changes in the browser.
