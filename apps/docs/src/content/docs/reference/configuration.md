---
title: Configuration
description: Every setting of canopy.config.ts and the environment variables that fill them.
---

`canopy.config.ts` (or `canopy/canopy.config.ts`) exports `defineConfig(...)`: an object, or a function of
`{ mode, command }` returning one. Environment variables may fill a setting the file leaves out, but may not
contradict it. `canopy config print --sources` shows each resolved value and where it came from, with secrets
masked. An invalid config stops every command before it connects, with all problems listed at once.

## Top level

| Setting                 | Variable                     | Default                     | What                                                     |
| ----------------------- | ---------------------------- | --------------------------- | -------------------------------------------------------- |
| `mongodb.uri`           | `MONGODB_URI`                | required                    | The connection string; its path names the app database   |
| `mongodb.database`      | `CANOPY_DB`                  | the URI path                | The app database                                         |
| `mongodb.metaDatabase`  | `CANOPY_META_DB`             | `canopy`                    | Canopy's own state                                       |
| `mongodb.authDatabase`  | `CANOPY_AUTH_DB`             | `canopy_auth`               | Built in auth's users and sessions                       |
| `environment`           | `CANOPY_ENV`                 | `development`               | `production` turns on stricter checks                    |
| `publicUrl`             | `CANOPY_PUBLIC_URL`          |                             | The external base URL: token issuer, redirects, passkeys |
| `masterKey`             | `CANOPY_MASTER_KEY`          | required in production      | Encrypts stored secrets                                  |
| `previousMasterKeys`    | `CANOPY_MASTER_KEY_PREVIOUS` |                             | Keys being rotated out                                   |
| `keys.publishable`      | `CANOPY_PUBLISHABLE_KEYS`    |                             | Keys of the `anon` role, in addition to stored keys      |
| `keys.secret`           | `CANOPY_SECRET_KEYS`         |                             | Keys of the `service` role                               |
| `policies`              | `CANOPY_POLICIES` (a folder) | stored in the meta database | `{ dir, watch }` or `{ source: "database" }`             |
| `cors.origins`          | `CANOPY_CORS_ORIGINS`        | `publicUrl`                 | Allowed browser origins, or `"*"`                        |
| `server.port`           | `PORT`                       | 8080                        | The HTTP and WebSocket port                              |
| `server.metricsPort`    | `METRICS_PORT`               | 9464                        | Prometheus metrics; keep it private                      |
| `server.metricsHost`    | `METRICS_HOST`               | `127.0.0.1`                 | Address the metrics port binds; the images use `0.0.0.0` |
| `server.metricsToken`   | `CANOPY_METRICS_TOKEN`       | none                        | Bearer token scrapers must send, 16 characters or more   |
| `server.adminListen`    | `CANOPY_ADMIN_LISTEN`        |                             | Serves `/admin` and `/studio` only on this address       |
| `server.nodeId`         | `CANOPY_NODE_ID`             | `n1`                        | Names this instance in logs and metrics                  |
| `server.trustedProxies` | `CANOPY_TRUSTED_PROXIES`     |                             | Proxies whose `X-Forwarded-For` is trusted               |
| `server.engine`         | `CANOPY_ENGINE`              | `auto`                      | `native`, `wasm` or `ts`; `auto` takes the first that loads |
| `log.level`             | `CANOPY_LOG_LEVEL`           | `info`                      | `debug`, `info`, `warn` or `error`                       |
| `dev.insecure`          | `CANOPY_DEV_INSECURE`        | `false`                     | Development only switches; refused in production         |

## `auth`

`external({ jwksUrl, issuer, audience, algorithms, rolesClaim, clockToleranceSeconds })` verifies tokens of
your identity provider (`CANOPY_JWT_JWKS_URL`, `CANOPY_JWT_ISSUER`, `CANOPY_JWT_AUDIENCE`,
`CANOPY_JWT_ALGORITHMS`, `CANOPY_JWT_ROLES_CLAIM`). Presets fill in the endpoints of common providers:
`external.auth0({ domain, audience })`, `external.clerk(...)`, `external.firebase({ projectId })` and
`external.supabase({ projectRef })`.

`builtin({ ... })` runs user auth inside Canopy:

