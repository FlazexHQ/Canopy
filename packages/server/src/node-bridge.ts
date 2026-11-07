import type { IncomingMessage, ServerResponse } from "node:http"
import { Readable } from "node:stream"

/** A Web standard handler that also receives the peer address. */
export type PeerFetch = (request: Request, info: { readonly ip?: string }) => Promise<Response>

/**
 * Serves a Web standard handler on `node:http`, streaming the response body (so server sent events flow)
 * and passing the socket's peer address. Forwarded headers are not trusted.
 */
export function nodeBridge(
  handler: PeerFetch,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    void serve(handler, request, response).catch((error: unknown) => {
      if (!response.headersSent) response.statusCode = 500
      response.end()
      request.destroy(error instanceof Error ? error : undefined)
    })
  }
}

async function serve(
  handler: PeerFetch,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const original = (request as IncomingMessage & { originalUrl?: unknown }).originalUrl
  const path = typeof original === "string" ? original : (request.url ?? "/")
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
  const ip = request.socket.remoteAddress
  const result = await handler(
    new Request(new URL(path, `http://${request.headers.host ?? "localhost"}`), init),
    ip === undefined ? {} : { ip },
  )
  response.statusCode = result.status
  result.headers.forEach((value, name) => {
    response.appendHeader(name, value)
  })
  if (result.body === null) {
    response.end()
    return
  }
  response.flushHeaders()
  const reader = result.body.getReader()
  controller.signal.addEventListener("abort", () => {
    reader.cancel().catch(() => {})
  })
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    response.write(value)
  }
  response.end()
}
