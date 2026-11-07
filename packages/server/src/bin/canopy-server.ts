#!/usr/bin/env node
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { ConfigError, type ResolvedConfig } from "@canopy/config"
import { loadConfig } from "@canopy/config/load"
import {
  type BinaryArgs,
  jsonLogger,
  onShutdown,
  parseBinaryArgs,
  UsageError,
} from "@canopy/config/process"
import { redacting } from "@canopy/realtime"
import { type Canopy, createCanopy } from "../canopy.ts"

const USAGE = `Usage: canopy-server [--config <file>]

Starts the Canopy server: the Data API, realtime, health and metrics on one process.

Options:
  --config <file>  The config file. Without it, canopy.config.ts or canopy/canopy.config.ts is
                   looked up from the working directory, and the environment configures the rest.
  --help           Prints this message.
`

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

async function load(): Promise<ResolvedConfig> {
  let args: BinaryArgs
  try {
    args = parseBinaryArgs(process.argv.slice(2))
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
  onShutdown(shutdown)
}

main().catch((error: unknown) => {
  jsonLogger("error").error({ err: error }, "canopy failed to start")
  process.exit(1)
})