| Setting                 | Default | What                                                                                              |
| ----------------------- | ------- | ------------------------------------------------------------------------------------------------- |
| `emailPassword`         | on      | `{ minPasswordLength, requireEmailVerification }`                                                 |
| `magicLink`, `emailOtp` | on      | Passwordless sign in by link or code                                                              |
| `anonymous`             | off     | Guest users that can be upgraded later                                                            |
| `twoFactor`, `passkeys` | on      | TOTP with backup codes, and WebAuthn passkeys                                                     |
| `providers`             |         | `google`, `github`, `apple`, `microsoft`, `discord` OAuth clients                                 |
| `oidc`                  |         | Any OpenID Connect issuer                                                                         |
| `redirectUrls`          |         | Where OAuth and magic links may return to                                                         |
| `accessTokenTtl`        |         | Lifetime of access tokens                                                                         |
| `keyRotation`           |         | `{ interval, grace }` of the signing keys                                                         |
| `session`               |         | `{ expiresIn, updateAge }`                                                                        |
| `email`                 |         | `{ from, transport }`: `email.smtp`, `email.resend`, `email.postmark`, `email.ses` or `email.log` |
| `claims`                |         | A hook that adds claims and roles to access tokens                                                |
| `identifierLimit`       |         | Sign in attempts per email in a window                                                            |

## `rest`

`false` turns the Data API off (and GraphQL with it).

| Setting        | Variable              | Default |
| -------------- | --------------------- | ------- |
| `defaultLimit` |                       | 100     |
| `maxLimit`     |                       | 1000    |
| `maxBodyBytes` |                       | 1 MiB   |
| `mutationTtl`  | `CANOPY_MUTATION_TTL` | `24h`   |

## `graphql`

`false` turns GraphQL off. `maxDepth` (10), `maxComplexity` (5000), `maxAliases` (30), `maxBatch` (10),
`introspection` (`authenticated` in production, `always` otherwise, or `never`) and
`persisted: { file, only }`. See [GraphQL](/guides/graphql/).

## `realtime`

| Setting        | Variable                        | Default                             |
| -------------- | ------------------------------- | ----------------------------------- |
| `fullDocument` | `CANOPY_REALTIME_FULL_DOCUMENT` | `auto`                              |
| `transports`   |                                 | `["websocket", "sse", "long-poll"]` |
| `resumeWindow` | `CANOPY_RESUME_WINDOW`          | `2m`                                |
| `checkpoints`  | `CANOPY_CHECKPOINTS`            | `meta`                              |
| `drainWindow`  | `CANOPY_DRAIN_WINDOW`           | `30s`                               |
| `echoTimeout`  | `CANOPY_ECHO_TIMEOUT`           | `2s`                                |
| `server`       | `CANOPY_REALTIME_SERVER`        | `ts`                                |

`server: "gateway"` serves realtime from the native `canopy-gateway` executable instead of the engine inside the
TypeScript process. `canopy-realtime` then runs the gateway with the same configuration. `canopy-server` and
`canopy dev` run it on the public port, where it answers `/realtime/v1` (WebSocket, SSE and long polling)
and passes every other request to the TypeScript server, which listens on loopback only and trusts the
gateway's `X-Forwarded-For`.
Socket writes go to the server's REST write path, and their acknowledgements still wait for their change
events. Built in auth works: the gateway verifies tokens with the server's own JWKS. GraphQL subscriptions
follow their live queries through the gateway over loopback. The `canopy-server` metrics port also carries
the gateway's metrics, scraped every second. The executable comes from `CANOPY_GATEWAY_BIN`, the container
images, or a Cargo build of the repository.

`CANOPY_DATA_PLANE_ROUTES` (experimental, off by default) lists the Data API routes the gateway answers itself, in
Rust, with the same policies, keys and tokens: `find` (`GET /rest/v1/{collection}`), `count`, `distinct`,
`aggregate`, `query` and `explain` (`POST /rest/v1/{collection}/_count`, `_distinct`, `_aggregate`, `_query` and
`_explain`), `document` (`GET /rest/v1/{collection}/{id}`), and `writes` (every write route: inserts, updates, replacements, deletes, bulk writes and
`_batch`), for example
`CANOPY_DATA_PLANE_ROUTES=find,count`. Every other request goes to the TypeScript server as before. Unknown route
names stop the gateway at startup. The Rust routes apply `rateLimits.requests` and
`rateLimits.failedAuthentications` as the server does, counted by the gateway on its own, so a caller has one
budget there and one on the server. They write sampled requests to the request log as the server does, and with
`CANOPY_TRACING` they record the server's spans, exported over OTLP/HTTP (see
[metrics and tracing](/operations/tracing/)).

## `rateLimits`

Per caller token buckets for the data plane, counted in memory by each instance. `false` turns them off. See
[Rate limits](/guides/rate-limits/).

