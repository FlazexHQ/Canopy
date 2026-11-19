import { readFile } from "node:fs/promises"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import {
  Authenticator,
  addressAllowed,
  type JwtAuthOptions,
  parseJsonWebKeySet,
  RateLimits,
  resolveClientAddress,
} from "@canopy/auth"
import type { BuiltinAuth } from "@canopy/auth-builtin"
import {
  type CanopyConfigInput,
  type ConfigFunction,
  isResolvedConfig,
  type ResolvedConfig,
  type ResolvedStorageBackend,
  resolveConfig,
} from "@canopy/config"
import type { GraphqlHandler, PersistedOperations } from "@canopy/graphql"
import { selectEngine } from "@canopy/native"
import { toNodeListener as serveOnNode, tryPathname } from "@canopy/node-http"
import {
  ContextResolver,
  onceVariableIssue,
  type PolicyEngine,
  type PolicySet,
} from "@canopy/policy"
import {
  CloseCode,
  DiagnosticError,
  deploymentDiagnostic,
  diagnoseMongoError,
  ForbiddenError,
  formatDiagnostic,
  mongoTarget,
} from "@canopy/protocol"
import {
  type Attachment,
  attach,
  type BunServerLike,
  bunHandlers,
  Counter,
  createHttpTransport,
  createRealtime,
  databasePolicies,
  directoryPolicies,
  type HttpTransport,
  type Logger,
  type PolicySource,
  type Realtime,
  readinessCheck,
  silentLogger,
  staticPolicies,
  toNodeHandler,
} from "@canopy/realtime"
import {
  createRestHandler,
  mongoContextReader,
  type RestHandler,
  SchemaCache,
  toNodeListener,
  type WriteEvent,
  WritePath,
} from "@canopy/rest"
import {
  createStorageHandler,
  ImageRenderer,
  localBackend,
  r2Backend,
  Storage,
  type StorageBackend,
  type StorageHandler,
  s3Backend,
  UrlSigner,
} from "@canopy/storage"
import { createStudioHandler } from "@canopy/studio"
import { MongoClient } from "mongodb"
import { AdminAccounts } from "./admin/accounts.ts"
import { type AdminApi, createAdminApi } from "./admin/api.ts"
import { EmailTemplateStore } from "./admin/email-templates.ts"
import { problem, STUDIO_CSP, secure } from "./admin/http.ts"
import { LagSampler } from "./admin/lag.ts"
import { SecretBox } from "./admin/secrets.ts"
import { DEFAULT_SETTINGS, SettingsStore } from "./admin/settings.ts"
import { AdminTokens } from "./admin/tokens.ts"
import { ApiKeys } from "./api-keys.ts"
import { AuditLog } from "./audit.ts"
import { revokes, startBuiltinAuth } from "./builtin-auth.ts"
import { migrateMeta } from "./migrations.ts"
import { PolicyStore } from "./policy-store.ts"
import { RequestLog, surfaceOf } from "./request-log.ts"
import { loadTracing, type Tracing } from "./tracing.ts"
import { ViewTokens } from "./view-tokens.ts"
import { compileTriggers } from "./webhooks/triggers.ts"
import { startWebhooks, type Webhooks } from "./webhooks/webhooks.ts"

/** How often each node rereads the runtime settings (the admin allowlist, request log sampling). */
const SETTINGS_REFRESH_MS = 10_000

/** Options of {@link createCanopy}. */
export interface CreateCanopyOptions {
  /** An existing client, to share the application's pool. It is not closed by `close()`. */
  readonly mongo?: MongoClient
  /** For config input (not a resolved config): the variables. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** For config input: the directory relative paths resolve against. Defaults to the process directory. */
  readonly baseDir?: string
  /** Policies given in code instead of the configured source, for tests and embedding. */
  readonly policies?: PolicySet
  readonly logger?: Logger
  /** Bring the meta database up to date on start. @default true */
  readonly migrate?: boolean
  /** Serve the admin API under `/admin/v1`. @default true */
  readonly admin?: boolean
  /**
   * Serves Studio under `/studio`, on the same listener as the admin API (only the private admin listener
   * when `server.adminListen` is set). Defaults to the built Studio of `@canopy/studio` while the admin API
   * is on; `false` turns it off.
   */
  readonly studio?: FetchHandler | false
  /**
   * Receives the one time setup token of an unclaimed server. Defaults to a warning in the log (or on
   * standard error when no logger is given). `false` keeps it quiet, for tests and embedders that claim
   * the server themselves or never use the admin API; the token can still be read with
   * `admin.accounts.createSetupToken()`.
   */
  readonly onSetupToken?: ((token: string) => void) | false
}

/** The admin surface: `/admin/v1` and `/studio`. */
export interface AdminSurface {
  readonly api: AdminApi | undefined
  readonly accounts: AdminAccounts
  /** Long lived admin API tokens for CI, in `canopy.admin_tokens`. */
  readonly tokens: AdminTokens
  readonly policies: PolicyStore
  readonly audit: AuditLog
  /** Runtime settings; `refresh()` rereads them at once instead of at the next periodic refresh. */
  readonly settings: SettingsStore
  /** Sampled request logs, served by `GET /admin/v1/logs`. */
  readonly requestLog: RequestLog
  /** Change stream lag samples, when realtime is on. */
  readonly lag: LagSampler | undefined
  /**
   * Serves `/admin` and `/studio`; anything else is `404`. `info.ip` is the peer address; when it is one of
   * `server.trustedProxies`, the client address comes from `X-Forwarded-For`. The client address is checked
   * against the `adminAllowlist` setting.
   */
  fetch(request: Request, info?: { readonly ip?: string }): Promise<Response>
  /** The same as a `node:http` listener. */
  node(): (request: IncomingMessage, response: ServerResponse) => void
  /**
   * Starts the private admin listener on `server.adminListen` (`CANOPY_ADMIN_LISTEN`). Returns `undefined`
   * when none is configured, in which case the public listener serves the admin surface.
   */
  listen(): Promise<{ readonly address: string; close(): Promise<void> } | undefined>
}

