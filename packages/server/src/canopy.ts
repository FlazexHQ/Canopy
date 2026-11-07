import type { IncomingMessage, Server, ServerResponse } from "node:http"
import {
  Authenticator,
  addressAllowed,
  type JwtAuthOptions,
  resolveClientAddress,
} from "@canopy/auth"
import type { BuiltinAuth } from "@canopy/auth-builtin"
import {
  type CanopyConfigInput,
  type ConfigFunction,
  isResolvedConfig,
  type ResolvedConfig,
  resolveConfig,
} from "@canopy/config"
import { toNodeListener as serveOnNode } from "@canopy/node-http"
import { ContextResolver, onceVariableIssue, PolicyEngine, type PolicySet } from "@canopy/policy"
import {
  CloseCode,
  DiagnosticError,
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
  createHttpTransport,
  createRealtime,
  databasePolicies,
  directoryPolicies,
  type HttpTransport,
  type Logger,
  type PolicySource,
  type Realtime,
  silentLogger,
  staticPolicies,
  toNodeHandler,
} from "@canopy/realtime"
import {
  createRestHandler,
  mongoContextReader,
  type RestHandler,
  toNodeListener,
  WritePath,
} from "@canopy/rest"
import { createStudioHandler } from "@canopy/studio"
import type { JSONWebKeySet } from "jose"
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
import { ViewTokens } from "./view-tokens.ts"

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
  /** The realtime engine, when realtime is on. */
  readonly realtime: Realtime | undefined
  /** Built in auth, when the config chooses `builtin()`; it serves `/auth/v1`. */
  readonly auth: BuiltinAuth | undefined
  /** The policies in force (hot reloaded). */
  readonly policies: PolicyEngine
  /** The API keys stored in the meta database. Keys from the config work next to them. */
  readonly keys: ApiKeys
  /** The admin API, Studio and the stores behind them. */
  readonly admin: AdminSurface
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
  /** Accepts WebSocket upgrades on `/realtime/v1` of a Node server. */
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
    ...(auth.jwks === undefined ? {} : { jwks: auth.jwks as unknown as JSONWebKeySet }),
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
async function connect(config: ResolvedConfig, options: CreateCanopyOptions, logger: Logger) {
  const ownsMongo = options.mongo === undefined
  const mongo = options.mongo ?? new MongoClient(config.mongodb.uri, { appName: "canopy" })
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
    const path = new URL(request.url ?? "/", "http://localhost").pathname
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

/**
 * The policy source with hot reload, the context lookup resolver, REST and the realtime engine. With
 * realtime on, its engine holds the policies; otherwise a standalone engine follows the source.
 */
async function buildData(
  config: ResolvedConfig,
  connection: Connection,
  auth: Auth,
  options: CreateCanopyOptions,
  logger: Logger,
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
          readLimits: { defaultLimit: restConfig.defaultLimit, maxLimit: restConfig.maxLimit },
          maxBodyBytes: restConfig.maxBodyBytes,
          mutationTtlSeconds: Math.round(restConfig.mutationTtlMs / 1000),
          idTypes: Object.fromEntries(
            Object.entries(config.collections)
              .filter(([, collection]) => collection.idType !== "auto")
              .map(([name, collection]) => [name, collection.idType]),
          ),
          ...(config.cors === undefined ? {} : { cors: config.cors }),
          onError: (error) => logger.error({ err: error }, "REST request failed"),
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
        nodeId: config.server.nodeId,
        contexts,
        logger,
        traceCapacity: 256,
        logVariableIssues: development,
        ...(rest === undefined ? {} : { mutations: rest.writes }),
      }),
    )
  } else {
    let current = new PolicyEngine(await source.load(), variableHooks)
    standalone = current
    if (watch && source.watch !== undefined) {
      stopWatching = source.watch(
        (set) => {
          current = new PolicyEngine(set, variableHooks)
          standalone = current
        },
        (error) =>
          logger.error({ err: error }, "policy reload rejected, keeping the previous policies"),
      )
    }
  }
  const engineRealtime = realtime

  return {
    contexts,
    rest,
    realtime: engineRealtime,
    engine,
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
      contexts.close()
    },
  }
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
          viewTokens: auth.viewTokens,
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
  const trustedProxies = [
    ...config.server.trustedProxies,
    ...(config.auth?.kind === "builtin" ? config.auth.trustedProxies : []),
  ]
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
  const logger = options.logger ?? silentLogger
  const connection = await connect(config, options, logger)
  const stores = await buildStores(connection, logger)
  const auth = await buildAuth(config, connection, stores, logger)
  const data = await buildData(config, connection, auth, options, logger)
  closeRevokedConnections(auth, data.realtime, logger)
  const admin = await buildAdmin(config, connection, stores, auth, data, options, logger)
  const transports = buildTransports(config, data.realtime)
  const { rest, realtime } = data
  const { http } = transports
  const { builtin } = auth
  const { logResponse, logNode } = stores
  let closing = false

  const health = (path: string): Response | undefined => {
    if (path === "/healthz") return plain(200, "ok")
    if (path === "/readyz") return closing ? plain(503, "draining") : plain(200, "ready")
    return undefined
  }
  const isRest = (path: string): boolean => path === "/rest/v1" || path.startsWith("/rest/v1/")
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
    if (rest !== undefined && isRest(path)) return rest.fetch(request)
    if (http?.matches(request) === true) return http.fetch(request)
    return health(path) ?? (fallback === undefined ? plain(404, "Not found") : fallback(request))
  }

  const fetch = async (
    request: Request,
    fallback?: FetchHandler,
    info: { readonly ip?: string } = {},
  ): Promise<Response> => {
    const started = performance.now()
    return logResponse(request, await route(request, fallback, info), started, info.ip)
  }

  const canopy: Canopy = {
    config,
    rest,
    realtime,
    auth: builtin,
    keys: auth.apiKeys,
    admin: admin.surface,
    get policies() {
      return data.engine()
    },
    fetch: (request, fallback, info) => fetch(request, fallback, info),
    node(nodeOptions = {}) {
      const restListener = rest === undefined ? undefined : toNodeListener(rest)
      const streaming = http === undefined ? undefined : toNodeHandler(http)
      const adminListener = serveOnNode(admin.fetch)
      const authListener = serveOnNode(authFetch)
      return (request, response) => {
        logNode(request, response)
        const path = new URL(request.url ?? "/", "http://localhost").pathname
        if (isAuth(path)) return authListener(request, response)
        if (isAdmin(path)) {
          if (!admin.private) return adminListener(request, response)
          response.statusCode = 404
          response.end("Not found")
          return
        }
        if (restListener !== undefined && isRest(path)) return restListener(request, response)
        const notRealtime = (): void => {
          const answer = health(path)
          if (answer !== undefined) {
            response.statusCode = answer.status
            response.setHeader("content-type", "text/plain; charset=utf-8")
            void answer.text().then((body) => response.end(body))
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
    },
    async attach(server) {
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
          if (isAdmin(path) || isAuth(path))
            return fetch(request, bunOptions.fallback, peer(request, server))
          if (rest !== undefined && isRest(path)) {
            const started = performance.now()
            const ip = peer(request, server).ip
            return rest
              .fetch(request)
              .then((response) => logResponse(request, response, started, ip))
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
