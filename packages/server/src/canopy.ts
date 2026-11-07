import type { IncomingMessage, Server, ServerResponse } from "node:http"
import { Authenticator, type JwtAuthOptions } from "@canopy/auth"
import {
  type CanopyConfigInput,
  type ConfigFunction,
  isResolvedConfig,
  type ResolvedConfig,
  resolveConfig,
} from "@canopy/config"
import { ContextResolver, PolicyEngine, type PolicySet } from "@canopy/policy"
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
import { createRestHandler, type RestHandler, toNodeListener } from "@canopy/rest"
import type { JSONWebKeySet } from "jose"
import { MongoClient } from "mongodb"

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
  /** The policies in force (hot reloaded). */
  readonly policies: PolicyEngine
  /**
   * Serves REST, the SSE and long-poll transports, `/healthz` and `/readyz`; anything else goes to
   * `fallback` (404 without one). WebSockets need {@link attach} (Node) or {@link bun}.
   */
  fetch(request: Request, fallback?: FetchHandler): Promise<Response>
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
  await mongo.connect()
  const db = mongo.db(config.mongodb.database)
  const contexts = new ContextResolver({ reader: mongoContextReader(db) })
  const auth = jwtOptions(config)
  const keys = { publishable: config.keys.publishable, secret: config.keys.secret }
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
          authenticator: new Authenticator(auth, keys),
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
    realtime = await createRealtime({
      mongo,
      database: config.mongodb.database,
      metaDatabase: config.mongodb.metaDatabase,
      ...(auth === undefined ? {} : { auth }),
      keys,
      policies: watch ? source : { load: () => source.load() },
      fullDocument: realtimeConfig.fullDocument,
      checkpoints: realtimeConfig.checkpoints,
      resumeWindowMs: realtimeConfig.resumeWindowMs,
      nodeId: config.server.nodeId,
      contexts,
      logger,
      ...(rest === undefined ? {} : { mutations: rest.writes }),
    })
  } else {
    let current = new PolicyEngine(await source.load())
    standalone = current
    if (watch && source.watch !== undefined) {
      stopWatching = source.watch(
        (set) => {
          current = new PolicyEngine(set)
          standalone = current
        },
        (error) =>
          logger.error({ err: error }, "policy reload rejected, keeping the previous policies"),
      )
    }
  }

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

  const fetch = async (request: Request, fallback?: FetchHandler): Promise<Response> => {
    const path = new URL(request.url).pathname
    if (rest !== undefined && isRest(path)) return rest.fetch(request)
    if (http?.matches(request) === true) return http.fetch(request)
    return health(path) ?? (fallback === undefined ? plain(404, "Not found") : fallback(request))
  }

  const canopy: Canopy = {
    config,
    rest,
    realtime,
    get policies() {
      return engine()
    },
    fetch,
    node(nodeOptions = {}) {
      const restListener = rest === undefined ? undefined : toNodeListener(rest)
      const streaming = http === undefined ? undefined : toNodeHandler(http)
      return (request, response) => {
        const path = new URL(request.url ?? "/", "http://localhost").pathname
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
      if (realtime === undefined) {
        return { fetch: (request: Request) => fetch(request, bunOptions.fallback) }
      }
      const handlers = bunHandlers(realtime, {
        ...(http === undefined ? {} : { http }),
        fallback: (request) => fetch(request, bunOptions.fallback),
      })
      return {
        fetch: (request: Request, server: BunServerLike<never>) => {
          if (rest !== undefined && isRest(new URL(request.url).pathname))
            return rest.fetch(request)
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
      await realtime?.close({
        drainMs:
          closeOptions.drainMs ?? (realtimeConfig === false ? 0 : realtimeConfig.drainWindowMs),
      })
      http?.close()
      for (const attachment of attachments.splice(0)) await attachment.close()
      contexts.close()
      if (ownsMongo) await mongo.close()
    },
    async [Symbol.asyncDispose]() {
      await canopy.close({ drainMs: 0 })
    },
  }
  return canopy
}