/** A request handler in the Web standard `fetch` shape. */
export type FetchHandler = (request: Request) => Response | Promise<Response>

/** A running Canopy: REST, realtime and health on one set of resources. */
export interface Canopy extends AsyncDisposable {
  readonly config: ResolvedConfig
  /** The REST handler, when the Data API is on. */
  readonly rest: RestHandler | undefined
  /** The GraphQL handler at `/graphql/v1`, when GraphQL is on. */
  readonly graphql: GraphqlHandler | undefined
  /** The realtime engine, when realtime is on. */
  readonly realtime: Realtime | undefined
  /** Renders the metrics of the data plane and of realtime in the Prometheus text format. */
  renderMetrics(): string
  /** Built in auth, when the config chooses `builtin()`; it serves `/auth/v1`. */
  readonly auth: BuiltinAuth | undefined
  /** The policies in force (hot reloaded). */
  readonly policies: PolicyEngine
  /** The API keys stored in the meta database. Keys from the config work next to them. */
  readonly keys: ApiKeys
  /** The admin API, Studio and the stores behind them. */
  readonly admin: AdminSurface
  /** Database triggers and schedules, when the config has any. */
  readonly webhooks: Webhooks | undefined
  /** File storage at `/storage/v1`, when the config has buckets. */
  readonly storage: Storage | undefined
  /**
   * Serves REST, the SSE and long-poll transports, `/healthz` and `/readyz`; anything else goes to
   * `fallback` (404 without one). WebSockets need {@link attach} (Node) or {@link bun}.
   */
  fetch(
    request: Request,
    fallback?: FetchHandler,
    /** `ip` is the peer address, used for auth rate limits; forwarded headers count only from trusted proxies. */
    info?: { readonly ip?: string },
  ): Promise<Response>
  /** A `node:http` and Express style listener with the same routes, streaming SSE responses. */
  node(options?: {
    readonly fallback?: (request: IncomingMessage, response: ServerResponse) => void
  }): (request: IncomingMessage, response: ServerResponse) => void
  /**
   * Accepts WebSocket upgrades of a Node server: `/realtime/v1`, and graphql-ws on `/graphql/v1` when
   * GraphQL has subscriptions.
   */
  attach(server: Server): Promise<void>
  /** `fetch` and `websocket` for `Bun.serve`, WebSockets included. */
  bun(options?: { readonly fallback?: FetchHandler }): {
    fetch(request: Request, server: BunServerLike<never>): Response | Promise<Response> | undefined
    /** Absent when realtime is off. */
    websocket?: ReturnType<typeof bunHandlers>["websocket"]
  }
  /** Drains realtime, closes the transports and the client it created, in that order. */
  close(options?: { readonly drainMs?: number }): Promise<void>
}

function jwtOptions(config: ResolvedConfig): JwtAuthOptions | undefined {
  const auth = config.auth
  if (auth === undefined) return undefined
  if (auth.kind === "builtin") return undefined
  return {
    issuer: auth.issuer,
    audience: auth.audience,
    ...(auth.jwksUrl === undefined ? {} : { jwksUrl: auth.jwksUrl }),
    ...(auth.jwks === undefined ? {} : { jwks: parseJsonWebKeySet(auth.jwks) }),
    ...(auth.algorithms === undefined ? {} : { algorithms: auth.algorithms }),
    ...(auth.rolesClaim === undefined ? {} : { rolesClaim: auth.rolesClaim }),
    ...(auth.allowServiceRoleFromJwt === true ? { allowServiceRoleFromJwt: true } : {}),
    ...(auth.clockToleranceSeconds === undefined
      ? {}
      : { clockToleranceSeconds: auth.clockToleranceSeconds }),
  }
}

function plain(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } })
}

function resolveInput(
  input: ResolvedConfig | CanopyConfigInput | ConfigFunction,
  options: CreateCanopyOptions,
): ResolvedConfig {
  if (isResolvedConfig(input)) return input
  return resolveConfig(
    typeof input === "function"
      ? input({
          mode: options.env?.["CANOPY_ENV"] === "production" ? "production" : "development",
          command: "start",
        })
      : input,
    {
      env: options.env ?? process.env,
      baseDir: options.baseDir ?? process.cwd(),
      cwd: process.cwd(),
      command: "start",
    },
  ).config
}

/** Writes a message to the logger, or to standard error when the embedder gave none. */
function reporter(options: CreateCanopyOptions, logger: Logger, level: "error" | "warn") {
  return (message: string): void => {
    if (options.logger === undefined) process.stderr.write(`${message}\n`)
    else logger[level]({}, message)
  }
}

