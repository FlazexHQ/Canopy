# Canopy Chat

A Next.js and React 19 example with one shared room. Members register with an email address and password. The room subscribes to the latest 100 messages. Document policies allow authenticated members to read messages and require each new message to carry its sender's user ID.

## Run locally

From the repository root, run `bun install --frozen-lockfile` and `bun run build` to compile the workspace packages. Then run these commands from `examples/chatapp`:

```sh
node -e "require('node:fs').writeFileSync('.env','CANOPY_MASTER_KEY='+require('node:crypto').randomBytes(32).toString('base64url')+'\n',{flag:'wx'})"
docker compose up -d --build --wait
bun run build
bun run start --hostname localhost
```

Generate the key once and keep it with the local deployment. Open [Canopy Chat](http://localhost:3000). Register a second account in a private browser window to try realtime delivery.

The Compose project runs Canopy and a single member MongoDB replica set. It exposes REST, GraphQL, realtime, email/password auth, private file storage, the admin API, [Studio](http://localhost:8080/studio/) and [metrics](http://localhost:9464/metrics) on loopback. Studio uses a separate administrator account. The initial setup token appears in `docker compose logs canopy`. Database and file contents persist in named volumes.

Run `bun run e2e:install` and `bun run e2e` while both services and the app are running to test two accounts, live delivery, sign-out and session restoration. The test creates accounts and a message in this local room. Stop the backend with `docker compose down`.
