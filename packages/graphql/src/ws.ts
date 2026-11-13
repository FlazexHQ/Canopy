import type { IncomingMessage, Server } from "node:http"
import type { Duplex } from "node:stream"
import type { GraphQLError } from "graphql"
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
  request: IncomingMessage,
  params: Readonly<Record<string, unknown>> | undefined,
): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.set(name, value)
    else if (Array.isArray(value)) headers.set(name, value.join(", "))
  }
  for (const name of ["apikey", "authorization"]) {
    const value = params?.[name] ?? params?.[name.charAt(0).toUpperCase() + name.slice(1)]
    if (typeof value === "string") headers.set(name, value)
  }
  return headers
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
  const [{ WebSocketServer }, { useServer }, { execute, subscribe }] = await Promise.all([
    import("ws"),
    import("graphql-ws/use/ws"),
    import("graphql"),
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
    if (!protocols.split(",").some((value) => value.trim() === GRAPHQL_WS_SUBPROTOCOL)) return
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request))
  }
  server.on("upgrade", onUpgrade)
  const disposable = useServer(
    {
      execute: (args) => execute(args),
      subscribe: (args) => subscribe(args),
      onSubscribe: async (ctx, _id, payload) => {
        const request = new Request(`http://localhost${handler.path}`, {
          headers: headersOf(
            ctx.extra.request,
            ctx.connectionParams as Readonly<Record<string, unknown>> | undefined,
          ),
        })
        const prepared = await handler.prepare(request, {
          query: payload.query,
          variables: payload.variables ?? null,
          operationName: payload.operationName ?? null,
          extensions: payload.extensions ?? null,
        })
        if (!prepared.ok) return prepared.errors as readonly GraphQLError[]
        return {
          schema: prepared.schema,
          document: prepared.document,
          contextValue: prepared.contextValue,
          ...(prepared.variableValues === undefined
            ? {}
            : { variableValues: prepared.variableValues }),
          ...(prepared.operationName === undefined
            ? {}
            : { operationName: prepared.operationName }),
        }
      },
    },
    wss,
  )
  return {
    async close() {
      server.off("upgrade", onUpgrade)
      await disposable.dispose()
      for (const client of wss.clients) client.terminate()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }
}