/** Connects to MongoDB and brings the meta database up to date. */
async function connect(
  config: ResolvedConfig,
  options: CreateCanopyOptions,
  logger: Logger,
  tracing: Tracing | undefined,
) {
  const ownsMongo = options.mongo === undefined
  const mongo =
    options.mongo ??
    new MongoClient(config.mongodb.uri, {
      appName: "canopy",
      ...(tracing === undefined ? {} : { monitorCommands: true }),
    })
  tracing?.instrument(mongo)
  const report = reporter(options, logger, "error")
  /** Runs a startup step, turning a MongoDB failure into a diagnostic and closing a client of our own. */
  const diagnosed = async <T>(step: () => Promise<T>): Promise<T> => {
    try {
      return await step()
    } catch (error: unknown) {
      const diagnostic = diagnoseMongoError(
        error,
        mongoTarget(config.mongodb.uri, config.mongodb.database),
      )
      if (diagnostic === undefined) throw error
      report(formatDiagnostic(diagnostic))
      if (ownsMongo) await mongo.close().catch(() => {})
      throw new DiagnosticError(diagnostic, { cause: error })
    }
  }
  await diagnosed(() => mongo.connect())
  const admin = mongo.db("admin")
  const [hello, build] = await diagnosed(() =>
    Promise.all([admin.command({ hello: 1 }), admin.command({ buildInfo: 1 })]),
  )
  const unsupported = deploymentDiagnostic(
    hello,
    String(build["version"] ?? "0"),
    mongoTarget(config.mongodb.uri, config.mongodb.database),
  )
  if (unsupported !== undefined) {
    report(formatDiagnostic(unsupported))
    if (ownsMongo) await mongo.close().catch(() => {})
    throw new DiagnosticError(unsupported)
  }
  const meta = mongo.db(config.mongodb.metaDatabase)
  if (options.migrate !== false) await diagnosed(() => migrateMeta(meta, { logger }))
  return {
    mongo,
    db: mongo.db(config.mongodb.database),
    meta,
    diagnosed,
    async close(): Promise<void> {
      if (ownsMongo) await mongo.close()
    },
  }
}

type Connection = Awaited<ReturnType<typeof connect>>

/** Records a committed data plane write in the audit log, without its documents. */
function auditWrite(audit: AuditLog, logger: Logger): (event: WriteEvent) => void {
  return (event) => {
    audit
      .record({
        action: `data.${event.op}`,
        actor: { type: "user", id: event.subject },
        target: { collection: event.collection, ids: event.ids },
        details: {
          roles: event.roles,
          ct: event.ct,
          ...(event.mutationId === undefined ? {} : { mutationId: event.mutationId }),
        },
      })
      .catch((error: unknown) => logger.error({ err: error }, "could not audit a write"))
  }
}

/** The audit log, the request log and the runtime settings, reread every few seconds. */
async function buildStores(connection: Connection, logger: Logger) {
  const { meta } = connection
  const audit = new AuditLog(meta)
  const requestLog = new RequestLog(meta, {
    logger,
    settings: { sampleRate: 0, retentionDays: DEFAULT_SETTINGS.requestLogRetentionDays },
  })
  const settings = new SettingsStore(meta, audit, { requestLog })
  await connection.diagnosed(() => settings.refresh())
  const timer = setInterval(() => {
    settings.refresh().then(
      () => {},
      (error: unknown) => logger.warn({ err: error }, "could not refresh the settings"),
    )
  }, SETTINGS_REFRESH_MS)
  timer.unref?.()

  const logResponse = (
    request: Request,
    response: Response,
    started: number,
    ip: string | undefined,
  ): Response => {
    const path = new URL(request.url).pathname
    const surface = surfaceOf(path)
    if (surface === undefined) return response
    const requestId = response.headers.get("x-request-id")
    requestLog.record({
      surface,
      method: request.method,
      path,
      status: response.status,
      durationMs: performance.now() - started,
      ...(ip === undefined ? {} : { ip }),
      ...(requestId === null ? {} : { requestId }),
    })
    return response
  }
  /** Records a `node:http` request in the request log once its response is written. */
  const logNode = (request: IncomingMessage, response: ServerResponse): void => {
    const path = tryPathname(request)
    if (path === undefined) return
    const surface = surfaceOf(path)
    if (surface === undefined) return
    const started = performance.now()
    response.once("finish", () => {
      const ip = request.socket.remoteAddress
      const requestId = response.getHeader("x-request-id")
      requestLog.record({
        surface,
        method: request.method ?? "GET",
        path,
        status: response.statusCode,
        durationMs: performance.now() - started,
        ...(ip === undefined ? {} : { ip }),
        ...(typeof requestId === "string" ? { requestId } : {}),
      })
    })
  }

  return {
    audit,
    requestLog,
    settings,
    logResponse,
    logNode,
    stop(): void {
      clearInterval(timer)
    },
  }
}

type Stores = Awaited<ReturnType<typeof buildStores>>

/** Built in auth (when configured), the API keys and the authenticator every entry point shares. */
async function buildAuth(
  config: ResolvedConfig,
  connection: Connection,
  stores: Stores,
  logger: Logger,
) {
  const { mongo, meta } = connection
  const emailTemplates =
    config.auth?.kind === "builtin"
      ? new EmailTemplateStore({ meta, audit: stores.audit })
      : undefined
  await emailTemplates?.load()
  const builtin =
    config.auth?.kind === "builtin"
      ? await startBuiltinAuth(config, config.auth, mongo, logger, emailTemplates)
      : undefined
  const apiKeys = new ApiKeys(meta, { logger })
  const viewTokens = new ViewTokens(config.masterKey)
  const authenticator = new Authenticator(
    builtin?.verification ?? jwtOptions(config),
    { publishable: config.keys.publishable, secret: config.keys.secret },
    { store: apiKeys, viewTokens: viewTokens.verification },
  )
  return {
    builtin,
    emailTemplates,
    apiKeys,
    viewTokens,
    authenticator,
    async close(): Promise<void> {
      await apiKeys.close()
      await builtin?.close()
    },
  }
}

type Auth = Awaited<ReturnType<typeof buildAuth>>

/** The proxies whose `X-Forwarded-For` is trusted, for the admin allowlist, built in auth and the rate limits. */
function trustedProxiesOf(config: ResolvedConfig): string[] {
  return [
    ...config.server.trustedProxies,
    ...(config.auth?.kind === "builtin" ? config.auth.trustedProxies : []),
  ]
}

