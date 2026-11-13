import type { IncomingMessage, ServerResponse } from "node:http"
import { Readable } from "node:stream"

/** What a handler learns about the connection besides the request. */
export interface PeerInfo {
  /** The socket's peer address. Forwarded headers are not trusted here. */
  readonly ip?: string
}

/** A Web standard handler. */
export type FetchHandler = (request: Request, info: PeerInfo) => Promise<Response> | Response

/** A `node:http` listener, also usable as Express middleware. */
export type NodeListener = (
  request: IncomingMessage,
  response: ServerResponse,
  next?: () => void,
) => void

/** Options of {@link toNodeListener}. */
export interface NodeListenerOptions {
  /**
   * Which requests the handler serves. Others go to `next` (Express), or get `404` without one. By default
   * every request is served.
   */
  readonly matches?: (url: URL) => boolean
}

/**
 * The URL of a request; under Express the original URL, so mounting on a path keeps the base path. A `Host`
 * header that does not parse is ignored. Returns `undefined` when the request target itself does not parse
 * (an empty authority such as `//`), which callers answer with `400`.
 */
export function tryRequestUrl(request: IncomingMessage): URL | undefined {
  const original = (request as IncomingMessage & { originalUrl?: unknown }).originalUrl
  const path = typeof original === "string" ? original : (request.url ?? "/")
  return (
    parse(path, `http://${request.headers.host ?? "localhost"}`) ?? parse(path, "http://localhost")
  )
}

/** The path of a request, or `undefined` when its target does not parse. */
export function tryPathname(request: IncomingMessage): string | undefined {
  return parse(request.url ?? "/", "http://localhost")?.pathname
}

function parse(path: string, base: string): URL | undefined {
  try {
    return new URL(path, base)
  } catch {
    return undefined
  }
}

/**
 * Serves a Web standard handler on `node:http` and Express. Request bodies are streamed in and response
 * bodies streamed out (so server sent events flow), every header is kept (several `Set-Cookie` headers
 * included), the handler's signal aborts when the client goes away, and the peer address is passed along.
 * Mount it before any body parser, which would consume the request body.
 */
export function toNodeListener(
  handler: FetchHandler,
  options: NodeListenerOptions = {},
): NodeListener {
  return (request, response, next) => {
    const url = tryRequestUrl(request)
    if (url === undefined) {
      response.statusCode = 400
      response.end("Bad request")
      return
    }
    if (options.matches !== undefined && !options.matches(url)) {
      if (next !== undefined) next()
      else {
        response.statusCode = 404
        response.end("Not found")
      }
      return
    }
    void serve(handler, url, request, response).catch((error: unknown) => {
      if (!response.headersSent) response.statusCode = 500
      response.end()
      request.destroy(error instanceof Error ? error : undefined)
    })
  }
}

/** Copies Node's request headers, keeping repeated headers as separate values. */
export function toHeaders(request: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const item of value) headers.append(name, item)
    else headers.set(name, value)
  }
  return headers
}

async function serve(
  handler: FetchHandler,
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const controller = new AbortController()
  response.once("close", () => {
    if (!response.writableFinished) controller.abort()
  })
  const method = request.method ?? "GET"
  const hasBody = method !== "GET" && method !== "HEAD"
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers: toHeaders(request),
    signal: controller.signal,
    ...(hasBody
      ? { body: Readable.toWeb(request) as unknown as ReadableStream<Uint8Array>, duplex: "half" }
      : {}),
  }
  const ip = request.socket.remoteAddress
  const result = await handler(new Request(url, init), ip === undefined ? {} : { ip })
  response.statusCode = result.status
  result.headers.forEach((value, name) => {
    if (name !== "set-cookie") response.appendHeader(name, value)
  })
  const cookies = result.headers.getSetCookie()
  if (cookies.length > 0) response.setHeader("set-cookie", cookies)
  if (result.body === null || method === "HEAD") {
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
