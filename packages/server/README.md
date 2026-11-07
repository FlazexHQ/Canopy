# @canopy/server

The Canopy platform server: the Data API (REST), realtime (WebSocket, SSE and long polling), Document Level
Security policies, health checks and metrics in one process, built from one config. Use it as the
`canopy-server` process or container, or embed it with `createCanopy()`.

For live queries next to an existing app without the Data API, the
[`canopy-realtime` sidecar](../realtime/README.md) is the smaller option.

## Quickstart with Docker Compose (about 5 minutes)

You need Docker with Compose. From a clone of this repository:

```bash
docker compose -f deploy/compose/canopy.yaml up -d --build --wait
```

This starts a single node MongoDB replica set and the `canopy` image, with the policies in
`deploy/compose/policies` mounted at `/app/policies`. The server is ready when `/readyz` answers `ready`:

```bash
curl localhost:8080/readyz
```

Write and read a document with the development secret key (the `service` role, which bypasses policies):

```bash
curl -X POST localhost:8080/rest/v1/notes -H "apikey: sk_dev_change_me" \
  -H "content-type: application/json" -d '{"ownerId":"user_1","text":"hello"}'
curl localhost:8080/rest/v1/notes -H "apikey: sk_dev_change_me"
```

The publishable key `pk_dev` is the `anon` role, so the example policy returns no notes for it. Signed in
users come from your identity provider: set `CANOPY_JWT_JWKS_URL`, `CANOPY_JWT_ISSUER` and
`CANOPY_JWT_AUDIENCE` (and `CANOPY_JWT_ROLES_CLAIM` for roles) before `docker compose up`. The header of
[`deploy/compose/canopy.yaml`](../../deploy/compose/canopy.yaml) lists every variable it reads, including the
keys, the host ports and `CANOPY_POLICY_DIR` to mount your own policy folder. Change the keys before
exposing the stack anywhere.

`deploy/compose/canopy-smoke.sh` checks a running stack end to end. Stop it with
`docker compose -f deploy/compose/canopy.yaml down` (add `--volumes` to delete the data).

## Run the process

With Bun or Node.js 24 or newer, after `bun install && bun run build` in a clone:

```bash
bun packages/server/dist/bin/canopy-server.js --config canopy/canopy.config.ts
```

```bash
node packages/server/dist/bin/canopy-server.js --config canopy/canopy.config.ts
```

Without `--config`, `canopy.config.ts` or `canopy/canopy.config.ts` is looked up from the working directory,
and without a config file the environment configures everything (`MONGODB_URI`, `CANOPY_DB`,
`CANOPY_POLICIES`, `CANOPY_PUBLISHABLE_KEYS`, `CANOPY_SECRET_KEYS`, `CANOPY_JWT_*`, `PORT`, `METRICS_PORT`
and the others in the [realtime configuration table](../realtime/README.md#configuration)). A variable may
fill a setting the config file leaves out, but may not contradict it. `canopy config print --sources` shows
the resolved values and where each came from.

An invalid config stops the process before it connects, with exit code 1 and every problem listed at once:

```text
canopy: the environment has 2 problems

  mongodb.uri
    Expected a connection string starting with "mongodb://" or "mongodb+srv://".

  server.port
    Received 99999.
    Expected a port between 0 and 65535.
```

To build the container yourself:

```bash
docker build -f deploy/docker/canopy.Dockerfile -t canopy .
docker run --rm -p 8080:8080 --env-file canopy.env -v "$PWD/canopy/policies:/app/policies:ro" canopy
```

The image is distroless and runs as a non root user. From inside a container, `localhost` is the container
itself; reach a replica set on your machine with `mongodb://host.docker.internal:27017/app?directConnection=true`.

## Standalone executables

`bun deploy/binary/build.ts` compiles `canopy` (the CLI) and `canopy-server` into single files that embed
the Bun runtime and need no Bun, Node or `node_modules` on the target machine. Policy and config files
importing `@canopy/policy` or `@canopy/config` resolve to the copies inside the executable.

```bash
bun deploy/binary/build.ts --target linux-x64 --target darwin-arm64 --out dist/binaries
```

Targets are `linux-x64`, `linux-arm64`, their `-musl` variants (Alpine needs `libstdc++`), `darwin-x64`,
`darwin-arm64`, `windows-x64` and `windows-arm64`; `--all` builds every one. A `SHA256SUMS` file is written
next to them.

## Endpoints

| Port           | Path                    | What                                                             |
| -------------- | ----------------------- | ---------------------------------------------------------------- |
| `PORT`         | `/rest/v1/<collection>` | The Data API, filtered by your policies.                         |
| `PORT`         | `/realtime/v1`          | Realtime over WebSocket, and the SSE and long polling sessions.  |
| `PORT`         | `/healthz`              | `200 ok` while the process runs (liveness).                      |
| `PORT`         | `/readyz`               | `200 ready`, or `503 draining` once shutdown starts (readiness). |
| `METRICS_PORT` | `/metrics`              | Prometheus metrics. Keep this port private.                      |

Logs are JSON lines on stderr, with secrets redacted; `CANOPY_LOG_LEVEL` sets the level.

## Shutdown

On SIGTERM or SIGINT the server fails readiness, tells every realtime client to reconnect within
`CANOPY_DRAIN_WINDOW` (default `30s`), closes the sockets and the MongoDB connection, and exits 0. Give your
orchestrator a stop timeout longer than the drain window (the compose file uses 40 seconds).

## Embedding

```ts
import { createServer } from "node:http"
import { createCanopy } from "@canopy/server"
import { loadConfig } from "@canopy/config/load"

const { config } = await loadConfig({ command: "start" })
const canopy = await createCanopy(config)
const server = createServer(
  canopy.node({ fallback: (request, response) => app(request, response) }),
)
await canopy.attach(server)
server.listen(config.server.port)
```

On Bun, `Bun.serve({ port, ...canopy.bun() })` serves the same routes with WebSockets.
