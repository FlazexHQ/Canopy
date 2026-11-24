#!/usr/bin/env node
import type { Server } from "node:http"
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
import { selectEngine } from "@canopy/native"
import { serveMetrics } from "@canopy/node-http"
import { redacting } from "@canopy/realtime"
import { type Canopy, createCanopy } from "../canopy.ts"
import { startGatewayFrontDoor } from "../gateway-front-door.ts"
import { listenCanopy } from "../listen.ts"
import { parseServerRole, planServerRole, type ServerRole } from "../roles.ts"

const USAGE = `Usage: canopy-server [--config <file>]

Starts the Canopy server: the Data API, realtime, health and metrics on one process.

CANOPY_ROLE splits the platform into services: all (the default) runs everything, api runs the
Data API, GraphQL, auth, storage, the admin API and webhooks, realtime runs realtime
connections, and control runs only auth, the admin API and webhooks next to a data plane that
serves every data route. With api, CANOPY_REALTIME_URL is the internal URL of the realtime
service, for GraphQL subscriptions.

Options:
  --config <file>  The config file. Without it, canopy.config.ts or canopy/canopy.config.ts is
                   looked up from the working directory, and the environment configures the rest.
  --help           Prints this message.
`

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

async function load(): Promise<{ config: ResolvedConfig; role: ServerRole }> {
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
    return { config: loaded.config, role: parseServerRole(process.env["CANOPY_ROLE"]) }
  } catch (error: unknown) {
    if (error instanceof ConfigError) fail(error.message)
    throw error
  }
}

function metricsServer(canopy: Canopy, runtime: string, extra: () => string): Promise<Server> {
  const started = Date.now()
  const { metricsPort, metricsHost, metricsToken } = canopy.config.server
  return serveMetrics({
    port: metricsPort,
    host: metricsHost,
    token: metricsToken,
    render: () =>
      [
        "# HELP canopy_build_info Canopy server process information.",
        "# TYPE canopy_build_info gauge",
        `canopy_build_info{runtime="${runtime}",node_id="${canopy.config.server.nodeId}"} 1`,
        "# HELP canopy_uptime_seconds Seconds since the server started.",
        "# TYPE canopy_uptime_seconds gauge",
        `canopy_uptime_seconds ${((Date.now() - started) / 1000).toFixed(3)}`,
        "",
      ].join("\n") +
      canopy.renderMetrics() +
      extra(),
  })
}

async function main(): Promise<void> {
  const loaded = await load()
  let plan: ReturnType<typeof planServerRole>
  try {
    plan = planServerRole(loaded.config, loaded.role, process.env["CANOPY_REALTIME_URL"])
  } catch (error: unknown) {
    if (error instanceof ConfigError) fail(error.message)
    throw error
  }
  const { config } = plan
  const logger = redacting(jsonLogger(config.log.level))
  const runtime = (globalThis as { Bun?: unknown }).Bun === undefined ? "node" : "bun"
  const gateway =
    config.realtime !== false && config.realtime.server === "gateway"
      ? await startGatewayFrontDoor(config, logger, plan.options)
      : undefined
  const canopy = gateway?.canopy ?? (await createCanopy(config, { logger, ...plan.options }))
  const http = gateway ?? (await listenCanopy(canopy, config.server.port))

  const metrics = await metricsServer(canopy, runtime, () => gateway?.metrics() ?? "")
  const admin = await canopy.admin.listen()
  if (admin !== undefined) logger.info({ address: admin.address }, "admin listening")
  const realtime = config.realtime
  logger.info(
    {
      port: http.port,
      role: loaded.role,
      ...(gateway === undefined
        ? {}
        : { realtimeServer: "gateway", upstreamPort: gateway.upstreamPort }),
      metricsPort: (metrics.address() as AddressInfo).port,
      database: config.mongodb.database,
      environment: config.environment,
      rest: config.rest !== false,
      realtime: realtime !== false,
      config: config.file ?? "environment",
      runtime,
      engine: selectEngine(config.server.engine).kind,
    },
    "canopy listening",
  )

  let stopping = false
  void gateway?.exited.then((code) => {
    if (stopping) return
    logger.error({ code }, "canopyd stopped, so the server stops too")
    process.exit(1)
  })
  const shutdown = (signal: string): void => {
    if (stopping) return
    stopping = true
    const drainMs = realtime === false ? 0 : realtime.drainWindowMs
    logger.info({ signal, drainMs }, "draining")
    const stopped =
      gateway?.stop() ??
      canopy
        .close({ drainMs })
        .then(() => admin?.close())
        .then(() => http.stop())
    stopped
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
