import type { IncomingMessage, Server } from "node:http"
import type { Duplex } from "node:stream"
import { type NodeListener, toNodeListener } from "@canopy/node-http"
import { CloseCode, SUBPROTOCOL } from "@canopy/protocol"
import type { HttpTransport } from "./http-transport.ts"
import type { Realtime } from "./realtime.ts"
import type { RealtimeSocket } from "./session.ts"

/** Options for {@link attach}. */
export interface AttachOptions {
  /** The WebSocket path. Defaults to `/realtime/v1`. */
  readonly path?: string
  /** Interval of protocol level pings that detect half open connections. Defaults to 25 s. */
  readonly pingIntervalMs?: number
  /** Maximum inbound frame size in bytes. Defaults to 256 KiB. */
  readonly maxPayload?: number
}

/** A handle to detach the transport again. */
export interface Attachment {
  close(): Promise<void>
}

function pathOf(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://localhost").pathname
}

/**
 * Mounts the engine on a Node `http` or `https` server through the `ws` package: WebSocket upgrades on
 * `path` with the `canopy.v1+json` subprotocol. Works with Express (`http.createServer(app)`), Fastify
 * (`fastify.server`) and Hono (the server returned by `@hono/node-server`'s `serve`), because each of them
 * runs on a Node server. Other upgrade requests are left alone.
 */
export async function attach(
  realtime: Realtime,
  server: Server,
  options: AttachOptions = {},
): Promise<Attachment> {
  const { WebSocketServer } = await import("ws")
  const path = options.path ?? "/realtime/v1"
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: options.maxPayload ?? 256 * 1024,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
  })
  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (pathOf(request) !== path) return
    wss.handleUpgrade(request, socket, head, (ws) => {
      if (ws.protocol !== SUBPROTOCOL) {
        ws.close(CloseCode.UnsupportedVersion, "unsupported subprotocol")
        return
      }
      const adapter: RealtimeSocket = {
        send: (text) => {
          if (ws.readyState === ws.OPEN) ws.send(text)
        },
        close: (code, reason) => ws.close(code, reason),
        get bufferedAmount() {
          return ws.bufferedAmount
        },
      }
      const connection = realtime.connect(adapter)
      let alive = true
      const ping = setInterval(() => {
        if (!alive) {
          ws.terminate()
          return
        }
        alive = false
        ws.ping()
      }, options.pingIntervalMs ?? 25_000)
      ws.on("pong", () => {
        alive = true
      })
      ws.on("message", (data, isBinary) => {
        if (isBinary) {
          ws.close(CloseCode.ProtocolError, "binary frames are not supported")
          return
        }
        connection.message(
          Array.isArray(data) ? Buffer.concat(data).toString("utf8") : data.toString("utf8"),
        )
      })
      ws.on("close", () => {
        clearInterval(ping)
        connection.close()
      })
      ws.on("error", () => ws.terminate())
    })
  }
  server.on("upgrade", onUpgrade)
  return {
    close: async () => {
      server.off("upgrade", onUpgrade)
      for (const client of wss.clients) client.terminate()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }
}

/** The subset of Bun's `ServerWebSocket` the adapter uses. */
export interface BunSocket<T> {
  readonly data: T
  send(text: string): number
  close(code?: number, reason?: string): void
  getBufferedAmount(): number
}

/** The subset of Bun's `Server` the adapter uses. */
export interface BunServerLike<T> {
  upgrade(request: Request, options: { headers?: Record<string, string>; data: T }): boolean
}

interface BunData {
  connection: ReturnType<Realtime["connect"]> | undefined
}

/**
 * Handlers for `Bun.serve` (the primary runtime). Pass `fetch` and `websocket` to `Bun.serve`; requests to
 * other paths get `404` unless `fallback` handles them.
 */
export function bunHandlers(
  realtime: Realtime,
  options: {
    readonly path?: string
    /** The SSE and long-poll endpoints, served for their paths. */
    readonly http?: HttpTransport
    readonly fallback?: (request: Request) => Response | Promise<Response>
  } = {},
): {
  fetch(request: Request, server: BunServerLike<BunData>): Response | Promise<Response> | undefined
  websocket: {
    maxPayloadLength: number
    open(ws: BunSocket<BunData>): void
    message(ws: BunSocket<BunData>, message: string | Uint8Array): void
    close(ws: BunSocket<BunData>): void
  }
} {
  const path = options.path ?? "/realtime/v1"
  return {
    fetch(request, server) {
      if (options.http?.matches(request) === true) return options.http.fetch(request)
      if (new URL(request.url).pathname !== path) {
        return options.fallback === undefined
          ? new Response("Not found", { status: 404 })
          : options.fallback(request)
      }
      const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
        .split(",")
        .map((p) => p.trim())
      if (!protocols.includes(SUBPROTOCOL))
        return new Response("Unsupported subprotocol", { status: 426 })
      const upgraded = server.upgrade(request, {
        headers: { "Sec-WebSocket-Protocol": SUBPROTOCOL },
        data: { connection: undefined },
      })
      return upgraded ? undefined : new Response("Upgrade failed", { status: 400 })
    },
    websocket: {
      maxPayloadLength: 256 * 1024,
      open(ws) {
        ws.data.connection = realtime.connect({
          send: (text) => {
            ws.send(text)
          },
          close: (code, reason) => ws.close(code, reason),
          get bufferedAmount() {
            return ws.getBufferedAmount()
          },
        })
      },
      message(ws, message) {
        if (typeof message !== "string") {
          ws.close(CloseCode.ProtocolError, "binary frames are not supported")
          return
        }
        ws.data.connection?.message(message)
      },
      close(ws) {
        ws.data.connection?.close()
      },
    },
  }
}

/**
 * Adapts the HTTP fallback transport to `node:http` and Express (`app.use(toNodeHandler(http))`). Requests
 * outside its paths go to `next`, or get `404` without one. Responses are streamed, so SSE works. Mount it
 * before any body parser.
 */
export function toNodeHandler(transport: HttpTransport): NodeListener {
  return toNodeListener((request) => transport.fetch(request), {
    matches: (url) => transport.matches(new Request(url)),
  })
}
