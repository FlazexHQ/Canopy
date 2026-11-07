#!/usr/bin/env node
import { createServer } from "node:http"
import { ConfigError, type ResolvedConfig } from "@canopy/config"
import { loadConfig } from "@canopy/config/load"
import type { JSONWebKeySet } from "jose"
import { MongoClient } from "mongodb"
import { createHttpTransport, type HttpTransport } from "../http-transport.ts"
import type { Logger } from "../logger.ts"
import { createRealtime, type RealtimeOptions } from "../realtime.ts"
import { attach, type BunServerLike, bunHandlers, toNodeHandler } from "../transports.ts"

/**
 * The `canopy-realtime` sidecar, which runs next to an existing app. Configured by a config file
 * (`--config <file>`, or `canopy.config.ts` / `canopy/canopy.config.ts` found from the working directory)
 * and the well known variables: `MONGODB_URI`, `CANOPY_DB`, `CANOPY_POLICIES`, `CANOPY_JWT_*`,
 * `CANOPY_PUBLISHABLE_KEYS`, `PORT`, `METRICS_PORT` and the others of the configuration reference.
 */

const LEVELS = ["debug", "info", "warn", "error"] as const

function jsonLogger(level: string): Logger {
  const threshold = Math.max(0, LEVELS.indexOf(level as (typeof LEVELS)[number]))
  const write =
    (name: (typeof LEVELS)[number]) => (object: Record<string, unknown>, message?: string) => {
      if (LEVELS.indexOf(name) < threshold) return
      const err = object["err"]
      const record = {
        level: name,
        time: new Date().toISOString(),
        msg: message,
        ...object,
        ...(err instanceof Error ? { err: { message: err.message, name: err.name } } : {}),
      }
      process.stderr.write(`${JSON.stringify(record)}\n`)
    }
  return { debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error") }
}

function configFlag(argv: readonly string[]): string | undefined {
  const index = argv.findIndex((arg) => arg === "--config" || arg.startsWith("--config="))
  if (index < 0) return undefined
  const arg = argv[index] ?? ""
  const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[index + 1]
  if (value === undefined || value === "" || value.startsWith("--"))
    throw new TypeError("--config needs a file")
  return value
}

/** Maps a resolved config to the options of the realtime engine. */
export function realtimeOptions(config: ResolvedConfig, logger: Logger): RealtimeOptions {
  const realtime = config.realtime
  if (realtime === false)
    throw new TypeError(
      "realtime is turned off in the config, so canopy-realtime has nothing to serve",
    )
  const auth = config.auth
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
            ...(auth.jwks === undefined ? {} : { jwks: auth.jwks as unknown as JSONWebKeySet }),
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
  }
}

async function load(): Promise<ResolvedConfig> {
  try {
    const file = configFlag(process.argv.slice(2))
    return (await loadConfig({ command: "realtime", ...(file === undefined ? {} : { file }) }))
      .config
  } catch (error: unknown) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`)
      process.exit(1)
    }
    throw error
  }
}

async function main(): Promise<void> {
  const config = await load()
  const logger = jsonLogger(config.log.level)
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
  const health = (path: string): { status: number; body: string } | undefined =>
    path === "/healthz" || path === "/readyz" ? { status: 200, body: "ok" } : undefined

  const metrics = createServer((request, response) => {
    if (new URL(request.url ?? "/", "http://localhost").pathname !== "/metrics") {
      response.statusCode = 404
      response.end()
      return
    }
    response.setHeader("content-type", "text/plain; version=0.0.4")
    response.end(realtime.renderMetrics())
  })
  metrics.listen(metricsPort)

  const bun = (
    globalThis as { Bun?: { serve(options: Record<string, unknown>): { stop(): void } } }
  ).Bun
  const notFound = (path: string): Response => {
    const result = health(path)
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
        const result = health(new URL(request.url ?? "/", "http://localhost").pathname)
        response.statusCode = result?.status ?? 404
        response.end(result?.body ?? "Not found")
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
  const shutdown = (): void => {
    if (stopping) return
    stopping = true
    logger.info({}, "draining")
    realtime
      .close({ drainMs: settings.drainWindowMs })
      .then(stopServer)
      .then(() => {
        metrics.close()
        return options.mongo.close()
      })
      .then(
        () => process.exit(0),
        (error: unknown) => {
          logger.error({ err: error }, "shutdown failed")
          process.exit(1)
        },
      )
  }
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ level: "error", msg: "canopy-realtime failed to start", err: error instanceof Error ? error.message : String(error) })}\n`,
  )
  process.exit(1)
})
