import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http"
import { type AddressInfo, connect } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { type NodeListener, toNodeListener, tryPathname, tryRequestUrl } from "../src/index.ts"

const servers: Server[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

async function serve(
  listener: NodeListener,
  next?: (response: ServerResponse) => void,
): Promise<string> {
  const server = createServer((request, response) =>
    next === undefined
      ? listener(request, response)
      : listener(request, response, () => next(response)),
  )
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function raw(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: IncomingMessage["headers"]; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      url,
      { method: init.method ?? "GET", headers: init.headers },
      (res) => {
        let body = ""
        res.setEncoding("utf8")
        res.on("data", (chunk: string) => {
          body += chunk
        })
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      },
    )
    outgoing.on("error", reject)
    outgoing.end(init.body)
  })
}

describe("toNodeListener", () => {
  it("keeps every Set-Cookie header and repeated request headers", async () => {
    let seen: string | null = null
    const base = await serve(
      toNodeListener((request) => {
        seen = request.headers.get("x-many")
        const headers = new Headers({ "content-type": "text/plain" })
        headers.append("set-cookie", "a=1; Path=/")
        headers.append("set-cookie", "b=2; Path=/")
        return new Response("ok", { headers })
      }),
    )
    const response = await raw(base, { headers: { "x-many": "one" } })
    expect(response.status).toBe(200)
    expect(response.headers["set-cookie"]).toEqual(["a=1; Path=/", "b=2; Path=/"])
    expect(response.headers["content-type"]).toBe("text/plain")
    expect(response.body).toBe("ok")
    expect(seen).toBe("one")
  })

  it("streams request bodies in and passes the method, URL and peer address", async () => {
    const base = await serve(
      toNodeListener(async (request, info) =>
        Response.json({
          method: request.method,
          path: new URL(request.url).pathname + new URL(request.url).search,
          body: await request.text(),
          ip: info.ip,
        }),
      ),
    )
    const response = await raw(`${base}/a/b?x=1`, { method: "POST", body: "hello" })
    expect(JSON.parse(response.body)).toEqual({
      method: "POST",
      path: "/a/b?x=1",
      body: "hello",
      ip: "127.0.0.1",
    })
  })

  it("streams response bodies chunk by chunk, so server sent events flow", async () => {
    let release: (() => void) | undefined
    const base = await serve(
      toNodeListener(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              async start(controller) {
                controller.enqueue(new TextEncoder().encode("data: first\n\n"))
                await new Promise<void>((resolve) => (release = resolve))
                controller.enqueue(new TextEncoder().encode("data: second\n\n"))
                controller.close()
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      ),
    )
    const first = await new Promise<string>((resolve, reject) => {
      const outgoing = httpRequest(base, (res) => {
        res.setEncoding("utf8")
        let text = ""
        res.on("data", (chunk: string) => {
          text += chunk
          if (text === "data: first\n\n") {
            resolve(text)
            release?.()
          }
        })
      })
      outgoing.on("error", reject)
      outgoing.end()
    })
    expect(first).toBe("data: first\n\n")
  })

  it("aborts the handler's signal when the client goes away", async () => {
    let aborted: Promise<void> | undefined
    const base = await serve(
      toNodeListener((request) => {
        aborted = new Promise((resolve) =>
          request.signal.addEventListener("abort", () => resolve()),
        )
        return new Response(new ReadableStream({ start() {} }))
      }),
    )
    await new Promise<void>((resolve) => {
      const outgoing = httpRequest(base, (res) => {
        res.once("data", () => {})
        outgoing.destroy()
        resolve()
      })
      outgoing.end()
    })
    await expect(aborted).resolves.toBeUndefined()
  })

  it("hands requests it does not serve to next, or answers 404 without one", async () => {
    const listener = toNodeListener(() => new Response("mine"), {
      matches: (url) => url.pathname.startsWith("/studio"),
    })
    let passed = 0
    const withNext = await serve(listener, (response) => {
      passed += 1
      response.end("next")
    })
    expect((await raw(`${withNext}/studio/x`)).body).toBe("mine")
    expect(passed).toBe(0)
    expect((await raw(`${withNext}/other`)).body).toBe("next")
    expect(passed).toBe(1)
    const alone = await serve(listener)
    const refused = await raw(`${alone}/other`)
    expect(refused.status).toBe(404)
    expect((await raw(`${alone}/studio`)).body).toBe("mine")
  })

  it("answers 500 when the handler throws", async () => {
    const base = await serve(
      toNodeListener(() => {
        throw new Error("boom")
      }),
    )
    expect((await raw(base)).status).toBe(500)
  })

  it("uses Express's original URL, so a mounted listener sees its base path", async () => {
    let path = ""
    const listener = toNodeListener((request) => {
      path = new URL(request.url).pathname
      return new Response(null, { status: 204 })
    })
    const base = await serve((request, response) => {
      Object.assign(request, { originalUrl: `/rest/v1${request.url ?? ""}` })
      listener(request, response)
    })
    expect((await raw(`${base}/todos`)).status).toBe(204)
    expect(path).toBe("/rest/v1/todos")
  })
})

function rawRequest(base: string, text: string): Promise<string> {
  const { port } = new URL(base)
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), "127.0.0.1", () => socket.end(text))
    let received = ""
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => {
      received += chunk
    })
    socket.on("end", () => resolve(received))
    socket.on("error", reject)
  })
}

describe("unparsable request targets", () => {
  const ok: NodeListener = toNodeListener(() => new Response("served"))

  it("answers 400 to a target of // and keeps serving", async () => {
    const base = await serve(ok)
    const answer = await rawRequest(
      base,
      "GET // HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
    )
    expect(answer.startsWith("HTTP/1.1 400")).toBe(true)
    const after = await raw(`${base}/`)
    expect(after.status).toBe(200)
    expect(after.body).toBe("served")
  })

  it("survives an empty Host header", async () => {
    const base = await serve(ok)
    const answer = await rawRequest(base, "GET / HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n")
    expect(answer).toMatch(/^HTTP\/1\.1 (200|400)/)
    expect((await raw(`${base}/`)).status).toBe(200)
  })

  it("answers 400 without consulting matches or next", async () => {
    let consulted = false
    const listener = toNodeListener(() => new Response("served"), {
      matches: () => {
        consulted = true
        return true
      },
    })
    const base = await serve(listener, (response) => {
      response.statusCode = 299
      response.end()
    })
    const answer = await rawRequest(
      base,
      "GET // HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
    )
    expect(answer.startsWith("HTTP/1.1 400")).toBe(true)
    expect(consulted).toBe(false)
  })
})

describe("tryPathname", () => {
  it("returns the path of a request, or undefined when the target does not parse", () => {
    expect(tryPathname({ url: "/a/b?c=1", headers: {} } as IncomingMessage)).toBe("/a/b")
    expect(tryPathname({ url: "//", headers: {} } as IncomingMessage)).toBeUndefined()
    expect(tryPathname({ headers: {} } as IncomingMessage)).toBe("/")
  })

  it("ignores a Host header that does not parse", () => {
    expect(
      tryRequestUrl({ url: "/x", headers: { host: "a b" } } as IncomingMessage)?.pathname,
    ).toBe("/x")
  })
})
