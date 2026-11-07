# 10: Operations

## 1. Requirements

| Component | Requirement |
|---|---|
| **MongoDB** | Replica set or sharded cluster, version **7.0+** before 1.0 and **8.0+** from 1.0. MongoDB 7.0 reaches end of life on 2027-08-31, close to the planned 1.0 date. Majority read concern enabled. Oplog window ≥ 24 h recommended. The app DB, the meta DB and the auth DB on the **same deployment**. |
| **Canopy node** | Development: 1 vCPU / 1 GB. Production baseline: 2 vCPU / 4 GB. Runs on Bun (primary; the container ships a pinned, tested Bun 1.x), Node.js 24 or 26 LTS, or Deno, from the container or directly on a Windows, Linux or macOS host. |
| **Network** | A load balancer that supports WebSockets, with an idle timeout of at least 60 s (more than 2× the heartbeat). Sticky sessions are recommended for multi-node deployments ([03 §11](03-realtime-engine.md#11-delivery-guarantees-resume-and-resync)). |
| **Edge (optional)** | Cloudflare Workers with Durable Objects; pre-/post-images enabled on collections served from the edge |

## 2. Compatibility matrix

Status as planned. Every "verify" row is checked during Phase 5 certification.

| Platform | Status | Notes |
|---|---|---|
| MongoDB Community / Enterprise 8.x, replica set | **Full** (reference) | Tested on every PR |
| MongoDB 8.x sharded cluster | **Full** | Tested nightly. `documentKey` includes the shard key. |
| MongoDB 7.0 | Supported until 1.0 | End of life 2027-08-31 |
| MongoDB Atlas, dedicated clusters | **Full** | |
| MongoDB Atlas Flex / free tier | Expected to work (verify) | Check change-stream, transaction and connection limits |
| Percona Server for MongoDB 7/8 | Expected to work (verify) | |
| Standalone `mongod` | Not supported | No change streams or transactions. Use a single-node replica set. |
| Amazon DocumentDB | Best-effort, degraded (verify) | Change streams must be enabled. Feature differences (likely no pre-/post-images) mean the polling or lookup paths. |
| Azure Cosmos DB for MongoDB | Best-effort, degraded (verify) | Change-stream limitations vary by offering (for example, delete events) |
| FerretDB | REST and auth only (verify) | Without change streams, realtime falls back to polling observers |

## 3. Deployment

- **Images:**
  - `ghcr.io/OWNER/canopy` (platform: auth, APIs, realtime, Studio);
  - `ghcr.io/OWNER/canopy-realtime` (slim, realtime only).

  Both are multi-arch (amd64 and arm64), distroless, non-root, with a read-only root filesystem. They run on
  Bun by default; a `node` tag variant of each runs on the current Node Active LTS.
- **Health endpoints:**
  - `/healthz` (liveness): the process is up;
  - `/readyz` (readiness): MongoDB is reachable, migrations are applied, the change stream is open, and lag is
    below the threshold.
- **Docker Compose** (local and small production):

```yaml
services:
  mongo:
    image: mongo:8.0
    command: ["--replSet", "rs0", "--bind_ip_all"]
    volumes: ["mongo-data:/data/db"]
    healthcheck:
      test: ["CMD", "mongosh", "--quiet", "--eval",
             "try { rs.status().ok } catch (e) { rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: 'mongo:27017' }] }).ok }"]
      interval: 5s
  canopy:
    image: ghcr.io/OWNER/canopy:0.4
    ports: ["8080:8080"]
    environment:
      MONGODB_URI: mongodb://mongo:27017/app?replicaSet=rs0
      CANOPY_PUBLIC_URL: http://localhost:8080
      CANOPY_MASTER_KEY: ${CANOPY_MASTER_KEY}
    depends_on:
      mongo: { condition: service_healthy }
volumes:
  mongo-data: {}
```

  Pin the exact MongoDB image version you have certified. The healthcheck initializes a single-node replica set
  on first boot.
- **Kubernetes** (Helm chart in Phase 5): Deployment, Service, Ingress with WebSocket annotations, HPA on CPU
  and on a connections metric, a PodDisruptionBudget, and `terminationGracePeriodSeconds` at least
  `drainWindow + 10s`.
- **Platform templates** (Fly.io, Railway, Render) come later. **Serverless functions** can host REST, but
  realtime ingestion needs a long-lived process. Use the edge mode for global fan-out.

## 4. Configuration reference

| Variable | Default | Purpose |
|---|---|---|
| `MONGODB_URI` | **required** | Connection string. The path supplies the app DB unless `CANOPY_DB` is set. |
| `CANOPY_DB` | from the URI | App database |
| `CANOPY_META_DB` / `CANOPY_AUTH_DB` | `canopy` / `canopy_auth` | Canopy's own databases |
| `CANOPY_MODE` | `platform` (`canopy`), `realtime` (`canopy-realtime`) | Which surfaces are enabled |
| `CANOPY_ENV` | `development` | `production` turns on stricter defaults |
| `CANOPY_PUBLIC_URL` | none | External base URL. Used for JWT `iss`/`aud`, OAuth redirects and CORS defaults. |
| `PORT` | `8080` | Public listener |
| `CANOPY_ADMIN_LISTEN` | (shares `PORT`) | For example `127.0.0.1:8081`, to serve `/admin` and `/studio` privately |
| `METRICS_PORT` | `9464` | Prometheus endpoint |
| `CANOPY_MASTER_KEY` | **required in production** | Key-encryption key for stored secrets |
| `CANOPY_POLICIES` | none | Directory of policy files (read-only mode) |
| `CANOPY_JWT_JWKS_URL`, `CANOPY_JWT_ISSUER`, `CANOPY_JWT_AUDIENCE`, `CANOPY_JWT_ALGORITHMS`, `CANOPY_JWT_ROLES_CLAIM` | none | External auth ([07 §6](07-auth.md#6-external-byo-identity-providers)) |
| `CANOPY_JWT_SECRET` | none | Legacy HS256 shared secret (warns at startup) |
| `CANOPY_CORS_ORIGINS` | `CANOPY_PUBLIC_URL` | Comma-separated allowlist |
| `CANOPY_REALTIME_FULL_DOCUMENT` | `auto` | `auto`, `updateLookup` or `images` ([03 §3.2](03-realtime-engine.md#32-getting-the-full-document-realtimefulldocument)) |
| `CANOPY_RESUME_WINDOW` | `120s` | How long a session survives a disconnect |
| `CANOPY_MUTATION_TTL` | `24h` | Lifetime of idempotency records |
| `CANOPY_LOG_LEVEL` | `info` | pino level |
| `OTEL_EXPORTER_OTLP_ENDPOINT` and other standard `OTEL_*` | none | Traces and metrics export |
| `CANOPY_TELEMETRY` | `off` | Opt-in anonymous usage telemetry |
| `CANOPY_DEV_INSECURE` | `off` | Development only. Relaxes CORS and key checks; refuses to start in production. |

## 5. Least-privilege MongoDB roles

```js
// Realtime sidecar: read-only on application data
db.getSiblingDB('admin').createRole({
  role: 'canopyRealtime',
  privileges: [
    { resource: { db: 'app', collection: '' }, actions: ['find', 'changeStream', 'listCollections', 'listIndexes'] },
    { resource: { db: 'canopy', collection: '' },
      actions: ['find', 'insert', 'update', 'remove', 'changeStream', 'createCollection', 'createIndex', 'listCollections'] },
  ],
  roles: [],
});

// Platform: also writes application data and owns the auth DB
db.getSiblingDB('admin').createRole({
  role: 'canopyPlatform',
  privileges: [
    { resource: { db: 'app', collection: '' },
      actions: ['find', 'insert', 'update', 'remove', 'changeStream', 'listCollections', 'listIndexes', 'collStats'] },
    { resource: { db: 'canopy', collection: '' },
      actions: ['find', 'insert', 'update', 'remove', 'changeStream', 'createCollection', 'createIndex', 'listCollections'] },
    { resource: { db: 'canopy_auth', collection: '' },
      actions: ['find', 'insert', 'update', 'remove', 'createCollection', 'createIndex', 'listCollections'] },
  ],
  roles: [],
});
```

- Admin-only operations (`collMod` to enable pre-/post-images, and creating indexes on app collections) use
  **separate credentials** through the CLI, never the server's account.
- Oplog-window checks need `find` on `local.oplog.rs`, which is optional. Without it, `canopy doctor` skips the
  check and says so.
- Atlas: create equivalent custom database roles in the Atlas UI or Admin API.

## 6. Observability

- **Metrics** (OpenTelemetry → Prometheus on `METRICS_PORT`):
  - HTTP: `canopy_http_requests_total{route,status}`, `canopy_http_request_duration_seconds`;
  - MongoDB: `canopy_mongo_command_duration_seconds{command}` (driver command monitoring), pool gauges;
  - realtime: the metrics in [03 §16](03-realtime-engine.md#16-metrics);
  - policy: `canopy_policy_compile_seconds`, `canopy_policy_denials_total`;
  - auth: `canopy_auth_signins_total{result}`;
  - process: event-loop lag, heap, GC.
- **Traces:** an HTTP request produces the spans auth → `policy.compile` → `mongo.<command>`. Realtime
  produces ingest → match → fan-out spans, sampled.
- **Logs:** pino JSON with `requestId`, `subject` (hashed by default) and redaction.
- **Shipped assets:** a Grafana dashboard (`deploy/grafana/canopy.json`) and Prometheus alert rules:

| Alert | Condition |
|---|---|
| `CanopyChangeStreamLagHigh` | `canopy_changestream_lag_seconds > 5` for 2 min |
| `CanopyResyncStorm` | rate of `canopy_realtime_resyncs_total` > 10× baseline |
| `CanopySlowConsumers` | rate of `canopy_realtime_slow_consumers_total` > 1/s for 5 min |
| `CanopyHighErrorRate` | 5xx > 1 % for 5 min |
| `CanopySnapshotBacklog` | `canopy_realtime_snapshot_queue_depth > 100` for 1 min |
| `CanopyEventLoopLag` | p99 event-loop lag > 200 ms for 5 min |
| `CanopyAuthFailuresSpike` | failed sign-ins > 5× baseline |

## 7. Performance targets and benchmarking

**Initial targets.** These assume a 2 vCPU / 4 GB node and a 3-node MongoDB 8.x replica set in the same region.
They are re-baselined after spikes S1, S3 and S5.

| Scenario | Target |
|---|---|
| Fan-out latency, event → frame written, p99 | ≤ 25 ms at 10k connections, 50k subscriptions, 1k events/s |
| End-to-end, write → another client's render, p99 | ≤ 150 ms |
| Optimistic write ack over WebSocket with echo, p99 | ≤ 120 ms |
| Memory per idle connection, including socket buffers | ≤ 32 KiB |
| Memory per simple subscription, excluding results | ≤ 4 KiB |
| REST overhead vs the raw driver, indexed `findOne`, p50 | ≤ 1.5 ms |
| REST simple-read throughput | ≥ 5k requests/s per vCPU |
| Cold start to ready, excluding the MongoDB connection | ≤ 2 s |
| SDK core size | ≤ 15 kB gzip |

**Benchmark suite (`bench/`).**

- **Scenarios:**
  - `todo-personal`: per-user policies, many users;
  - `dashboard-tenant`: tenant-wide subscriptions shared by many users;
  - `chat-rooms`: many small rooms, high fan-out;
  - `hot-doc`: one document with a high update rate;
  - `reconnect-storm`: 10k clients reconnecting at once;
  - `rest-crud`.
- **Tools:** k6 (HTTP and WebSocket), `bench/ws-loadgen` (a Node load generator that can spread 100k
  connections across machines), and a MongoDB write-load generator.
- **Method:** fixed seeds, warm-up, reports of p50/p95/p99/max with CPU and memory, runs on fixed cloud
  instance types. Results are stored and compared nightly. A regression above 10 % fails the nightly run and
  opens an issue. Results are published in the docs.

## 8. Scaling and capacity planning

| Size | Concurrent connections | Topology |
|---|---|---|
| Small | ≤ 2k | 1 node (2 for availability) |
| Medium | ≤ 30k | 2 to 4 independent nodes, sticky load balancing |
| Large | ≤ 300k | Hub mode: 2 ingestors with leader election, a NATS or Redis bus, N gateways |
| Global | any | Add Canopy Edge in front of medium or large deployments |

- **Rules of thumb, to be calibrated:** about 10 to 20k connections per 2 vCPU node. In independent mode every
  node processes every event, so the event-rate ceiling per node (target ≥ 5k events/s with selective
  predicate indexes) decides when to move to hub mode.
- **Load on MongoDB:** one change stream per node, snapshot reads (sent to secondaries where allowed), and
  transactional writes. Watch oplog read load and `wiredTiger` cache pressure.

## 9. High availability and failure behavior

| Failure | Behavior |
|---|---|
| Primary step-down or election | Retryable reads and writes; the change stream resumes automatically; lag spikes briefly; **no resync** |
| Canopy node crash | Its clients reconnect to other nodes and resync (sessions are node-local). The restarted node resumes ingest from its checkpoint. |
| Network loss between Canopy and MongoDB | `/readyz` fails, the load balancer drains the node, and clients reconnect elsewhere |
| Oplog rolled past the checkpoint | History lost: global jittered resync and an alert |
| JWKS endpoint down (external auth) | Cached keys keep working; tokens with an unknown `kid` fail until it is reachable again |
| Bus down (hub mode) | Gateways fall back to their own change stream (degraded independent mode) and raise an alert |
| Edge relay down | Edge sessions resync once the relay recovers; clients connected to the core are unaffected |

## 10. Upgrades and migrations

- **Semantic versioning.** Meta-DB migrations are tracked in `canopy.migrations`. They are idempotent and
  forward-only, and run at startup under a lease lock so only one node migrates.
- **Rolling upgrades** are supported within a minor version, and across one minor version from 1.0.
  Protocol v(N−1) stays supported ([04 §3](04-wire-protocol.md#3-versioning-and-negotiation)).
- Every release has upgrade notes. Downgrades are only possible by restoring a backup of the meta DB.

## 11. Backups and disaster recovery

- **App data:** use your existing MongoDB backups (Atlas backups, `mongodump`, Ops Manager).
- **The meta DB is critical**, because it holds policies, keys and audit. Back it up with the app DB.
  Policies are also kept in Git.
- **Losing signing keys** invalidates sessions. Users must sign in again, which is disruptive but recoverable.
- **`CANOPY_MASTER_KEY` must be backed up separately** (in a secrets manager). Without it, encrypted secrets
  cannot be recovered.
- **Targets for the reference setup:** meta DB recovery point equal to the app DB's; recovery time under
  15 minutes with infrastructure as code.