/**
 * The policy source with hot reload, the context lookup resolver, REST and the realtime engine. With
 * realtime on, its engine holds the policies; otherwise a standalone engine follows the source.
 */
async function buildData(
  config: ResolvedConfig,
  connection: Connection,
  auth: Auth,
  stores: Stores,
  options: CreateCanopyOptions,
  logger: Logger,
  tracing: Tracing | undefined,
) {
  const { mongo, db } = connection
  const development = config.environment === "development"
  const variableHooks = development
    ? {
        onVariableIssue: onceVariableIssue((message, issue) =>
          logger.warn(
            {
              collection: issue.collection,
              policy: issue.policy,
              variable: issue.variable,
              kind: issue.kind,
            },
            message,
          ),
        ),
      }
    : {}
  const contexts = new ContextResolver({ reader: mongoContextReader(db) })
  const schemas = new SchemaCache(db)
  const limits = config.rateLimits
  const rateLimits =
    limits === false
      ? undefined
      : new RateLimits({
          requests: limits.requests,
          messages: limits.messages,
          anonymousConnectionsPerAddress: limits.anonymousConnectionsPerAddress,
          failedAuthentications: limits.failedAuthentications,
          exemptService: limits.exemptService,
          trustedProxies: trustedProxiesOf(config),
        })
  const httpRateLimited = new Counter(
    "canopy_http_rate_limited_total",
    "REST and GraphQL requests refused by the rate limits",
  )
  const source: PolicySource =
    options.policies !== undefined
      ? staticPolicies(options.policies)
      : "dir" in config.policies
        ? directoryPolicies(config.policies.dir)
        : databasePolicies(mongo, config.mongodb.metaDatabase)
  const watch = options.policies === undefined && config.policies.watch

  let realtime: Realtime | undefined
  let standalone: PolicyEngine | undefined
  let stopWatching: (() => void) | undefined
  const engine = (): PolicyEngine => {
    if (realtime !== undefined) return realtime.policies
    if (standalone === undefined) throw new TypeError("Canopy has no policies loaded")
    return standalone
  }

  const restConfig = config.rest
  const rest =
    restConfig === false
      ? undefined
      : createRestHandler({
          client: mongo,
          database: config.mongodb.database,
          metaDatabase: config.mongodb.metaDatabase,
          policies: engine,
          authenticator: auth.authenticator,
          contexts,
          schemas,
          readLimits: { defaultLimit: restConfig.defaultLimit, maxLimit: restConfig.maxLimit },
          search: Object.entries(config.collections)
            .filter(([, collection]) => collection.search === true)
            .map(([name]) => name),
          maxBodyBytes: restConfig.maxBodyBytes,
          mutationTtlSeconds: Math.round(restConfig.mutationTtlMs / 1000),
          idTypes: Object.fromEntries(
            Object.entries(config.collections)
              .filter(([, collection]) => collection.idType !== "auto")
              .map(([name, collection]) => [name, collection.idType]),
          ),
          ...(config.cors === undefined ? {} : { cors: config.cors }),
          ...(rateLimits === undefined
            ? {}
            : { rateLimits, onRateLimited: () => httpRateLimited.inc({ surface: "rest" }) }),
          onError: (error) => logger.error({ err: error }, "REST request failed"),
          ...(config.audit.dataWrites ? { onWrite: auditWrite(stores.audit, logger) } : {}),
          ...(development ? { explainDenials: true } : {}),
        })

  const realtimeConfig = config.realtime
  if (realtimeConfig !== false) {
    realtime = await connection.diagnosed(() =>
      createRealtime({
        mongo,
        database: config.mongodb.database,
        metaDatabase: config.mongodb.metaDatabase,
        authenticator: auth.authenticator,
        policies: watch ? source : { load: () => source.load() },
        fullDocument: realtimeConfig.fullDocument,
        checkpoints: realtimeConfig.checkpoints,
        resumeWindowMs: realtimeConfig.resumeWindowMs,
        echoTimeoutMs: realtimeConfig.echoTimeoutMs,
        nodeId: config.server.nodeId,
        engine: config.server.engine,
        contexts,
        logger,
        traceCapacity: 256,
        ...(tracing === undefined ? {} : { span: tracing.span }),
        logVariableIssues: development,
        ...(rateLimits === undefined ? {} : { rateLimits }),
        ...(rest === undefined ? {} : { mutations: rest.writes }),
      }),
    )
  } else {
    const core = selectEngine(config.server.engine)
    const load = (set: PolicySet): PolicyEngine =>
      tracing === undefined
        ? core.createPolicyEngine(set, variableHooks)
        : tracing.span("canopy.policy.load", { version: set.version }, () =>
            core.createPolicyEngine(set, variableHooks),
          )
    let current = load(await source.load())
    standalone = current
    if (watch && source.watch !== undefined) {
      stopWatching = source.watch(
        (set) => {
          current = load(set)
          standalone = current
        },
        (error) =>
          logger.error({ err: error }, "policy reload rejected, keeping the previous policies"),
      )
    }
  }
  const engineRealtime = realtime
  const storage = await buildStorage(config, connection, auth, engine, contexts, rateLimits, logger)
  const graphql =
    rest === undefined || config.graphql === false
      ? undefined
      : (await import("@canopy/graphql")).createGraphqlHandler({
          reads: rest.reads,
          writes: rest.writes,
          policies: engine,
          authenticator: auth.authenticator,
          contexts,
          schemas,
          ...(engineRealtime === undefined ? {} : { realtime: engineRealtime }),
          collections: config.collections,
          limits: {
            maxDepth: config.graphql.maxDepth,
            maxComplexity: config.graphql.maxComplexity,
            maxAliases: config.graphql.maxAliases,
          },
          maxBatch: config.graphql.maxBatch,
          ...(config.rest === false ? {} : { maxBodyBytes: config.rest.maxBodyBytes }),
          introspection: config.graphql.introspection,
          ...(config.graphql.persisted === undefined
            ? {}
            : { persisted: await persistedOperations(config.graphql.persisted) }),
          ...(config.cors === undefined ? {} : { cors: config.cors }),
          ...(rateLimits === undefined
            ? {}
            : { rateLimits, onRateLimited: () => httpRateLimited.inc({ surface: "graphql" }) }),
          onError: (error) => logger.error({ err: error }, "GraphQL request failed"),
        })

  return {
    contexts,
    rest,
    graphql,
    storage,
    realtime: engineRealtime,
    engine,
    /** The data plane limits, when they are on. */
    rateLimits,
    httpRateLimited,
    /** Stops following the policy source of a standalone engine. */
    stopReloading(): void {
      stopWatching?.()
    },
    /** Drains the realtime connections, by default for the configured drain window. */
    async drain(drainMs: number | undefined): Promise<void> {
      await engineRealtime?.close({
        drainMs: drainMs ?? (realtimeConfig === false ? 0 : realtimeConfig.drainWindowMs),
      })
    },
    close(): void {
      storage?.stop()
      graphql?.close()
      contexts.close()
    },
  }
}

