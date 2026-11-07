import type { IncomingMessage, ServerResponse } from "node:http"
import { createMockAdmin, type MockAdmin } from "../mock/admin.ts"

let mock: MockAdmin | undefined

/** Bridges a Node request to the mock admin API and streams the answer, SSE included. */
export async function serveMock(
  admin: MockAdmin,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`)
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.set(name, value)
    else if (Array.isArray(value)) headers.set(name, value.join(", "))
  }
  const chunks: Buffer[] = []
  if (request.method !== "GET" && request.method !== "HEAD") {
    for await (const chunk of request) chunks.push(chunk as Buffer)
  }
  const abort = new AbortController()
  response.on("close", () => abort.abort())
  const answer = await admin.fetch(
    new Request(url, {
      method: request.method ?? "GET",
      headers,
      signal: abort.signal,
      ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
    }),
  )
  response.statusCode = answer.status
  answer.headers.forEach((value, name) => {
    response.setHeader(name, value)
  })
  if (answer.body === null) {
    response.end()
    return
  }
  response.flushHeaders()
  const reader = answer.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      response.write(value)
    }
  } catch {
    // The client went away.
  }
  response.end()
}

/** The Vite dev server entry (`vite --mode mock`): one shared mock with demo data and a ready owner. */
export function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  mock ??= createMockAdmin({
    tailIntervalMs: 2000,
    admins: [
      {
        id: "adm_owner",
        email: "owner@example.com",
        role: "owner",
        totp: false,
        password: "correct horse battery",
      },
    ],
  })
  return serveMock(mock, request, response)
}
