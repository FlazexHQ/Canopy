#!/usr/bin/env node
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { ConfigError, type ResolvedConfig } from "@canopy/config"
import { loadConfig } from "@canopy/config/load"
import { type Logger, redacting } from "@canopy/realtime"
import { type Canopy, createCanopy } from "../canopy.ts"

const USAGE = `Usage: canopy-server [--config <file>]

Starts the Canopy server: the Data API, realtime, health and metrics on one process.

Options:
  --config <file>  The config file. Without it, canopy.config.ts or canopy/canopy.config.ts is
                   looked up from the working directory, and the environment configures the rest.
  --help           Prints this message.
`

const LEVELS = ["debug", "info", "warn", "error"] as const
type Level = (typeof LEVELS)[number]

function jsonLogger(level: string): Logger {
  const threshold = Math.max(0, LEVELS.indexOf(level as Level))
  const write = (name: Level) => (object: Record<string, unknown>, message?: string) => {
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

class UsageError extends TypeError {}

function parseArgs(argv: readonly string[]): { readonly file?: string; readonly help: boolean } {
  let file: string | undefined
  let help = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? ""
    if (arg === "--help" || arg === "-h") help = true
    else if (arg === "--config" || arg.startsWith("--config=")) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++index]
      if (value === undefined || value === "" || value.startsWith("-"))
        throw new UsageError("--config needs a file")
      file = value
    } else throw new UsageError(`Unknown option ${arg}`)
  }
  return file === undefined ? { help } : { file, help }
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

async function load(): Promise<ResolvedConfig> {
  let args: ReturnType<typeof parseArgs>
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error: unknown) {
    if (error instanceof UsageError) fail(`canopy-server: ${error.message}\n\n${USAGE}`)
    throw error
  }
  if (args.help) {
    process.stdout.write(USAGE)
    process.exit(0)
  }
  try {
    const loaded = await loadConfig({
      command: "start",
      ...(args.file === undefined ? {} : { file: args.file }),
    })
    return loaded.config
  } catch (error: unknown) {
    if (error instanceof ConfigError) fail(error.message)
    throw error
  }
}

interface BunRuntime {
  serve(options: Record<string, unknown>): { readonly port: number; stop(force?: boolean): void }
}

interface Listening {
  readonly port: number
  stop(): Promise<void>
}

async function listen(canopy: Canopy, port: number): Promise<Listening> {
  const bun = (globalThis as { Bun?: BunRuntime }).Bun
  if (bun !== undefined) {
    const server = bun.serve({ port, ...canopy.bun() })
    return {
      port: server.port,
      stop: async () => server.stop(true),
    }
  }
  const server = createServer(canopy.node())
  await canopy.attach(server)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, () => resolve())
  })
  return {
    port: (server.address() as AddressInfo).port,
    stop: () => {
      server.closeAllConnections()
      return new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

async function metricsServer(canopy: Canopy, port: number, runtime: string): Promise<Server> {
  const started = Date.now()
  const server = createServer((request, response) => {
    if (new URL(request.url ?? "/", "http://localhost").pathname !== "/metrics") {
      response.statusCode = 404
      response.end()
      return
    }
    const lines = [
      "# HELP canopy_build_info Canopy server process information.",
      "# TYPE canopy_build_info gauge",
      `canopy_build_info{runtime="${runtime}",node_id="${canopy.config.server.nodeId}"} 1`,
      "# HELP canopy_uptime_seconds Seconds since the server started.",
      "# TYPE canopy_uptime_seconds gauge",
      `canopy_uptime_seconds ${((Date.now() - started) / 1000).toFixed(3)}`,
      "",
    ].join("\n")
    response.setHeader("content-type", "text/plain; version=0.0.4")
    response.end(lines + (canopy.realtime?.renderMetrics() ?? ""))
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, () => resolve())
  })
  return server
}

async function main(): Promise<void> {
  const config = await load()
  const logger = redacting(jsonLogger(config.log.level))
  const runtime = (globalThis as { Bun?: unknown }).Bun === undefined ? "node" : "bun"
  const canopy = await createCanopy(config, { logger })
  const http = await listen(canopy, config.server.port)
  const metrics = await metricsServer(canopy, config.server.metricsPort, runtime)
  const admin = await canopy.admin.listen()
  if (admin !== undefined) logger.info({ address: admin.address }, "admin listening")
  const realtime = config.realtime
  logger.info(
    {
      port: http.port,
      metricsPort: (metrics.address() as AddressInfo).port,
      database: config.mongodb.database,
      environment: config.environment,
      rest: config.rest !== false,
      realtime: realtime !== false,
      config: config.file ?? "environment",
      runtime,
    },
    "canopy listening",
  )

  let stopping = false
  const shutdown = (signal: string): void => {
    if (stopping) return
    stopping = true
    const drainMs = realtime === false ? 0 : realtime.drainWindowMs
    logger.info({ signal, drainMs }, "draining")
    canopy
      .close({ drainMs })
      .then(() => admin?.close())
      .then(() => http.stop())
      .then(() => new Promise<void>((resolve) => metrics.close(() => resolve())))
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
  process.on("SIGTERM", () => shutdown("SIGTERM"))
  process.on("SIGINT", () => shutdown("SIGINT"))
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      level: "error",
      time: new Date().toISOString(),
      msg: "canopy failed to start",
      err: error instanceof Error ? error.message : String(error),
    })}\n`,
  )
  process.exit(1)
})
