import type { IncomingMessage, ServerResponse } from "node:http"
import type { StudioHandler } from "./handler.ts"

/**
 * Adapts a {@link StudioHandler} to `node:http` and Express. Requests outside the base path go to `next`
 * (404 without one).
 */
export function toNodeListener(
  handler: StudioHandler,
): (request: IncomingMessage, response: ServerResponse, next?: () => void) => void {
  return (request, response, next) => {
    const host = request.headers.host ?? "localhost"
    const url = new URL(request.url ?? "/", `http://${host}`)
    if (!handler.matches(url.pathname)) {
      if (next !== undefined) return next()
      response.statusCode = 404
      response.end("Not found")
      return
    }
    const headers = new Headers()
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === "string") headers.set(name, value)
      else if (Array.isArray(value)) headers.set(name, value.join(", "))
    }
    const method = request.method ?? "GET"
    handler
      .fetch(new Request(url, { method, headers }))
      .then(async (answer) => {
        response.statusCode = answer.status
        answer.headers.forEach((value, name) => {
          response.setHeader(name, value)
        })
        response.end(answer.body === null ? undefined : new Uint8Array(await answer.arrayBuffer()))
      })
      .catch(() => {
        if (!response.headersSent) response.statusCode = 500
        response.end()
      })
  }
}
