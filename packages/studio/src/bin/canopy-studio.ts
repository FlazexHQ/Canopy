#!/usr/bin/env node
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { createStudioHandler } from "../handler.ts"
import { toNodeListener } from "../node.ts"
import { studioService } from "../service.ts"

const USAGE = `Usage: canopy-studio

Serves Canopy Studio as a standalone service on PORT (default 8080), with /healthz for health checks.
Studio talks to the admin API at /admin/v1 on the same origin, so put it behind the same front door as
the Canopy api service.
`

interface BunRuntime {
  serve(options: {
    port: number
    hostname?: string
    fetch(request: Request): Response | Promise<Response>
  }): { readonly port: number; stop(force?: boolean): void }
}

function port(): number {
  const value = Number(process.env["PORT"] ?? "8080")
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    process.stderr.write(`canopy-studio: PORT must be a TCP port\n\n${USAGE}`)
    process.exit(1)
  }
  return value
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write(USAGE)
    return
  }
  const studio = createStudioHandler()
  const fetch = studioService((request) => studio.fetch(request))
  const hostname = process.env["HOST"] ?? "0.0.0.0"
  const bun = (globalThis as { Bun?: BunRuntime }).Bun
  let stop: () => Promise<void>
  let listening: number
  if (bun !== undefined) {
    const server = bun.serve({ port: port(), hostname, fetch })
    listening = server.port
    stop = async () => server.stop(true)
  } else {
    const node = toNodeListener({ ...studio, fetch, matches: () => true })
    const server = createServer(node)
    await new Promise<void>((resolve) => server.listen(port(), hostname, resolve))
    listening = (server.address() as AddressInfo).port
    stop = () => {
      server.closeAllConnections()
      return new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
  process.stdout.write(`${JSON.stringify({ msg: "canopy-studio listening", port: listening })}\n`)
  let stopping = false
  const shutdown = (): void => {
    if (stopping) return
    stopping = true
    stop().then(
      () => process.exit(0),
      () => process.exit(1),
    )
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
  if (process.platform === "win32") process.on("SIGBREAK", shutdown)
}

main().catch((error: unknown) => {
  process.stderr.write(`canopy-studio failed to start: ${String(error)}\n`)
  process.exit(1)
})
