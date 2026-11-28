import { createServer, type Server } from "node:http"
import { type AddressInfo, connect, type Socket } from "node:net"
import { GraphQLError } from "graphql"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import {
  attachGraphqlWs,
  GRAPHQL_WS_SUBPROTOCOL,
  type GraphqlBunData,
  type GraphqlHandler,
  type GraphqlWsAttachment,
  graphqlBunHandlers,
} from "../src/index.ts"

type Outcome = { readonly kind: "answered"; readonly head: string } | { readonly kind: "closed" }

describe("graphql-ws upgrade routing", () => {
  let server: Server
  let attachment: GraphqlWsAttachment
  let port: number
  const accepted = new Set<Socket>()

  beforeAll(async () => {
    const handler: Pick<GraphqlHandler, "path"> = { path: "/graphql/v1" }
    server = createServer()
    server.on("connection", (socket) => {
      accepted.add(socket)
      socket.on("close", () => accepted.delete(socket))
    })
    attachment = await attachGraphqlWs(handler as GraphqlHandler, server)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    await attachment.close()
    for (const socket of accepted) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  /**
   * Sends a raw upgrade request. An upgrade nobody handles leaves the socket open without an answer, so
   * after `waitMs` without data the socket is closed here and the outcome is `undefined`.
   */
  const upgrade = (target: string, protocol?: string, waitMs = 300) =>
    new Promise<Outcome | undefined>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1")
      let data = ""
      const timer = setTimeout(() => {
        socket.destroy()
        resolve(undefined)
      }, waitMs)
      socket.on("data", (chunk) => {
        data += chunk.toString("latin1")
        if (data.includes("\r\n\r\n")) {
          clearTimeout(timer)
          socket.destroy()
          resolve({ kind: "answered", head: data.slice(0, data.indexOf("\r\n\r\n")) })
        }
      })
      socket.on("close", () => {
        clearTimeout(timer)
        resolve(data === "" ? { kind: "closed" } : { kind: "answered", head: data })
      })
      socket.on("error", reject)
      socket.write(
        [
          `GET ${target} HTTP/1.1`,
          "Host: canopy.test",
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          ...(protocol === undefined ? [] : [`Sec-WebSocket-Protocol: ${protocol}`]),
          "",
          "",
        ].join("\r\n"),
      )
    })

  it("accepts the graphql-ws subprotocol on the handler's path", async () => {
    const outcome = await upgrade("/graphql/v1?x=1", `other, ${GRAPHQL_WS_SUBPROTOCOL}`)
    expect(outcome?.kind).toBe("answered")
    const head = outcome?.kind === "answered" ? outcome.head : ""
    expect(head.split("\r\n")[0]).toBe("HTTP/1.1 101 Switching Protocols")
    expect(head.toLowerCase()).toContain(`sec-websocket-protocol: ${GRAPHQL_WS_SUBPROTOCOL}`)
  })

  it("leaves other paths and other subprotocols to other upgrade handlers", async () => {
    expect(await upgrade("/realtime/v1", GRAPHQL_WS_SUBPROTOCOL)).toBeUndefined()
    expect(await upgrade("/graphql/v1", "canopy.v1+json")).toBeUndefined()
    expect(await upgrade("/graphql/v1")).toBeUndefined()
  })

  it("closes an upgrade whose URL cannot be parsed", async () => {
    expect(await upgrade("http://[::1", GRAPHQL_WS_SUBPROTOCOL, 2000)).toEqual({ kind: "closed" })
  })
})

describe("graphql-ws on the Bun transport", () => {
  it("authenticates operations with connection parameters and closes active sockets", async () => {
    const prepare = vi.fn<GraphqlHandler["prepare"]>().mockResolvedValue({
      ok: false,
      errors: [new GraphQLError("Invalid credentials")],
    })
    const handler: Pick<GraphqlHandler, "path" | "prepare"> = { path: "/graphql/v1", prepare }
    const transport = graphqlBunHandlers(handler as GraphqlHandler)
    const request = new Request("http://canopy.test/graphql/v1", {
      headers: {
        apikey: "upgrade-key",
        authorization: "Bearer upgrade-token",
        "sec-websocket-protocol": GRAPHQL_WS_SUBPROTOCOL,
      },
    })
    const upgrade = vi.fn<(_request: Request, options: { data: GraphqlBunData }) => boolean>()
    const server = { upgrade, requestIP: () => ({ address: "192.0.2.12" }) }
    expect(transport.upgrade(new Request(request.url), server)?.status).toBe(426)
    expect(upgrade).not.toHaveBeenCalled()
    upgrade.mockReturnValueOnce(false)
    expect(transport.upgrade(request, server)?.status).toBe(400)
    upgrade.mockReturnValueOnce(true)
    expect(transport.upgrade(request, server)).toBeUndefined()
    const data = upgrade.mock.calls[1]?.[1].data
    if (data === undefined) throw new Error("Upgrade metadata is missing")
    expect(upgrade).toHaveBeenLastCalledWith(request, {
      headers: { "Sec-WebSocket-Protocol": GRAPHQL_WS_SUBPROTOCOL },
      data: expect.objectContaining({ graphql: true, ip: "192.0.2.12" }),
    })
    const ws = { data, send: vi.fn<(text: string) => number>(), close: vi.fn() }
    try {
      transport.websocket.open(ws)
      await transport.websocket.message(
        ws,
        JSON.stringify({ type: "connection_init", payload: { Apikey: "socket-key" } }),
      )
      await transport.websocket.message(
        ws,
        JSON.stringify({
          id: "1",
          type: "subscribe",
          payload: { query: "{ __typename }" },
        }),
      )
      expect(ws.send.mock.calls.map(([text]) => JSON.parse(text))).toEqual([
        { type: "connection_ack" },
        { id: "1", type: "error", payload: [{ message: "Invalid credentials" }] },
      ])
      expect(prepare).toHaveBeenCalledExactlyOnceWith(
        expect.any(Request),
        { query: "{ __typename }", variables: null, operationName: null, extensions: null },
        { ip: "192.0.2.12" },
      )
      const prepared = prepare.mock.calls[0]?.[0]
      expect(prepared?.headers.get("apikey")).toBe("socket-key")
      expect(prepared?.headers.get("authorization")).toBe("Bearer upgrade-token")
      await transport.websocket.message(ws, new Uint8Array([0]))
      expect(ws.close).toHaveBeenCalledWith(4400, "Expected a text frame")
    } finally {
      await transport.close()
    }
    expect(ws.close).toHaveBeenLastCalledWith(1001, "Going away")
    expect(transport.upgrade(request, server)?.status).toBe(503)
  })
})
