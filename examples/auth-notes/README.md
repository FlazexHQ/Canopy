# auth-notes

Private notes on Canopy with its built in auth: people create an account with an email address and a
password, sign in, and see a live list of their own notes. No external identity provider is involved.

One Node server (`src/app.ts`) runs everything:

- `createCanopy` from `@canopy/server` with `builtin()` auth (`/auth/v1`), the Data API (`/rest/v1`) and
  realtime (`/realtime/v1`);
- the page (`web/`), a few lines of plain TypeScript bundled with esbuild.

## What it shows

- **Sign up and sign in.** `createAuth()` from `@canopy/client/auth` creates the account, signs in and
  keeps the session in IndexedDB, so a reload stays signed in. A wrong password is reported on the page.
- **Document level security.** `src/policies.ts` lets a signed in user read, create, edit and delete only
  the notes whose `ownerId` is their own user id (`auth("sub")`). Two people side by side never see each
  other's notes, and a forged `ownerId` is refused by the server.
- **Live queries.** The list is a live query: a note added or deleted in one tab shows up in every other
  tab of the same user at once.

Email verification is off here (`requireEmailVerification: false`) so the example runs without a mail
server. Turn it on and configure `email` in production.

## Run it

You need a MongoDB replica set (`bun run db:up` at the repository root starts one on `localhost:27017`)
and Node.js 24 or later, or Bun.

```bash
bun install
bun run build
node examples/auth-notes/src/server.ts
```

Open <http://localhost:3000/>, create an account, and add a note. Open a private window, create another
account, and compare. Settings come from the environment: `PORT`, `PUBLIC_URL`, `MONGODB_URI`, `NOTES_DB`,
`CANOPY_PUBLISHABLE_KEY`, `CANOPY_MASTER_KEY` and `NODE_ENV`. Without `CANOPY_MASTER_KEY`, the server keeps
a generated development key in `examples/auth-notes/.canopy/master-key`; production refuses to start
without one.

## Tests

```bash
CANOPY_TEST_MONGODB_URI="mongodb://localhost:27017/?replicaSet=rs0" bunx vitest run --project auth-notes
cd examples/auth-notes
node node_modules/@playwright/test/cli.js install chromium
CANOPY_TEST_MONGODB_URI="mongodb://localhost:27017/?replicaSet=rs0" node node_modules/@playwright/test/cli.js test
```
