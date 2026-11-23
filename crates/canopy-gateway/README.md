# canopy-gateway

Canopy's native realtime server, written in Rust. It speaks wire protocol `canopy.v1` exactly like the
`canopy-realtime` sidecar, so every SDK and binding works against it unchanged.

The Rust `canopy-realtime` library runs the WebSocket, SSE and long polling transports, the session engine
and change stream ingestion. The `canopy-config` crate parses the resolved configuration and defines its
[JSON Schema](../canopy-config/schema/config.schema.json). The `canopy-gateway` binary reads the CLI arguments,
configuration input and environment variables. It also handles client address resolution, logging, the reverse
proxy and mutation forwarding to the TypeScript server.

- One change stream per deployment, read as raw BSON and matched in place by `canopy-matcher`.
- The routing of `canopy-engine`: observers shared by identical queries, indexed by equality value (MongoDB
  numeric equality), membership and path; merge boxes that send a document once per connection; bounded resume
  buffers; `resync` when gap free delivery cannot be promised.
- The same policies as every other entry point, compiled by `canopy-policy`, including field rules and context
  lookups (`$ctx`), which are cached by key, expire with their `ttl` and are resolved again when their source
  documents change.
- Writes over the socket (`mut`) are forwarded to the REST write path with the caller's own credentials and the
  mutation id as the idempotency key, so `check` rules, transactions and idempotency keep one implementation;
  the `ack` waits for the write's change events (echo before ack).
- API keys and user tokens: secret keys give `service`, publishable keys `anon`, and JWTs are verified against
  a JWKS (inline or fetched over HTTPS) with the algorithms, issuer, audience, expiry and roles rules of
  `@canopy/auth`.
- Tokio and Hyper. Sockets are spread over I/O shards, single threaded runtimes that each own their
  connections; the engine runs on its own thread and hands each shard one batch of frames per step.
- The SSE and long polling fallback transports for networks that block WebSockets, with the same endpoints,
  tickets and CORS rules as the TypeScript engine.
- A front door mode (`proxy.url` or `CANOPY_GATEWAY_PROXY_URL`): every path the gateway does not serve goes to an
  upstream HTTP server, WebSocket upgrades included, with the client added to `X-Forwarded-For`. `canopy-server`
  uses it when `realtime.server` is `gateway`.
- Prometheus metrics on the metrics port, `/healthz`, and `/readyz` (ready once the change stream is open).

## Running it

Download `canopy-gateway-<target>` from a [Native release builds workflow run](https://github.com/FlazexHQ/Canopy/actions/workflows/native-release.yml).
Each artifact contains a ZIP archive for Windows or a tar.gz archive for Linux and macOS, with a SHA256 checksum
for the archive. Point `CANOPY_GATEWAY_BIN` at the extracted executable to run it through the sidecar.

Through the sidecar, which resolves the configuration file and the policies (TypeScript policy files included)
and starts the gateway with them:

```sh
cargo build --release -p canopy-gateway
CANOPY_REALTIME_SERVER=gateway canopy-realtime --config canopy.config.ts
```

For a source build, the sidecar can also find the executable in the repository's `target/` folder.
The `canopy-realtime` image already includes the executable and sets `CANOPY_GATEWAY_BIN`. Set
`CANOPY_REALTIME_SERVER=gateway` to use it.

Standalone, with the variables of `canopy-realtime` (`MONGODB_URI`, `CANOPY_DB`, `CANOPY_META_DB`,
`CANOPY_PUBLISHABLE_KEYS`, `CANOPY_SECRET_KEYS`, `CANOPY_JWT_*`, `PORT`, `METRICS_PORT` and the others) and the
policies stored in the meta database:

```sh
canopy-gateway
```

The standalone container image uses policies from the meta database. A published GitHub release builds
`ghcr.io/flazexhq/canopy-gateway:<tag>` for Linux x64 and arm64. To build the image locally, run
`docker build -f deploy/docker/canopy-gateway.Dockerfile -t canopy-gateway .` from the repository root.
The image listens on port 8080 for realtime and 9464 for metrics. To change the metrics bind address in
standalone mode, mount a JSON configuration and set `server.metricsHost`.

Or with a JSON configuration: `canopy-gateway --config file.json`, or `--config -` to read it from the first line
of standard input. In that mode later lines may replace the policies (`{"t":"policies","stored":[…]}`), and
closing standard input drains the server and stops it.

`CANOPY_GATEWAY_MUTATIONS_URL` (or `mutations.url`) is the REST base URL writes are forwarded to, for example
`http://127.0.0.1:8080/rest/v1`. Without it, `mut` frames are refused, as on the sidecar.

`CANOPY_DATA_PLANE_ROUTES` (or `dataPlane.routes`, a name or a list of names) lists the Data API routes the
gateway answers itself instead of passing them to the upstream server. It is empty by default, so every REST
request goes to the upstream. `find` selects `GET /rest/v1/{collection}` with the `OPTIONS` and `405` answers
of that path; every other path and method (writes, documents, `_count`, `_distinct`, `_aggregate`, `_batch`,
`openapi.json`, GraphQL, storage) is passed on untouched. A name the gateway does not know stops it at startup,
as does `rest: false` in the configuration with a route selected. The route reads with the gateway's own MongoDB
client, with the keys, JWKS, revocations and policies the realtime sessions use (the policies are read again
every time the policy watch opens, so a change made while it was down still applies), and it answers as the
TypeScript handler does, byte for byte where the response is deterministic. `rest.defaultLimit` and
`rest.maxLimit` set the page sizes (the TypeScript launcher passes its own), and `cors.origins` the browser
origins. A failing read never falls back to the upstream and never returns data: a database that cannot be
reached answers `503` Problem Details. The route does not apply the HTTP request rate limits
(`rateLimits.requests` and `failedAuthentications`), the request log, tracing or `explainDenials` of the
TypeScript handler yet, so leave it off where those matter.

`CANOPY_GATEWAY_SHARDS` (or `server.shards`) sets the number of I/O shards, by default the number of cores up to
four.

Frames a WebSocket connection has queued go out in one `write` to the socket (up to 8 KiB each). With
`CANOPY_GATEWAY_COALESCE_MS` (or `realtime.coalesceMs`, 0 to 1000, default 0), a frame that finds the
connection idle still goes out at once, but frames that follow within that many milliseconds wait until the
window ends or 64 KiB are queued, and share one `write` (and one `batch` frame for clients that negotiated
batching). It trades delivery latency for CPU per frame on connections that receive many frames, such as a
broadcast to thousands of viewers.

The gateway uses `canopy-mongo` for snapshot reads, stored policies and change stream checkpoints.
`canopy-auth` looks up stored keys in `api_keys` in the configured meta database. The gateway closes sessions when
their key is revoked or deleted. When launched as the front door for built in auth, it follows
`revocations` in the same database and refuses tokens from revoked sessions.

`CANOPY_TRUSTED_PROXIES` (or `server.trustedProxies`) lists the trusted proxy addresses and CIDR ranges.
WebSocket and HTTP fallback connections use `X-Forwarded-For` only when the socket peer is trusted.
