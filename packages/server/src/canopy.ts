import type { IncomingMessage, Server, ServerResponse } from "node:http"
import { Authenticator, type JwtAuthOptions } from "@canopy/auth"
import type { BuiltinAuth } from "@canopy/auth-builtin"
import {
  type CanopyConfigInput,
  type ConfigFunction,
  isResolvedConfig,
  type ResolvedConfig,
  resolveConfig,
} from "@canopy/config"
import { ContextResolver, onceVariableIssue, PolicyEngine, type PolicySet } from "@canopy/policy"
import {
  CloseCode,
  DiagnosticError,
  diagnoseMongoError,
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
  mongoContextReader,
  type PolicySource,
  type Realtime,
  silentLogger,
  staticPolicies,
  toNodeHandler,
} from "@canopy/realtime"
import { createRestHandler, type RestHandler, toNodeListener, WritePath } from "@canopy/rest"
import type { JSONWebKeySet } from "jose"
import { MongoClient } from "mongodb"
import { AdminAccounts } from "./admin/accounts.ts"
import { type AdminApi, createAdminApi } from "./admin/api.ts"
import { STUDIO_CSP, secure } from "./admin/http.ts"
import { SecretBox } from "./admin/secrets.ts"
import { SettingsStore } from "./admin/settings.ts"
import { ApiKeys } from "./api-keys.ts"
import { AuditLog } from "./audit.ts"
import { revokes, startBuiltinAuth } from "./builtin-auth.ts"
import { migrateMeta } from "./migrations.ts"
import { nodeBridge } from "./node-bridge.ts"
import { PolicyStore } from "./policy-store.ts"

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
  /** Serves Studio under `/studio`, on the same listener as the admin API. */
  readonly studio?: FetchHandler
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
  readonly policies: PolicyStore
  readonly audit: AuditLog
  /** Serves `/admin` and `/studio`; anything else is `404`. `info.ip` is the peer address. */
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
  const config = isResolvedConfig(input)
    ? input
    : resolveConfig(
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
  const logger = options.logger ?? silentLogger
  const ownsMongo = options.mongo === undefined
  const mongo = options.mongo ?? new MongoClient(config.mongodb.uri, { appName: "canopy" })
  const report = (message: string): void => {
    if (options.logger === undefined) process.stderr.write(`${message}\n`)
    else logger.error({}, message)
  }
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
  const db = mongo.db(config.mongodb.database)
  const meta = mongo.db(config.mongodb.metaDatabase)
  if (options.migrate !== false) await diagnosed(() => migrateMeta(meta, { logger }))
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
  const builtinAuth =
    config.auth?.kind === "builtin"
      ? await startBuiltinAuth(config, config.auth, mongo, logger)
      : undefined
  const auth = builtinAuth?.verification ?? jwtOptions(config)
  const keys = { publishable: config.keys.publishable, secret: config.keys.secret }
  const apiKeys = new ApiKeys(meta, { logger })
  const authenticator = new Authenticator(auth, keys, { store: apiKeys })
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
          authenticator,
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
    realtime = await diagnosed(() =>
      createRealtime({
        mongo,
        database: config.mongodb.database,
        metaDatabase: config.mongodb.metaDatabase,
        authenticator,
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

  const revoked = (ids: ReadonlySet<string>): void => {
    const closed = realtime?.closeConnections(
      (principal) => principal.keyId !== undefined && ids.has(principal.keyId),
      CloseCode.Forbidden,
      "The API key was revoked",
    )
    if (closed !== undefined && closed > 0)
      logger.info({ keys: [...ids], connections: closed }, "closed connections of revoked keys")
  }
  apiKeys.watch(
    (id) => revoked(new Set([id])),
    () => {
      const used = (realtime?.connections() ?? []).flatMap((c) =>
        c.keyId === undefined ? [] : [c.keyId],
      )
      apiKeys
        .inactive(used)
        .then(revoked, (error: unknown) =>
          logger.error({ err: error }, "could not recheck API keys"),
        )
    },
  )

  builtinAuth?.onRevocation((revocation) => {
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

  const audit = new AuditLog(meta)
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
    secrets: new SecretBox(config.masterKey),
    environment: config.environment,
  })
  const adminApi =
    options.admin === false
      ? undefined
      : createAdminApi({
          config,
          client: mongo,
          accounts,
          audit,
          policies: policyStore,
          keys: apiKeys,
          settings: new SettingsStore(meta, audit),
          engine,
          contexts,
          writes:
            rest?.writes ??
            new WritePath({
              client: mongo,
              database: config.mongodb.database,
              metaDatabase: config.mongodb.metaDatabase,
              policies: engine,
            }),
          realtime,
          logger,
          ...(builtinAuth === undefined ? {} : { auth: builtinAuth }),
        })
  if (adminApi !== undefined && options.onSetupToken !== false) {
    const token = await accounts.createSetupToken()
    if (token !== undefined) {
      const announce =
        options.onSetupToken ??
        ((value: string) => {
          const message = `This server has no owner yet. Claim it in Studio or with POST /admin/v1/setup using the one time setup token ${value}`
          if (options.logger === undefined) process.stderr.write(`${message}\n`)
          else logger.warn({}, message)
        })
      announce(token)
    }
  }
  const isAdmin = (path: string): boolean =>
    path === "/admin" ||
    path.startsWith("/admin/") ||
    path === "/studio" ||
    path.startsWith("/studio/")
  const privateAdmin = config.server.adminListen !== undefined
  const adminFetch = async (
    request: Request,
    info: { readonly ip?: string } = {},
  ): Promise<Response> => {
    const path = new URL(request.url).pathname
    if (adminApi !== undefined && (path === "/admin/v1" || path.startsWith("/admin/v1/")))
      return adminApi.fetch(request, info)
    if (options.studio !== undefined && (path === "/studio" || path.startsWith("/studio/")))
      return secure(await options.studio(request), STUDIO_CSP)
    return secure(plain(404, "Not found"))
  }
  const adminSurface: AdminSurface = {
    api: adminApi,
    accounts,
    policies: policyStore,
    audit,
    fetch: adminFetch,
    node: () => nodeBridge(adminFetch),
    async listen() {
      const listen = config.server.adminListen
      if (listen === undefined) return undefined
      const { createServer } = await import("node:http")
      const separator = listen.lastIndexOf(":")
      const host = separator < 0 ? "127.0.0.1" : listen.slice(0, separator).replace(/^\[|\]$/g, "")
      const port = Number(separator < 0 ? listen : listen.slice(separator + 1))
      const bridge = nodeBridge(adminFetch)
      const server = createServer((request, response) => {
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
      adminServers.push(server)
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
  const adminServers: Server[] = []

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
  let closing = false

  const health = (path: string): Response | undefined => {
    if (path === "/healthz") return plain(200, "ok")
    if (path === "/readyz") return closing ? plain(503, "draining") : plain(200, "ready")
    return undefined
  }
  const isRest = (path: string): boolean => path === "/rest/v1" || path.startsWith("/rest/v1/")
  const isAuth = (path: string): boolean =>
    builtinAuth !== undefined &&
    (path === "/auth/v1" || path.startsWith("/auth/v1/") || path === "/.well-known/jwks.json")
  const authFetch = (request: Request, info: { readonly ip?: string } = {}): Promise<Response> => {
    if (builtinAuth === undefined) return Promise.resolve(plain(404, "Not found"))
    return builtinAuth.handler(request, info.ip === undefined ? {} : { clientAddress: info.ip })
  }

  const fetch = async (
    request: Request,
    fallback?: FetchHandler,
    info: { readonly ip?: string } = {},
  ): Promise<Response> => {
    const path = new URL(request.url).pathname
    if (isAdmin(path)) return privateAdmin ? plain(404, "Not found") : adminFetch(request, info)
    if (isAuth(path)) return authFetch(request, info)
    if (rest !== undefined && isRest(path)) return rest.fetch(request)
    if (http?.matches(request) === true) return http.fetch(request)
    return health(path) ?? (fallback === undefined ? plain(404, "Not found") : fallback(request))
  }

  const canopy: Canopy = {
    config,
    rest,
    realtime,
    auth: builtinAuth,
    keys: apiKeys,
    admin: adminSurface,
    get policies() {
      return engine()
    },
    fetch: (request, fallback, info) => fetch(request, fallback, info),
    node(nodeOptions = {}) {
      const restListener = rest === undefined ? undefined : toNodeListener(rest)
      const streaming = http === undefined ? undefined : toNodeHandler(http)
      const admin = nodeBridge(adminFetch)
      const authListener = nodeBridge(authFetch)
      return (request, response) => {
        const path = new URL(request.url ?? "/", "http://localhost").pathname
        if (isAuth(path)) return authListener(request, response)
        if (isAdmin(path)) {
          if (!privateAdmin) return admin(request, response)
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
      if (realtime === undefined || !transports.has("websocket")) return
      attachments.push(await attach(realtime, server))
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
          if (rest !== undefined && isRest(path)) return rest.fetch(request)
          if (!transports.has("websocket") && request.headers.get("upgrade") !== null)
            return fetch(request, bunOptions.fallback)
          return handlers.fetch(request, server as never)
        },
        websocket: handlers.websocket,
      }
    },
    async close(closeOptions = {}) {
      if (closing) return
      closing = true
      stopWatching?.()
      for (const server of adminServers.splice(0)) {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
      await realtime?.close({
        drainMs:
          closeOptions.drainMs ?? (realtimeConfig === false ? 0 : realtimeConfig.drainWindowMs),
      })
      http?.close()
      for (const attachment of attachments.splice(0)) await attachment.close()
      contexts.close()
      await apiKeys.close()
      await builtinAuth?.close()
      if (ownsMongo) await mongo.close()
    },
    async [Symbol.asyncDispose]() {
      await canopy.close({ drainMs: 0 })
    },
  }
  return canopy
}