/** How often unfinished resumable uploads past their expiry are dropped. */
const STORAGE_SWEEP_MS = 3_600_000

/** The backend the storage section names: local disk, Cloudflare R2 or AWS S3. */
function storageBackend(backend: ResolvedStorageBackend): Promise<StorageBackend> | StorageBackend {
  switch (backend.kind) {
    case "local":
      return localBackend({ root: backend.root })
    case "r2":
      return r2Backend({
        accountId: backend.accountId,
        bucket: backend.bucket,
        accessKeyId: backend.accessKeyId,
        secretAccessKey: backend.secretAccessKey,
        ...(backend.jurisdiction === undefined ? {} : { jurisdiction: backend.jurisdiction }),
        prefix: backend.prefix,
      })
    case "s3":
      return s3Backend({
        ...(backend.endpoint === undefined ? {} : { endpoint: backend.endpoint }),
        region: backend.region,
        bucket: backend.bucket,
        accessKeyId: backend.accessKeyId,
        secretAccessKey: backend.secretAccessKey,
        ...(backend.sessionToken === undefined ? {} : { sessionToken: backend.sessionToken }),
        forcePathStyle: backend.forcePathStyle,
        prefix: backend.prefix,
      })
  }
}

/** File storage at `/storage/v1` when the config has buckets, and the hourly sweep of abandoned uploads. */
async function buildStorage(
  config: ResolvedConfig,
  connection: Connection,
  auth: Auth,
  engine: () => PolicyEngine,
  contexts: ContextResolver,
  rateLimits: RateLimits | undefined,
  logger: Logger,
): Promise<
  { readonly storage: Storage; readonly handler: StorageHandler; stop(): void } | undefined
> {
  const settings = config.storage
  if (settings === false) return undefined
  const backend = await storageBackend(settings.backend)
  const storage = new Storage({
    client: connection.mongo,
    metaDatabase: config.mongodb.metaDatabase,
    policies: engine,
    backend,
    buckets: settings.buckets,
    signer: new UrlSigner(config.masterKey),
    maxUploadSize: settings.maxUploadSize,
    ...(settings.images.enabled
      ? {
          images: new ImageRenderer({
            maxDimension: settings.images.maxDimension,
            maxSourceSize: settings.images.maxSourceSize,
          }),
        }
      : {}),
  })
  const handler = createStorageHandler({
    storage,
    authenticator: auth.authenticator,
    policies: engine,
    contexts,
    ...(config.cors === undefined ? {} : { cors: config.cors }),
    ...(rateLimits === undefined ? {} : { rateLimits }),
    onError: (error) => logger.error({ err: error }, "storage request failed"),
  })
  const timer = setInterval(() => {
    storage.sweep().then(
      (dropped) => {
        if (dropped > 0) logger.info({ uploads: dropped }, "dropped expired resumable uploads")
      },
      (error: unknown) => logger.warn({ err: error }, "could not sweep expired uploads"),
    )
  }, STORAGE_SWEEP_MS)
  timer.unref?.()
  return { storage, handler, stop: () => clearInterval(timer) }
}

/** Reads a persisted operations file: a JSON object mapping the hex SHA-256 of each document to it. */
async function persistedOperations(input: {
  readonly file: string
  readonly only: boolean
}): Promise<PersistedOperations> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(input.file, "utf8"))
  } catch (error: unknown) {
    throw new TypeError(`The persisted operations file ${input.file} cannot be read as JSON`, {
      cause: error,
    })
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new TypeError(`The persisted operations file ${input.file} must hold an object`)
  const operations: Record<string, string> = {}
  for (const [hash, document] of Object.entries(parsed)) {
    if (!/^[0-9a-f]{64}$/.test(hash) || typeof document !== "string")
      throw new TypeError(
        `The persisted operations file ${input.file} must map SHA-256 hex hashes to documents`,
      )
    operations[hash] = document
  }
  return { operations, only: input.only }
}

type Data = Awaited<ReturnType<typeof buildData>>

