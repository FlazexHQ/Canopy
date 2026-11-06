import type { IncomingMessage, ServerResponse } from "node:http"
import { Readable } from "node:stream"
import type { RestHandler } from "./handler.ts"

/**
 * Adapts a {@link RestHandler} to `node:http`, Express, Fastify (through its raw server) and other
 * `(req, res)` servers. Under Express the original URL is used, so `app.use('/rest/v1', listener)` keeps
 * the base path. Mount it before any body parser, which would consume the request body.
 */
export function toNodeListener(
  handler: RestHandler,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    void serveNode(handler, request, response).catch((error: unknown) => {
      if (!response.headersSent) response.statusCode = 500
      response.end()
      request.destroy(error instanceof Error ? error : undefined)
    })
  }
}

async function serveNode(
  handler: RestHandler,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const original = (request as IncomingMessage & { originalUrl?: unknown }).originalUrl
  const path = typeof original === "string" ? original : (request.url ?? "/")
  const host = request.headers.host ?? "localhost"
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const item of value) headers.append(name, item)
    else headers.set(name, value)
  }
  const controller = new AbortController()
  response.once("close", () => {
    if (!response.writableFinished) controller.abort()
  })
  const method = request.method ?? "GET"
  const hasBody = method !== "GET" && method !== "HEAD"
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers,
    signal: controller.signal,
    ...(hasBody
      ? { body: Readable.toWeb(request) as unknown as ReadableStream<Uint8Array>, duplex: "half" }
      : {}),
  }
  const result = await handler.fetch(new Request(new URL(path, `http://${host}`), init))
  response.statusCode = result.status
  result.headers.forEach((value, name) => {
    response.appendHeader(name, value)
  })
  if (result.body === null) {
    response.end()
    return
  }
  const body = new Uint8Array(await result.arrayBuffer())
  response.end(body)
}
