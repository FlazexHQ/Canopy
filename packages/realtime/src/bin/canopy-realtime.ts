#!/usr/bin/env node
import { createServer } from "node:http"
import { parseJsonWebKeySet, RateLimits } from "@canopy/auth"
import { ConfigError, type ResolvedConfig } from "@canopy/config"
import { loadConfig } from "@canopy/config/load"
import { jsonLogger, onShutdown, parseBinaryArgs, UsageError } from "@canopy/config/process"
import { serveMetrics, tryPathname } from "@canopy/node-http"
import { MongoClient } from "mongodb"
import { createHttpTransport, type HttpTransport } from "../http-transport.ts"
import { type Logger, redacting } from "../logger.ts"
import { readinessCheck } from "../readiness.ts"
import { createRealtime } from "../realtime.ts"
import type { RealtimeOptions } from "../realtime-types.ts"
import { attach, type BunServerLike, bunHandlers, toNodeHandler } from "../transports.ts"

/**
 * The `canopy-realtime` sidecar, which runs next to an existing app. Configured by a config file
 * (`--config <file>`, or `canopy.config.ts` / `canopy/canopy.config.ts` found from the working directory)
 * and the well known variables: `MONGODB_URI`, `CANOPY_DB`, `CANOPY_POLICIES`, `CANOPY_JWT_*`,
 * `CANOPY_PUBLISHABLE_KEYS`, `PORT`, `METRICS_PORT` and the others of the configuration reference.
 */

const USAGE = `Usage: canopy-realtime [--config <file>]

Runs Canopy Realtime next to an existing app. Without --config, canopy.config.ts or
canopy/canopy.config.ts is found from the working directory, and the CANOPY_* variables apply.
`

