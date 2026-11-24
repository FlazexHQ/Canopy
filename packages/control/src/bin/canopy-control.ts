#!/usr/bin/env node
import { loadConfig } from "@canopy/config/load"
import {
  jsonLogger,
  onShutdown,
  parseBinaryArgs,
  type ShutdownReason,
  UsageError,
} from "@canopy/config/process"
import { serveMetrics } from "@canopy/node-http"
import { redacting } from "@canopy/realtime"
import { listenCanopy } from "@canopy/server"
import { createControlPlane } from "../index.ts"

const USAGE = `Usage: canopy-control [--config <file>]

Starts the Canopy control plane with auth, the admin API, webhooks, health and metrics.
At startup it migrates the meta database and publishes policies from the configured folder.
Set CANOPY_PUBLISH_POLICIES=off to manage published policies separately.

Options:
  --config <file>  The config file. Defaults to the same lookup as canopy-server.
  --help           Prints this message.
`

async function main(): Promise<void> {
  const args = parseBinaryArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(USAGE)
    return
  }
  const { config } = await loadConfig({
    command: "start",
    ...(args.file === undefined ? {} : { file: args.file }),
  })
  const logger = redacting(jsonLogger(config.log.level))
  const shutdown = Promise.withResolvers<ShutdownReason>()
  const removeShutdownListeners = onShutdown(shutdown.resolve)
  try {
    await using control = await createControlPlane(config, {
      logger,
      ...(process.env["CANOPY_PUBLISH_POLICIES"] === "off" ? { policyDir: false } : {}),
    })
    const http = await listenCanopy(control, config.server.port)
    try {
      const { metricsPort, metricsHost, metricsToken, nodeId } = config.server
      const started = Date.now()
      const runtime = "Bun" in globalThis ? "bun" : "node"
      await using metrics = await serveMetrics({
        port: metricsPort,
        host: metricsHost,
        token: metricsToken,
        render: () =>
          [
            "# HELP canopy_build_info Canopy server process information.",
            "# TYPE canopy_build_info gauge",
            `canopy_build_info{runtime="${runtime}",node_id="${nodeId}"} 1`,
            "# HELP canopy_uptime_seconds Seconds since the server started.",
            "# TYPE canopy_uptime_seconds gauge",
            `canopy_uptime_seconds ${((Date.now() - started) / 1000).toFixed(3)}`,
            "",
          ].join("\n") + control.renderMetrics(),
      })
      const admin = await control.admin.listen()
      if (admin !== undefined) logger.info({ address: admin.address }, "admin listening")
      logger.info(
        { port: http.port, metrics: metrics.address(), database: config.mongodb.database },
        "canopy control listening",
      )
      const signal = await shutdown.promise
      logger.info({ signal }, "stopping canopy control")
    } finally {
      await http.stop()
    }
  } finally {
    removeShutdownListeners()
  }
}

main().catch((error: unknown) => {
  if (error instanceof UsageError)
    process.stderr.write(`canopy-control: ${error.message}\n\n${USAGE}`)
  else jsonLogger("error").error({ err: error }, "canopy control failed")
  process.exit(1)
})
