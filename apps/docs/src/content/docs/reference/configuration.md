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
| `log.level`             | `CANOPY_LOG_LEVEL`           | `info`                      | `debug`, `info`, `warn` or `error`                       |
| `types.out`             |                              | `src/canopy.gen.ts`         | Where `canopy gen types` writes                          |
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

Per collection: `idType` (`auto`, `objectId`, `string`, `uuid` or `number`), the GraphQL `typeName`, and
GraphQL `relations: { <field>: { to, local, foreign, many } }`.

## Reading variables

`env("NAME")` reads a string; `env.int`, `env.bool`, `env.list` (comma separated), `env.url` and
`env.duration` (`500ms`, `30s`, `5m`, `24h`, `7d`) parse it. Each has `.optional(...)`, and all but
`env.secret` take `{ default }`. `env.secret` is redacted everywhere. Missing variables are reported together.
