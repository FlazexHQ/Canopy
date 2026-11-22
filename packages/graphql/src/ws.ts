import type { IncomingMessage, Server } from "node:http"
import type { Duplex } from "node:stream"
import { execute, subscribe } from "graphql"
import { makeServer, type ServerOptions } from "graphql-ws"
import type { GraphqlHandler } from "./handler.ts"

function pathOf(request: IncomingMessage): string | undefined {
  try {
    return new URL(request.url ?? "/", "http://localhost").pathname
  } catch {
    return undefined
  }
}

/** The subprotocol of graphql-ws. */
export const GRAPHQL_WS_SUBPROTOCOL = "graphql-transport-ws"

/** A handle to detach graphql-ws from a server again. */
export interface GraphqlWsAttachment {
  close(): Promise<void>
}

function headersOf(
  headers: Headers,
  params: Readonly<Record<string, unknown>> | undefined,
): Headers {
  const merged = new Headers(headers)
  for (const name of ["apikey", "authorization"]) {
    const value = params?.[name] ?? params?.[name.charAt(0).toUpperCase() + name.slice(1)]
    if (typeof value === "string") merged.set(name, value)
  }
  return merged
}

interface UpgradeInfo {
  readonly headers: Headers
  readonly ip?: string
}

function operations<Extra>(
  handler: GraphqlHandler,
  upgradeInfo: (extra: Extra) => UpgradeInfo,
): ServerOptions<undefined | Readonly<Record<string, unknown>>, Extra> {
  return {
    execute,
    subscribe,
    onSubscribe: async (ctx, _id, payload) => {
      const { headers, ip } = upgradeInfo(ctx.extra)
      const request = new Request(`http://localhost${handler.path}`, {
        headers: headersOf(headers, ctx.connectionParams),
      })
      const prepared = await handler.prepare(
        request,
        {
          query: payload.query,
          variables: payload.variables ?? null,
          operationName: payload.operationName ?? null,
          extensions: payload.extensions ?? null,
        },
        ip === undefined ? {} : { ip },
      )
      if (!prepared.ok) return prepared.errors
      return {
        schema: prepared.schema,
        document: prepared.document,
        contextValue: prepared.contextValue,
        ...(prepared.variableValues === undefined
          ? {}
          : { variableValues: prepared.variableValues }),
        ...(prepared.operationName === undefined ? {} : { operationName: prepared.operationName }),
      }
    },
  }
}

function nodeUpgradeInfo({ request }: { request: IncomingMessage }): UpgradeInfo {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.set(name, value)
    else if (Array.isArray(value)) headers.set(name, value.join(", "))
  }
  const ip = request.socket.remoteAddress
  return { headers, ...(ip === undefined ? {} : { ip }) }
}

function offersGraphql(protocols: string): boolean {
  return protocols.split(",").some((value) => value.trim() === GRAPHQL_WS_SUBPROTOCOL)
}

/**
 * Serves GraphQL subscriptions (and queries) over graphql-ws on a Node `http` server, on the handler's
 * path with the `graphql-transport-ws` subprotocol. Browsers cannot set headers on a WebSocket, so the
 * client passes `apikey` and `authorization` in `connectionParams`; they override the upgrade request's
 * headers. Every operation is authenticated, limited and DLS checked exactly like one over HTTP.
 */
export async function attachGraphqlWs(
  handler: GraphqlHandler,
  server: Server,
): Promise<GraphqlWsAttachment> {
  const [{ WebSocketServer }, { useServer }] = await Promise.all([
    import("ws"),
    import("graphql-ws/use/ws"),
  ])
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 256 * 1024,
    handleProtocols: (protocols) =>
      protocols.has(GRAPHQL_WS_SUBPROTOCOL) ? GRAPHQL_WS_SUBPROTOCOL : false,
  })
  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const path = pathOf(request)
    if (path === undefined) {
      socket.destroy()
      return
    }
    if (path !== handler.path) return
    const protocols = String(request.headers["sec-websocket-protocol"] ?? "")
    if (!offersGraphql(protocols)) return
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request))
  }
  server.on("upgrade", onUpgrade)
  const disposable = useServer(operations(handler, nodeUpgradeInfo), wss)
  return {
    async close() {
      server.off("upgrade", onUpgrade)
      await disposable.dispose()
      for (const client of wss.clients) client.terminate()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }
}

/** Metadata retained from the Bun upgrade for GraphQL authentication and rate limits. */
export interface GraphqlBunData {
  readonly graphql: true
  readonly headers: Headers
  readonly ip?: string
}

/** The Bun socket operations used by the GraphQL transport. */
export interface GraphqlBunSocket {
  readonly data: GraphqlBunData
  send(text: string): number
  close(code?: number, reason?: string): void
}

interface BunConnection {
  message(text: string): Promise<void>
  close(code: number, reason: string): Promise<void>
}

/** Builds GraphQL WebSocket handlers to compose with other Bun upgrade routes. */
export function graphqlBunHandlers(handler: GraphqlHandler) {
  const server = makeServer(operations(handler, (info: GraphqlBunData) => info))
  const connections = new Map<GraphqlBunSocket, BunConnection>()
  let closed = false
  return {
    upgrade(
      request: Request,
      server: {
        upgrade(
          request: Request,
          options: { headers: Record<string, string>; data: GraphqlBunData },
        ): boolean
        requestIP?(request: Request): { readonly address: string } | null
      },
    ): Response | undefined {
      if (closed) return new Response("GraphQL is shutting down", { status: 503 })
      if (!offersGraphql(request.headers.get("sec-websocket-protocol") ?? ""))
        return new Response("Unsupported subprotocol", { status: 426 })
      const ip = server.requestIP?.(request)?.address
      const accepted = server.upgrade(request, {
        headers: { "Sec-WebSocket-Protocol": GRAPHQL_WS_SUBPROTOCOL },
        data: {
          graphql: true,
          headers: new Headers(request.headers),
          ...(ip === undefined ? {} : { ip }),
        },
      })
      return accepted ? undefined : new Response("Upgrade failed", { status: 400 })
    },
    websocket: {
      open(ws: GraphqlBunSocket): void {
        if (closed) {
          ws.close(1001, "Going away")
          return
        }
        let message: BunConnection["message"] = async () => {}
        const close = server.opened(
          {
            protocol: GRAPHQL_WS_SUBPROTOCOL,
            send: (text) => {
              ws.send(text)
            },
            close: (code, reason) => ws.close(code, reason),
            onMessage: (callback) => {
              message = callback
            },
          },
          ws.data,
        )
        connections.set(ws, { message, close })
      },
      async message(ws: GraphqlBunSocket, message: string | Uint8Array): Promise<void> {
        if (typeof message !== "string") {
          ws.close(4400, "Expected a text frame")
          return
        }
        try {
          await connections.get(ws)?.message(message)
        } catch {
          ws.close(4500, "Internal server error")
        }
      },
      async close(ws: GraphqlBunSocket, code: number, reason: string): Promise<void> {
        const connection = connections.get(ws)
        connections.delete(ws)
        await connection?.close(code, reason)
      },
    },
    async close(): Promise<void> {
      closed = true
      const sockets = [...connections.keys()]
      await Promise.all(
        sockets.map((ws) => {
          ws.close(1001, "Going away")
          return this.websocket.close(ws, 1001, "Going away")
        }),
      )
    },
  }
}