/** Maps a resolved config to the options of the realtime engine. */
export function realtimeOptions(config: ResolvedConfig, logger: Logger): RealtimeOptions {
  const realtime = config.realtime
  if (realtime === false)
    throw new TypeError(
      "realtime is turned off in the config, so canopy-realtime has nothing to serve",
    )
  const auth = config.auth
  if (auth?.kind === "builtin")
    throw new TypeError(
      'built in auth runs in the canopy server, not in canopy-realtime. To accept its tokens here, use external() with jwksUrl <public URL>/auth/v1/.well-known/jwks.json, issuer <public URL>/auth/v1, audience <public URL> and rolesClaim "roles"',
    )
  return {
    mongo: new MongoClient(config.mongodb.uri, { appName: "canopy-realtime" }),
    database: config.mongodb.database,
    metaDatabase: config.mongodb.metaDatabase,
    ...(auth === undefined
      ? {}
      : {
          auth: {
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
          },
        }),
    keys: { publishable: config.keys.publishable, secret: config.keys.secret },
    policies:
      "dir" in config.policies
        ? { dir: config.policies.dir, watch: config.policies.watch }
        : { source: "database", watch: config.policies.watch },
    fullDocument: realtime.fullDocument,
    checkpoints: realtime.checkpoints,
    resumeWindowMs: realtime.resumeWindowMs,
    nodeId: config.server.nodeId,
    logger,
    logVariableIssues: config.environment === "development",
    ...(config.rateLimits === false
      ? {}
      : {
          rateLimits: new RateLimits({
            requests: config.rateLimits.requests,
            messages: config.rateLimits.messages,
            anonymousConnectionsPerAddress: config.rateLimits.anonymousConnectionsPerAddress,
            failedAuthentications: config.rateLimits.failedAuthentications,
            exemptService: config.rateLimits.exemptService,
            trustedProxies: config.server.trustedProxies,
          }),
        }),
  }
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

async function load(): Promise<ResolvedConfig> {
  let file: string | undefined
  try {
    const args = parseBinaryArgs(process.argv.slice(2))
    if (args.help) {
      process.stdout.write(USAGE)
      process.exit(0)
    }
    file = args.file
  } catch (error: unknown) {
    if (error instanceof UsageError) fail(`canopy-realtime: ${error.message}\n\n${USAGE}`)
    throw error
  }
  try {
    return (await loadConfig({ command: "realtime", ...(file === undefined ? {} : { file }) }))
      .config
  } catch (error: unknown) {
    if (error instanceof ConfigError) fail(error.message)
    throw error
  }
}

async function main(): Promise<void> {
  const config = await load()
  const logger = redacting(jsonLogger(config.log.level))
  const options = realtimeOptions(config, logger)
  const settings = config.realtime
  if (settings === false) return
  const transports = new Set(settings.transports)
  const realtime = await createRealtime(options)
  const origins = config.cors?.origins
  const http: HttpTransport | undefined =
    transports.has("sse") || transports.has("long-poll")
      ? createHttpTransport(realtime, {
          nodeId: config.server.nodeId,
          ...(origins === undefined
            ? {}
            : { cors: { origins: origins === "*" ? ("*" as const) : [...origins] } }),
        })
      : undefined
  const { port, metricsPort } = config.server
  const readiness = readinessCheck({
    mongo: options.mongo,
    changeStream: () => realtime.changeStreamOpen,
  })
  const health = async (path: string): Promise<{ status: number; body: string } | undefined> => {
    if (path === "/healthz") return { status: 200, body: "ok" }
    if (path !== "/readyz") return undefined
    const state = await readiness()
    return state.ready
      ? { status: 200, body: "ok" }
      : { status: 503, body: `not ready: ${state.reason ?? "unknown"}` }
  }

  const metrics = await serveMetrics({
    port: metricsPort,
    host: config.server.metricsHost,
    token: config.server.metricsToken,
    render: () => realtime.renderMetrics(),
  })

  const bun = (
    globalThis as { Bun?: { serve(options: Record<string, unknown>): { stop(): void } } }
  ).Bun
  const notFound = async (path: string): Promise<Response> => {
    const result = await health(path)
    return new Response(result?.body ?? "Not found", { status: result?.status ?? 404 })
  }
  let stopServer: () => Promise<void>
  if (bun !== undefined) {
    const handlers = bunHandlers(realtime, {
      ...(http === undefined ? {} : { http }),
      fallback: (request) => notFound(new URL(request.url).pathname),
    })
    const server = bun.serve({
      port,
      fetch: (request: Request, srv: BunServerLike<{ connection: undefined }>) =>
        !transports.has("websocket") && request.headers.get("upgrade") !== null
          ? notFound(new URL(request.url).pathname)
          : handlers.fetch(request, srv as never),
      websocket: handlers.websocket,
    })
    stopServer = async () => {
      http?.close()
      server.stop()
    }
  } else {
    const fallbackTransports = http === undefined ? undefined : toNodeHandler(http)
    const server = createServer((request, response) => {
      const fallback = (): void => {
        const path = tryPathname(request)
        void (path === undefined ? Promise.resolve(undefined) : health(path)).then((result) => {
          response.statusCode = result?.status ?? (path === undefined ? 400 : 404)
          response.end(result?.body ?? (path === undefined ? "Bad request" : "Not found"))
        })
      }
      if (fallbackTransports === undefined) fallback()
      else fallbackTransports(request, response, fallback)
    })
    const attachment = transports.has("websocket") ? await attach(realtime, server) : undefined
    await new Promise<void>((resolve) => server.listen(port, resolve))
    stopServer = async () => {
      http?.close()
      await attachment?.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
  logger.info(
    {
      port,
      metricsPort,
      database: options.database,
      config: config.file ?? "environment",
      runtime: bun === undefined ? "node" : "bun",
    },
    "canopy-realtime listening",
  )

  let stopping = false
  const shutdown = (signal: string): void => {
    if (stopping) return
    stopping = true
    logger.info({ signal, drainMs: settings.drainWindowMs }, "draining")
    realtime
      .close({ drainMs: settings.drainWindowMs })
      .then(stopServer)
      .then(() => {
        metrics.close()
        return options.mongo.close()
      })
      .then(
        () => {
          logger.info({}, "stopped")
          process.exit(0)
        },
        (error: unknown) => {
          logger.error({ err: error }, "shutdown failed")
          process.exit(1)
        },
      )
  }
  onShutdown(shutdown)
}

main().catch((error: unknown) => {
  jsonLogger("error").error({ err: error }, "canopy-realtime failed to start")
  process.exit(1)
})