| Setting                          | Variable                                  | Default                       |
| -------------------------------- | ----------------------------------------- | ----------------------------- |
| `enabled`                        | `CANOPY_RATE_LIMITS`                      | `true`                        |
| `requests.perSecond`, `.burst`   | `CANOPY_RATE_LIMIT_REQUESTS`, `..._REQUEST_BURST` | 50 and 200            |
| `messages.perSecond`, `.burst`   | `CANOPY_RATE_LIMIT_MESSAGES`, `..._MESSAGE_BURST` | 20 and 100            |
| `anonymousConnectionsPerAddress` | `CANOPY_RATE_LIMIT_ANONYMOUS_CONNECTIONS` | 50                            |
| `failedAuthentications.perSecond`, `.burst` | `CANOPY_RATE_LIMIT_FAILED_AUTH`, `..._FAILED_AUTH_BURST` | 1 and 30 |
| `exemptService`                  | `CANOPY_RATE_LIMIT_EXEMPT_SERVICE`        | `true`                        |

`requests` covers REST and GraphQL requests; `messages` covers the realtime frames `sub`, `mut` and `auth`.

## `audit`

| Setting      | Variable                   | Default | Description                                                    |
| ------------ | -------------------------- | ------- | -------------------------------------------------------------- |
| `dataWrites` | `CANOPY_AUDIT_DATA_WRITES` | `false` | Record every committed REST, GraphQL and realtime write in the audit log |

Each entry is a `data.<op>` action (`data.insert`, `data.updateMany`, ...) with the caller's subject as the
actor, the collection and the `_id` of every document written as the target, and the caller's roles, the
cluster time and the mutation ID as details. Documents are never copied into the log. Entries are written after
the commit, one insert into the meta database per write; a failed insert is logged and does not fail the
write. Studio shows them on the Audit page, and the audit retention setting expires them like other entries.

## `storage`

| Setting         | Variable                       | Default              | Description                                          |
| --------------- | ------------------------------ | -------------------- | ---------------------------------------------------- |
| `backend`       |                                | `{ kind: "local", root: "storage" }` | `{ kind: "local", root? }` (relative to the config file), `{ kind: "r2", accountId, bucket, accessKeyId, secretAccessKey, jurisdiction?, prefix? }` or `{ kind: "s3", region, bucket, accessKeyId, secretAccessKey, endpoint?, sessionToken?, forcePathStyle?, prefix? }` |
| `maxFileSize`   | `CANOPY_STORAGE_MAX_FILE_SIZE` | `52428800`           | The largest file sent in one request, in bytes        |
| `maxUploadSize` |                                | `5368709120`         | The largest resumable upload, in bytes               |
| `images.enabled` | `CANOPY_STORAGE_IMAGES`       | `true`               | Serve image transformations at `/storage/v1/render/image` |
| `images.maxDimension` |                          | `2500`               | The largest width or height a transformation may ask for, in pixels |
| `images.maxSourceSize` |                         | `26214400`           | The largest image transformed, in bytes              |
| `buckets`       |                                | `{}`                 | `{ <name>: { public?, maxFileSize?, allowedTypes? } }`; storage is on with at least one |

See [storage](/guides/storage/).

## `webhooks`

| Setting       | Variable                | Default | Description                                                         |
| ------------- | ----------------------- | ------- | ------------------------------------------------------------------- |
| `secret`      | `CANOPY_WEBHOOK_SECRET` |         | Signs every delivery; `whsec_` and base64, or 16 characters or more  |
| `maxAttempts` |                         | `8`     | Attempts before a delivery becomes a dead letter                     |
| `timeout`     |                         | `"10s"` | How long one attempt may take                                        |
| `triggers`    |                         | `{}`    | `{ <name>: { collection, operations?, filter?, url } }`              |
| `schedules`   |                         | `{}`    | `{ <name>: { cron, url, body? } }`, cron in UTC                      |

See [triggers and scheduled jobs](/guides/webhooks/).

## `telemetry`

| Setting   | Variable         | Default | Description                                                              |
| --------- | ---------------- | ------- | ------------------------------------------------------------------------ |
| `tracing` | `CANOPY_TRACING` | `false` | OpenTelemetry spans for requests, MongoDB commands, policy loads and fan out; see [metrics and tracing](/operations/tracing/) |

## `collections`

Per collection: `idType` (`auto`, `objectId`, `string`, `uuid` or `number`), the GraphQL `typeName`,
GraphQL `relations: { <field>: { to, local, foreign, many } }`, and `search: true` to allow `$search` and
`$vectorSearch` in Data API aggregations ([search](/guides/rest/#search)).

## Reading variables

`env("NAME")` reads a string; `env.int`, `env.bool`, `env.list` (comma separated), `env.url` and
`env.duration` (`500ms`, `30s`, `5m`, `24h`, `7d`) parse it. Each has `.optional(...)`, and all but
`env.secret` take `{ default }`. `env.secret` is redacted everywhere. Missing variables are reported together.
