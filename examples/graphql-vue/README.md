# graphql-vue

A small message board in Vue on Canopy's GraphQL API. Every visitor is signed in anonymously by Canopy's
built in auth, can post under a topic and delete their own posts, and sees everyone's posts arrive live.

One Node server (`src/app.ts`) runs everything:

- `createCanopy` from `@canopy/server`: GraphQL (`/graphql/v1`), the Data API, realtime and built in auth
  with anonymous sign in;
- the page (`web/main.ts`), a Vue 3 app written with render functions and bundled with esbuild, so it needs
  no Vue compiler.

## What it shows

- **Queries with a relation.** One GraphQL query reads the topics and the latest posts with each post's
  topic (`topic { name }`), resolved through `collections.posts.relations` in the config and the `topics`
  policies.
- **Mutations.** `insertPost` and `deletePost` run through the same transactional write path as REST, so the
  policies in `src/policies.ts` decide: a post must carry the caller's own id as `ownerId`, may only have the
  listed fields, and only its owner can delete it (another visitor's delete resolves to `null` and changes
  nothing).
- **Live updates in Vue.** `useQuery` from `canopy.js/vue` follows a live query of the posts; when it changes,
  the page reads the board again through GraphQL, so a post from another visitor appears at once.
- **Types from validators.** `src/schema.ts` gives both collections a `$jsonSchema` validator, which the
  GraphQL schema is generated from, so the fields are typed before the first post exists.

## Run it

You need a MongoDB replica set (`bun run db:up` at the repository root starts one on `localhost:27017`)
and Node.js 24 or later, or Bun.

```bash
bun install
bun run build
node examples/graphql-vue/src/server.ts
```

Open <http://localhost:3000/> in two browsers (or a normal and a private window) and post from both.
Settings come from the environment: `PORT`, `PUBLIC_URL`, `MONGODB_URI`, `BOARD_DB`,
`CANOPY_PUBLISHABLE_KEY`, `CANOPY_MASTER_KEY` and `NODE_ENV`.

## Tests

```bash
CANOPY_TEST_MONGODB_URI="mongodb://localhost:27017/?replicaSet=rs0" bunx vitest run --project graphql-vue
cd examples/graphql-vue
node node_modules/@playwright/test/cli.js install chromium
CANOPY_TEST_MONGODB_URI="mongodb://localhost:27017/?replicaSet=rs0" node node_modules/@playwright/test/cli.js test
```
