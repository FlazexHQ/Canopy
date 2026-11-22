import { createServer, type RequestListener, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import type { Canopy } from "./canopy.ts"

interface BunRuntime {
  serve(options: Record<string, unknown>): { readonly port: number; stop(force?: boolean): void }
}

/** An HTTP listener bound for a Canopy instance. */
export interface Listening {
  readonly port: number
  stop(): Promise<void>
}

/** Binds Canopy to HTTP using the current runtime. */
export async function listenCanopy(
  canopy: Canopy,
  port: number,
  hostname?: string,
): Promise<Listening> {
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
  return listenNode(canopy.node(), port, hostname, canopy.attach)
}

/** Binds a Node HTTP listener, with optional WebSocket attachments. */
export async function listenNode(
  handler: RequestListener,
  port: number,
  hostname?: string,
  attach?: (server: Server) => Promise<void>,
): Promise<Listening> {
  const server = createServer(handler)
  await attach?.(server)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, hostname, () => {
      server.off("error", reject)
      resolve()
    })
  })
  return {
    port: (server.address() as AddressInfo).port,
    stop: () => {
      server.closeAllConnections()
      return new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