/** Closes the realtime connections of revoked API keys and of revoked built in auth sessions. */
function closeRevokedConnections(auth: Auth, realtime: Realtime | undefined, logger: Logger): void {
  const revoked = (ids: ReadonlySet<string>): void => {
    const closed = realtime?.closeConnections(
      (principal) => principal.keyId !== undefined && ids.has(principal.keyId),
      CloseCode.Forbidden,
      "The API key was revoked",
    )
    if (closed !== undefined && closed > 0)
      logger.info({ keys: [...ids], connections: closed }, "closed connections of revoked keys")
  }
  auth.apiKeys.watch(
    (id) => revoked(new Set([id])),
    () => {
      const used = (realtime?.connections() ?? []).flatMap((c) =>
        c.keyId === undefined ? [] : [c.keyId],
      )
      auth.apiKeys
        .inactive(used)
        .then(revoked, (error: unknown) =>
          logger.error({ err: error }, "could not recheck API keys"),
        )
    },
  )

  auth.builtin?.onRevocation((revocation) => {
    const closed = realtime?.closeConnections(
      (principal) => revokes(revocation, principal),
      CloseCode.Unauthorized,
      "The session was revoked",
    )
    if (closed !== undefined && closed > 0)
      logger.info(
        { sub: revocation.sub, connections: closed },
        "closed connections of a revoked session",
      )
  })
}

/** The SSE and long-poll transport and the WebSocket attachments of the realtime engine. */
function buildTransports(config: ResolvedConfig, realtime: Realtime | undefined) {
  const realtimeConfig = config.realtime
  const transports =
    realtimeConfig === false ? new Set<string>() : new Set(realtimeConfig.transports)
  const http: HttpTransport | undefined =
    realtime !== undefined && (transports.has("sse") || transports.has("long-poll"))
      ? createHttpTransport(realtime, {
          nodeId: config.server.nodeId,
          ...(config.cors === undefined ? {} : { cors: { origins: config.cors.origins } }),
        })
      : undefined
  const attachments: Attachment[] = []
  return {
    http,
    websocket: realtime !== undefined && transports.has("websocket"),
    attachments,
    async close(): Promise<void> {
      http?.close()
      for (const attachment of attachments.splice(0)) await attachment.close()
    },
  }
}

function isAdmin(path: string): boolean {
  return (
    path === "/admin" ||
    path.startsWith("/admin/") ||
    path === "/studio" ||
    path.startsWith("/studio/")
  )
}

/** The admin API, Studio and the stores behind them, with the optional private admin listener. */
async function buildAdmin(
  config: ResolvedConfig,
  connection: Connection,
  stores: Stores,
  auth: Auth,
  data: Data,
  webhooks: Webhooks | undefined,
  options: CreateCanopyOptions,
  logger: Logger,
) {
  const { mongo, db, meta } = connection
  const { audit, settings, requestLog } = stores
  const { realtime, engine } = data
  const policyStore = new PolicyStore({
    client: mongo,
    metaDatabase: config.mongodb.metaDatabase,
    audit,
    writable: options.policies === undefined && "source" in config.policies,
    lintEnvironment: async (collection) => {
      try {
        const indexes = await db.collection(collection).indexes()
        return { indexes: { [collection]: indexes.map((index) => Object.keys(index.key)) } }
      } catch {
        return {}
      }
    },
  })
  const accounts = new AdminAccounts({
    client: mongo,
    meta,
    audit,
    secrets: new SecretBox(config.masterKey, config.previousMasterKeys),
    environment: config.environment,
  })
  const adminTokens = new AdminTokens({ meta, accounts, audit })
  const lag =
    realtime === undefined || options.admin === false ? undefined : new LagSampler(realtime.metrics)
  const { builtin, emailTemplates } = auth
  const adminApi =
    options.admin === false
      ? undefined
      : createAdminApi({
          config,
          client: mongo,
          accounts,
          tokens: adminTokens,
          audit,
          policies: policyStore,
          keys: auth.apiKeys,
          settings,
          requestLog,
          engine,
          contexts: data.contexts,
          writes:
            data.rest?.writes ??
            new WritePath({
              client: mongo,
              database: config.mongodb.database,
              metaDatabase: config.mongodb.metaDatabase,
              policies: engine,
            }),
          realtime,
          ...(data.graphql === undefined ? {} : { graphql: data.graphql }),
          viewTokens: auth.viewTokens,
          ...(webhooks === undefined ? {} : { webhooks }),
          ...(lag === undefined ? {} : { lag }),
          logger,
          ...(builtin === undefined ? {} : { auth: builtin }),
          ...(builtin === undefined || emailTemplates === undefined
            ? {}
            : {
                emailTemplates: {
                  store: emailTemplates,
                  appName: config.auth?.kind === "builtin" ? config.auth.appName : "Canopy",
                },
              }),
        })
  if (adminApi !== undefined && options.onSetupToken !== false) {
    const token = await accounts.createSetupToken()
    if (token !== undefined) {
      const announce =
        options.onSetupToken ??
        ((value: string) =>
          reporter(
            options,
            logger,
            "warn",
          )(
            `This server has no owner yet. Claim it in Studio or with POST /admin/v1/setup using the one time setup token ${value}`,
          ))
      announce(token)
    }
  }
  const studio =
    options.studio === false
      ? undefined
      : (options.studio ?? (adminApi === undefined ? undefined : createStudioHandler().fetch))
  const trustedProxies = trustedProxiesOf(config)
  const adminFetch = async (
    request: Request,
    peer: { readonly ip?: string } = {},
  ): Promise<Response> => {
    const path = new URL(request.url).pathname
    const info =
      peer.ip === undefined
        ? {}
        : { ip: resolveClientAddress(request.headers, peer.ip, trustedProxies) }
    if (!addressAllowed(info.ip, settings.current.adminAllowlist))
      return secure(
        problem(
          new ForbiddenError("This address may not use the admin surface"),
          path,
          request.headers.get("x-request-id")?.slice(0, 128) ?? "",
        ),
      )
    if (adminApi !== undefined && (path === "/admin/v1" || path.startsWith("/admin/v1/")))
      return adminApi.fetch(request, info)
    if (studio !== undefined && (path === "/studio" || path.startsWith("/studio/")))
      return secure(await studio(request), STUDIO_CSP)
    return secure(plain(404, "Not found"))
  }
  const servers: Server[] = []
  const surface: AdminSurface = {
    api: adminApi,
    accounts,
    tokens: adminTokens,
    policies: policyStore,
    audit,
    settings,
    requestLog,
    lag,
    fetch: adminFetch,
    node: () => serveOnNode(adminFetch),
    async listen() {
      const listen = config.server.adminListen
      if (listen === undefined) return undefined
      const { createServer } = await import("node:http")
      const separator = listen.lastIndexOf(":")
      const host = separator < 0 ? "127.0.0.1" : listen.slice(0, separator).replace(/^\[|\]$/g, "")
      const port = Number(separator < 0 ? listen : listen.slice(separator + 1))
      const bridge = serveOnNode(adminFetch)
      const server = createServer((request, response) => {
        stores.logNode(request, response)
        const hostHeader = (request.headers.host ?? "").toLowerCase()
        const name = hostHeader.replace(/:\d+$/, "").replace(/^\[|\]$/g, "")
        const allowed = new Set([host.toLowerCase(), "localhost", "127.0.0.1", "::1"])
        if (config.publicUrl !== undefined) allowed.add(new URL(config.publicUrl).hostname)
        if (!allowed.has(name)) {
          response.statusCode = 421
          response.end("Misdirected request")
          return
        }
        bridge(request, response)
      })
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(port, host, () => resolve())
      })
      const address = server.address()
      const bound =
        typeof address === "object" && address !== null
          ? `${address.address}:${address.port}`
          : listen
      servers.push(server)
      return {
        address: bound,
        close: () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections()
            server.close(() => resolve())
          }),
      }
    },
  }
  return {
    surface,
    fetch: adminFetch,
    /** Whether the admin surface is served only on the private admin listener. */
    private: config.server.adminListen !== undefined,
    async close(): Promise<void> {
      lag?.stop()
      for (const server of servers.splice(0)) {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    },
  }
}

