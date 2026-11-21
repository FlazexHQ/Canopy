#!/usr/bin/env node
import { createServer, type Server } from "node:http"
import { type AddressInfo, createServer as createNetServer } from "node:net"
import { amendConfig, ConfigError, type ResolvedConfig } from "@canopy/config"
import { loadConfig } from "@canopy/config/load"
import {
  type BinaryArgs,
  jsonLogger,
  onShutdown,
  parseBinaryArgs,
  UsageError,
} from "@canopy/config/process"
import { serveMetrics } from "@canopy/node-http"
import { type GatewayOverrides, type Logger, redacting, startGateway } from "@canopy/realtime"
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

async function listen(canopy: Canopy, port: number, hostname?: string): Promise<Listening> {
  const bun = (globalThis as { Bun?: BunRuntime }).Bun
  if (bun !== undefined) {
    const server = bun.serve({
      port,
      ...(hostname === undefined ? {} : { hostname }),
      ...canopy.bun(),
    })
    return {
      port: server.port,
      stop: async () => server.stop(true),
    }
  }
  const server = createServer(canopy.node())
  await canopy.attach(server)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    if (hostname === undefined) server.listen(port, () => resolve())
    else server.listen(port, hostname, () => resolve())
  })
  return {
    port: (server.address() as AddressInfo).port,
    stop: () => {
      server.closeAllConnections()
      return new Promise<void>((resolve) => server.close(() => resolve()))
    },
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

/** Whether `canopy-gateway` answers realtime and the public port, in front of this process. */
function gatewayMode(config: ResolvedConfig): boolean {
  return config.realtime !== false && config.realtime.server === "gateway"
}

/**
 * The config this process runs with behind the gateway: requests arrive from loopback with the client in
 * `X-Forwarded-For`, which the rate limits and the admin allowlist must believe.
 */
function behindGateway(config: ResolvedConfig): ResolvedConfig {
  return amendConfig(config, {
    server: {
      ...config.server,
      trustedProxies: [...config.server.trustedProxies, "127.0.0.1", "::1"],
    },
  })
}

/** The gateway's settings when it is the front door of a server listening on loopback at `port`. */
function frontDoor(canopy: Canopy, port: number, metricsPort: number): GatewayOverrides {
  const local = `http://127.0.0.1:${port}`
  const verification = canopy.auth?.verification
  const audience = verification?.audience
  return {
    port: canopy.config.server.port,
    metricsPort,
    metricsHost: "127.0.0.1",
    proxyUrl: local,
    ...(canopy.config.rest === false ? {} : { mutationsUrl: `${local}/rest/v1` }),
    ...(verification === undefined
      ? {}
      : {
          auth: {
            issuer: Array.isArray(verification.issuer)
              ? String(verification.issuer[0])
              : String(verification.issuer),
            audience: Array.isArray(audience) ? String(audience[0]) : String(audience),
            jwksUrl: `${local}/auth/v1/jwks`,
            algorithms: verification.algorithms ?? ["EdDSA", "ES256"],
            rolesClaim: verification.rolesClaim ?? "roles",
          },
        }),
  }
}

/** A port that was free on loopback a moment ago. */
function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo
      server.close(() => resolve(port))
    })
  })
}

async function startFrontDoor(
  config: ResolvedConfig,
  canopy: Canopy,
  logger: Logger,
  port: number,
) {
  const metricsPort = await freeLoopbackPort()
  const gateway = await startGateway(config, logger, frontDoor(canopy, port, metricsPort))
  const bound = await gateway.listening
  if (bound === undefined)
    throw new Error(`canopy-gateway exited with code ${await gateway.exited} before it listened`)
  let metrics = ""
  const token = canopy.config.server.metricsToken
  const scrape = (): void => {
    fetch(`http://127.0.0.1:${metricsPort}/metrics`, {
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2000),
    })
      .then((response) => (response.ok ? response.text() : ""))
      .then(
        (text) => {
          metrics = text
        },
        () => {
          metrics = ""
        },
      )
  }
  scrape()
  const timer = setInterval(scrape, 1000)
  timer.unref()
  return {
    ...gateway,
    port: bound,
    /** The gateway's latest metrics, scraped every second, for the server's metrics endpoint. */
    metrics: () => metrics,
    stop() {
      clearInterval(timer)
      gateway.stop()
    },
  }
}

async function main(): Promise<void> {
  const loaded = await load()
  const gatewayed = gatewayMode(loaded)
  const config = gatewayed ? behindGateway(loaded) : loaded
  const logger = redacting(jsonLogger(config.log.level))
  const runtime = (globalThis as { Bun?: unknown }).Bun === undefined ? "node" : "bun"
  let gatewayUrl = ""
  const canopy = await createCanopy(config, {
    logger,
    ...(gatewayed ? { gatewayUrl: () => gatewayUrl } : {}),
  })
  const http = gatewayed
    ? await listen(canopy, 0, "127.0.0.1")
    : await listen(canopy, config.server.port)
  const gateway = gatewayed ? await startFrontDoor(loaded, canopy, logger, http.port) : undefined
  if (gateway !== undefined) gatewayUrl = `http://127.0.0.1:${gateway.port}`

  const metrics = await metricsServer(canopy, runtime, () => gateway?.metrics() ?? "")
  const admin = await canopy.admin.listen()
  if (admin !== undefined) logger.info({ address: admin.address }, "admin listening")
  const realtime = config.realtime
  logger.info(
    {
      port: gateway === undefined ? http.port : gateway.port,
      ...(gateway === undefined ? {} : { realtimeServer: "gateway", upstreamPort: http.port }),
      metricsPort: (metrics.address() as AddressInfo).port,
      database: config.mongodb.database,
      environment: config.environment,
      rest: config.rest !== false,
      realtime: realtime !== false,
      config: config.file ?? "environment",
      runtime,
      engine: config.server.engine,
    },
    "canopy listening",
  )

  let stopping = false
  void gateway?.exited.then((code) => {
    if (stopping) return
    logger.error({ code }, "canopy-gateway stopped, so the server stops too")
    process.exit(1)
  })
  const stopGateway = async (): Promise<void> => {
    if (gateway === undefined) return
    gateway.stop()
    await gateway.exited
  }
  const shutdown = (signal: string): void => {
    if (stopping) return
    stopping = true
    const drainMs = realtime === false ? 0 : realtime.drainWindowMs
    logger.info({ signal, drainMs }, "draining")
    stopGateway()
      .then(() => canopy.close({ drainMs }))
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
