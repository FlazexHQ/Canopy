# canopy-gateway

Canopy's native realtime server, written in Rust. It speaks wire protocol `canopy.v1` exactly like the
`canopy-realtime` sidecar, so every SDK and binding works against it unchanged.

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
- Prometheus metrics on the metrics port, `/healthz`, and `/readyz` (ready once the change stream is open).

## Running it

Through the sidecar, which resolves the configuration file and the policies (TypeScript policy files included)
and starts the gateway with them:

```sh
cargo build --release -p canopy-gateway
CANOPY_REALTIME_SERVER=gateway canopy-realtime --config canopy.config.ts
```

The sidecar finds the executable through `CANOPY_GATEWAY_BIN`, or in the `target/` folder of the repository.

Standalone, with the variables of `canopy-realtime` (`MONGODB_URI`, `CANOPY_DB`, `CANOPY_META_DB`,
`CANOPY_PUBLISHABLE_KEYS`, `CANOPY_SECRET_KEYS`, `CANOPY_JWT_*`, `PORT`, `METRICS_PORT` and the others) and the
policies stored in the meta database:

```sh
canopy-gateway
```

Or with a JSON configuration: `canopy-gateway --config file.json`, or `--config -` to read it from the first line
of standard input. In that mode later lines may replace the policies (`{"t":"policies","stored":[…]}`), and
closing standard input drains the server and stops it.

`CANOPY_GATEWAY_MUTATIONS_URL` (or `mutations.url`) is the REST base URL writes are forwarded to, for example
`http://127.0.0.1:8080/rest/v1`. Without it, `mut` frames are refused, as on the sidecar.

`CANOPY_GATEWAY_SHARDS` (or `server.shards`) sets the number of I/O shards, by default the number of cores up to
four.

## Not yet supported

- The SSE and long polling fallback transports: the gateway serves WebSockets only.
- `sub.o.explain`, stored API keys from the meta database, session revocations and view tokens (the sidecar does
  not have the last three either).
- Serving the REST API's paths as a front door; route `/realtime/v1` to the gateway's port instead.
- Trusted proxy headers for client addresses: the socket peer is used.