/**
 * Builds Canopy from a config: one MongoDB client, one authenticator, one policy source with hot reload
 * shared by REST and realtime, one context lookup resolver whose live invalidations reach both, and the
 * REST write path as realtime's mutation executor, so both entry points share idempotency records.
 *
 * Takes a resolved config (`loadConfig`) or the default export of a config file, which is resolved
 * against `options.env`.
 */
export async function createCanopy(
  input: ResolvedConfig | CanopyConfigInput | ConfigFunction,
  options: CreateCanopyOptions = {},
): Promise<Canopy> {
  const config = resolveInput(input, options)
  compileTriggers(config.webhooks.triggers)
  const logger = options.logger ?? silentLogger
  const tracing = config.telemetry.tracing ? await loadTracing() : undefined
  const connection = await connect(config, options, logger, tracing)
  const stores = await buildStores(connection, logger)
  const auth = await buildAuth(config, connection, stores, logger)
  const data = await buildData(config, connection, auth, stores, options, logger, tracing)
  closeRevokedConnections(auth, data.realtime, logger)
  const webhooks = await connection.diagnosed(() =>
    startWebhooks({ config, client: connection.mongo, logger }),
  )
  const admin = await buildAdmin(config, connection, stores, auth, data, webhooks, options, logger)
  const transports = buildTransports(config, data.realtime)
  const { rest, realtime, graphql } = data
  const { http } = transports
  const { builtin } = auth
  const { logResponse, logNode } = stores
  let closing = false
  const readiness = readinessCheck({
    mongo: connection.mongo,
    ...(realtime === undefined && webhooks === undefined
      ? {}
      : {
          changeStream: () => (realtime?.changeStreamOpen ?? true) && (webhooks?.streaming ?? true),
        }),
  })

  const health = (path: string): Promise<Response> | undefined => {
    if (path === "/healthz") return Promise.resolve(plain(200, "ok"))
    if (path !== "/readyz") return undefined
    if (closing) return Promise.resolve(plain(503, "draining"))
    return readiness().then((state) =>
      state.ready ? plain(200, "ready") : plain(503, `not ready: ${state.reason ?? "unknown"}`),
    )
  }
  const isRest = (path: string): boolean => path === "/rest/v1" || path.startsWith("/rest/v1/")
  const isStorage = (path: string): boolean =>
    data.storage !== undefined && (path === "/storage/v1" || path.startsWith("/storage/v1/"))
  const isGraphql = (path: string): boolean =>
    graphql !== undefined && (path === graphql.path || path === `${graphql.path}/`)
  const isAuth = (path: string): boolean =>
    builtin !== undefined &&
    (path === "/auth/v1" || path.startsWith("/auth/v1/") || path === "/.well-known/jwks.json")
  const authFetch = (request: Request, info: { readonly ip?: string } = {}): Promise<Response> => {
    if (builtin === undefined) return Promise.resolve(plain(404, "Not found"))
    return builtin.handler(request, info.ip === undefined ? {} : { clientAddress: info.ip })
  }

  const route = async (
    request: Request,
    fallback: FetchHandler | undefined,
    info: { readonly ip?: string },
  ): Promise<Response> => {
    const path = new URL(request.url).pathname
    if (isAdmin(path)) return admin.private ? plain(404, "Not found") : admin.fetch(request, info)
    if (isAuth(path)) return authFetch(request, info)
    if (rest !== undefined && isRest(path)) return rest.fetch(request, info)
    if (graphql !== undefined && isGraphql(path)) return graphql.fetch(request, info)
    if (data.storage !== undefined && isStorage(path))
      return data.storage.handler.fetch(request, info)
    if (http?.matches(request) === true) return http.fetch(request, info)
    return (
      (await health(path)) ?? (fallback === undefined ? plain(404, "Not found") : fallback(request))
    )
  }

  const fetch = async (
    request: Request,
    fallback?: FetchHandler,
    info: { readonly ip?: string } = {},
  ): Promise<Response> => {
    const started = performance.now()
    const response =
      tracing === undefined
        ? await route(request, fallback, info)
        : await tracing.fetch(request, () => route(request, fallback, info))
    return logResponse(request, response, started, info.ip)
  }

  const canopy: Canopy = {
    config,
    rest,
    graphql,
    realtime,
    renderMetrics: () => `${data.httpRateLimited.render()}
${realtime?.renderMetrics() ?? ""}${
  webhooks === undefined
    ? ""
    : `
${webhooks.metrics.render()}`
}`,
    auth: builtin,
    keys: auth.apiKeys,
    admin: admin.surface,
    webhooks,
    storage: data.storage?.storage,
    get policies() {
      return data.engine()
    },
    fetch: (request, fallback, info) => fetch(request, fallback, info),
    node(nodeOptions = {}) {
      const restListener = rest === undefined ? undefined : toNodeListener(rest)
      const graphqlListener = graphql === undefined ? undefined : serveOnNode(graphql.fetch)
      const storageListener =
        data.storage === undefined ? undefined : serveOnNode(data.storage.handler.fetch)
      const streaming = http === undefined ? undefined : toNodeHandler(http)
      const adminListener = serveOnNode(admin.fetch)
      const authListener = serveOnNode(authFetch)
      const serve = (request: IncomingMessage, response: ServerResponse) => {
        logNode(request, response)
        const path = tryPathname(request)
        if (path === undefined) {
          response.statusCode = 400
          response.end("Bad request")
          return
        }
        if (isAuth(path)) return authListener(request, response)
        if (isAdmin(path)) {
          if (!admin.private) return adminListener(request, response)
          response.statusCode = 404
          response.end("Not found")
          return
        }
        if (restListener !== undefined && isRest(path)) return restListener(request, response)
        if (graphqlListener !== undefined && isGraphql(path))
          return graphqlListener(request, response)
        if (storageListener !== undefined && isStorage(path))
          return storageListener(request, response)
        const notRealtime = (): void => {
          const answer = health(path)
          if (answer !== undefined) {
            void answer
              .then(async (result) => {
                response.statusCode = result.status
                response.setHeader("content-type", "text/plain; charset=utf-8")
                response.end(await result.text())
              })
              .catch(() => {
                response.statusCode = 500
                response.end()
              })
            return
          }
          if (nodeOptions.fallback !== undefined) {
            nodeOptions.fallback(request, response)
            return
          }
          response.statusCode = 404
          response.end("Not found")
        }
        if (streaming === undefined) notRealtime()
        else streaming(request, response, notRealtime)
      }
      if (tracing === undefined) return serve
      return (request, response) => tracing.node(request, response, () => serve(request, response))
    },
    async attach(server) {
      if (graphql !== undefined && realtime !== undefined) {
        const { attachGraphqlWs } = await import("@canopy/graphql")
        transports.attachments.push(await attachGraphqlWs(graphql, server))
      }
      if (realtime === undefined || !transports.websocket) return
      transports.attachments.push(await attach(realtime, server))
    },
    bun(bunOptions = {}) {
      const peer = (request: Request, server: unknown): { readonly ip?: string } => {
        const address = (
          server as { requestIP?: (request: Request) => { address: string } | null } | undefined
        )?.requestIP?.(request)?.address
        return address === undefined ? {} : { ip: address }
      }
      if (realtime === undefined) {
        return {
          fetch: (request: Request, server: BunServerLike<never>) =>
            fetch(request, bunOptions.fallback, peer(request, server)),
        }
      }
      const handlers = bunHandlers(realtime, {
        ...(http === undefined ? {} : { http }),
        fallback: (request) => fetch(request, bunOptions.fallback),
      })
      return {
        fetch: (request: Request, server: BunServerLike<never>) => {
          const path = new URL(request.url).pathname
          if (isAdmin(path) || isAuth(path) || isGraphql(path) || isStorage(path))
            return fetch(request, bunOptions.fallback, peer(request, server))
          if (rest !== undefined && isRest(path)) {
            const started = performance.now()
            const ip = peer(request, server).ip
            const served =
              tracing === undefined
                ? rest.fetch(request)
                : tracing.fetch(request, () => rest.fetch(request))
            return served.then((response) => logResponse(request, response, started, ip))
          }
          if (!transports.websocket && request.headers.get("upgrade") !== null)
            return fetch(request, bunOptions.fallback)
          const started = performance.now()
          const result = handlers.fetch(request, server as never)
          if (result === undefined || surfaceOf(path) !== "realtime") return result
          const ip = peer(request, server).ip
          return Promise.resolve(result).then((response) =>
            logResponse(request, response, started, ip),
          )
        },
        websocket: handlers.websocket,
      }
    },
    async close(closeOptions = {}) {
      if (closing) return
      closing = true
      data.stopReloading()
      stores.stop()
      await admin.close()
      await webhooks?.stop()
      await data.drain(closeOptions.drainMs)
      await transports.close()
      data.close()
      await auth.close()
      await connection.close()
    },
    async [Symbol.asyncDispose]() {
      await canopy.close({ drainMs: 0 })
    },
  }
  return canopy
}
