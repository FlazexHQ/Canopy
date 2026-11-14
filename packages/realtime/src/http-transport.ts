import { CloseCode, ErrorCode, httpStatusOf, isErrorCode } from "@canopy/protocol"
import type { ConnectionHandler, Realtime } from "./realtime.ts"
import type { RealtimeSocket } from "./session.ts"

/** Options for {@link createHttpTransport}. */
export interface HttpTransportOptions {
  /** The realtime base path. Defaults to `/realtime/v1`. */
  readonly basePath?: string
  /** The node prefix of session IDs; requests for another node get `409 CANOPY_SESSION_MOVED`. */
  readonly nodeId?: string
  /** Largest accepted request body. Defaults to 1 MiB. */
  readonly maxBodyBytes?: number
  /** Bytes of delivered frames kept so a dropped stream or poll can be retried. Defaults to 1 MiB. */
  readonly retainBytes?: number
  /** Longest long-poll wait in seconds. Defaults to 30. */
  readonly maxWaitSeconds?: number
  /** Interval of SSE keepalive comments, which stop proxies from closing idle streams. Defaults to 15 s. */
  readonly keepAliveMs?: number
  /** How long a closed session still answers with its close code. Defaults to 60 s. */
  readonly closedRetentionMs?: number
  /** Origins allowed to call the endpoints from a browser on another origin. */
  readonly cors?: { readonly origins: "*" | readonly string[] }
}

/** The SSE, long-poll and ticket endpoints as a Web standard `fetch` handler. */
export interface HttpTransport {
  /** Whether the request belongs to this transport. */
  matches(request: Request): boolean
  /** `info.ip` is the socket peer, which the rate limits turn into the client address. */
  fetch(request: Request, info?: { readonly ip?: string }): Promise<Response>
  /** Closes every HTTP session. */
  close(): void
}

interface Entry {
  readonly seq: number | undefined
  readonly text: string
  delivered: boolean
}

interface Ticket {
  readonly sid: string
  readonly expiresAt: number
}

const SESSION_PATH = /^\/sessions\/([^/]+)(?:\/(events|messages|poll|tickets))?$/
const CLIENT_TYPES = new Set(["sub", "unsub", "mut", "auth", "ping"])
const HELLO_TIMEOUT_MS = 15_000
const encoder = new TextEncoder()

function randomToken(): string {
  const bytes = new Uint8Array(24)
  globalThis.crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")
}

function statusOfClose(code: number): number {
  switch (code) {
    case CloseCode.Unauthorized:
      return 401
    case CloseCode.Forbidden:
      return 403
    case CloseCode.RateLimited:
      return 429
    case CloseCode.UnsupportedVersion:
    case CloseCode.ProtocolError:
    case CloseCode.FrameTooLarge:
      return 400
    case CloseCode.Normal:
      return 410
    default:
      return 503
  }
}

function problem(status: number, code: ErrorCode, detail: string, close?: number): Response {
  return new Response(
    JSON.stringify({
      type: `urn:canopy:error:${code.slice("CANOPY_".length).toLowerCase().replaceAll("_", "-")}`,
      title: detail,
      status,
      code,
      detail,
      ...(close === undefined ? {} : { close }),
    }),
    { status, headers: { "content-type": "application/problem+json" } },
  )
}

async function readText(request: Request, limit: number): Promise<string | undefined> {
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (declared > limit) return undefined
  const reader = request.body?.getReader()
  if (reader === undefined) return ""
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      return undefined
    }
    chunks.push(value)
  }
  const all = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    all.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(all)
}

function bearer(request: Request): string | undefined {
  const header = request.headers.get("authorization")
  if (header === null) return undefined
  return /^Bearer\s+(.+)$/i.exec(header.trim())?.[1]
}

/**
 * One fallback session: a realtime connection whose frames are buffered until an SSE stream or a poll
 * picks them up. Delivered frames stay until the client acknowledges them (`after` on a poll,
 * `Last-Event-ID` on a stream) or the retention budget runs out, so a broken stream can be retried
 * without loss.
 */
class HttpSession {
  sid = ""
  readonly key: string
  readonly connection: ConnectionHandler
  readonly entries: Entry[] = []
  pending = 0
  retained = 0
  /** The highest sequence number no longer held. */
  floor = 0
  closed: { readonly code: number; readonly reason: string } | undefined
  closedAt = 0
  /** Wakes the stream or poll waiting for frames. */
  wake: (() => void) | undefined
  /** Ends the attached SSE stream. */
  stopStream: (() => void) | undefined
  readonly first: Promise<string | undefined>
  private firstFrame: ((text: string | undefined) => void) | undefined
  private readonly retainBytes: number

  constructor(realtime: Realtime, key: string, retainBytes: number, address: string | undefined) {
    this.key = key
    this.retainBytes = retainBytes
    this.first = new Promise((resolve) => {
      this.firstFrame = resolve
    })
    const pendingBytes = (): number => this.pending
    const socket: RealtimeSocket = {
      send: (text) => this.push(text),
      close: (code, reason) => this.end(code, reason),
      get bufferedAmount() {
        return pendingBytes()
      },
    }
    this.connection = realtime.connect(socket, address === undefined ? {} : { address })
  }

  private push(text: string): void {
    if (this.closed !== undefined) return
    let parsed: { t?: unknown; seq?: unknown }
    try {
      parsed = JSON.parse(text) as { t?: unknown; seq?: unknown }
    } catch {
      return
    }
    if (this.firstFrame !== undefined && parsed.t === "welcome") {
      const resolve = this.firstFrame
      this.firstFrame = undefined
      resolve(text)
      return
    }
    const seq = typeof parsed.seq === "number" && parsed.t !== "err" ? parsed.seq : undefined
    this.entries.push({ seq, text, delivered: false })
    this.pending += text.length
    this.wake?.()
  }

  end(code: number, reason: string): void {
    if (this.closed !== undefined) return
    this.closed = { code, reason }
    this.closedAt = Date.now()
    this.firstFrame?.(undefined)
    this.firstFrame = undefined
    this.wake?.()
    queueMicrotask(() => this.connection.close())
  }

  /**
   * The frames for a client positioned at `after`: every held frame with a higher sequence number, after
   * dropping the ones it acknowledged. Without a position, the frames not delivered yet.
   */
  select(after: number | undefined): Entry[] {
    if (after !== undefined) this.acknowledge(after)
    return this.entries.filter((entry) =>
      entry.seq === undefined || after === undefined ? !entry.delivered : entry.seq > after,
    )
  }

  /** Whether frames after `after` are no longer held, so they cannot be delivered again. */
  lost(after: number): boolean {
    return after < this.floor
  }

  markDelivered(entries: readonly Entry[]): void {
    for (const entry of entries) {
      if (entry.delivered) continue
      entry.delivered = true
      this.pending -= entry.text.length
      if (entry.seq !== undefined) this.retained += entry.text.length
    }
    this.entries.splice(
      0,
      this.entries.length,
      ...this.entries.filter((entry) => !entry.delivered || entry.seq !== undefined),
    )
    while (this.retained > this.retainBytes) {
      const head = this.entries[0]
      if (head === undefined || !head.delivered) break
      this.entries.shift()
      this.drop(head)
    }
  }

  private acknowledge(after: number): void {
    for (const entry of this.entries) {
      if (entry.seq !== undefined && entry.seq <= after && !entry.delivered) {
        entry.delivered = true
        this.pending -= entry.text.length
        this.retained += entry.text.length
      }
    }
    while (this.entries.length > 0) {
      const head = this.entries[0]
      if (head === undefined || !head.delivered) break
      if (head.seq !== undefined && head.seq > after) break
      this.entries.shift()
      this.drop(head)
    }
  }

  private drop(entry: Entry): void {
    if (entry.seq === undefined) return
    this.retained -= entry.text.length
    this.floor = Math.max(this.floor, entry.seq)
  }
}

/**
 * The fallback transports of `canopy.v1` for networks that block WebSockets: SSE with POST and
 * long-polling, both on top of {@link Realtime.connect}. Mount `fetch` on the same origin as the
 * WebSocket endpoint (`bunHandlers(realtime, { http })` or `toNodeHandler(transport)`).
 *
 * `POST {base}/sessions` takes the `hello` payload, with the key in `apikey` and the token in
 * `Authorization`, and answers with `welcome`. `GET {base}/sessions/{sid}/events` streams
 * `text/event-stream`; each event's `id` is its `seq`, so `Last-Event-ID` resumes.
 * `GET …/poll?after={seq}&wait=25` answers with a JSON array. `POST …/messages` takes a JSON array of
 * `sub`, `unsub`, `mut`, `auth` and `ping`. `DELETE {base}/sessions/{sid}` is `bye`.
 * `POST {base}/sessions/{sid}/tickets` (or `POST {base}/tickets` with `{ "sid" }`) issues a single use
 * ticket, valid for 30 s, for `EventSource`, which cannot send headers.
 *
 * Sessions live in the memory of the node that opened them, and their IDs start with the node ID
 * (`n1.…`), so with several nodes every request after the open must reach the same node: route
 * `{base}/sessions/{nodeId}.*` to that node, or use sticky sessions. A request that reaches another node is
 * answered `409 CANOPY_SESSION_MOVED`, and the SDK opens a new session.
 *
 * Requests for a session carry the session's key in `apikey` (or a ticket); the token is only checked
 * when the session opens and on `auth`, as on a WebSocket.
 */
export function createHttpTransport(
  realtime: Realtime,
  options: HttpTransportOptions = {},
): HttpTransport {
  const base = (options.basePath ?? "/realtime/v1").replace(/\/$/, "")
  const nodeId = options.nodeId ?? "n1"
  const maxBody = options.maxBodyBytes ?? 1024 * 1024
  const retainBytes = options.retainBytes ?? 1024 * 1024
  const maxWait = options.maxWaitSeconds ?? 30
  const keepAliveMs = options.keepAliveMs ?? 15_000
  const closedRetention = options.closedRetentionMs ?? 60_000
  const sessions = new Map<string, HttpSession>()
  const tickets = new Map<string, Ticket>()
  const sweeper = setInterval(() => {
    const now = Date.now()
    for (const [sid, session] of sessions)
      if (session.closed !== undefined && now - session.closedAt > closedRetention)
        sessions.delete(sid)
    for (const [value, entry] of tickets) if (entry.expiresAt < now) tickets.delete(value)
  }, 10_000)
  ;(sweeper as { unref?: () => void }).unref?.()

  const corsHeaders = (request: Request): Record<string, string> => {
    const origin = request.headers.get("origin")
    const allowed = options.cors?.origins
    if (origin === null || allowed === undefined) return {}
    if (allowed !== "*" && !allowed.includes(origin)) return {}
    return { "access-control-allow-origin": allowed === "*" ? "*" : origin, vary: "Origin" }
  }

  const closedResponse = (session: HttpSession): Response => {
    const closed = session.closed ?? { code: CloseCode.Normal, reason: "closed" }
    return problem(
      statusOfClose(closed.code),
      closed.code === CloseCode.Unauthorized ? ErrorCode.Unauthorized : ErrorCode.NotFound,
      `The session was closed: ${closed.reason}`,
      closed.code,
    )
  }

  const lookup = (
    request: Request,
    url: URL,
    sid: string,
    allowTicket: boolean,
  ): HttpSession | Response => {
    const session = sessions.get(sid)
    if (session === undefined) {
      if (!sid.startsWith(`${nodeId}.`))
        return problem(409, ErrorCode.SessionMoved, "The session lives on another node", 4000)
      return problem(404, ErrorCode.NotFound, "Unknown or expired session", 4000)
    }
    const key = request.headers.get("apikey")
    if (key !== null) {
      if (key !== session.key)
        return problem(401, ErrorCode.Unauthorized, "The key does not match the session", 4001)
      return session
    }
    const ticket = allowTicket ? url.searchParams.get("ticket") : null
    if (ticket !== null) {
      const entry = tickets.get(ticket)
      tickets.delete(ticket)
      if (entry !== undefined && entry.sid === sid && entry.expiresAt >= Date.now()) return session
    }
    return problem(401, ErrorCode.Unauthorized, "Send the key in the apikey header", 4001)
  }

  const open = async (request: Request, peer: string | undefined): Promise<Response> => {
    const text = await readText(request, maxBody)
    if (text === undefined)
      return problem(413, ErrorCode.PayloadTooLarge, "The hello payload is too large")
    let body: unknown
    try {
      body = text === "" ? {} : JSON.parse(text)
    } catch {
      body = undefined
    }
    if (typeof body !== "object" || body === null || Array.isArray(body))
      return problem(400, ErrorCode.ProtocolError, "The body must be a JSON hello payload")
    const payload = body as Record<string, unknown>
    const key = request.headers.get("apikey") ?? payload["key"]
    if (typeof key !== "string")
      return problem(401, ErrorCode.Unauthorized, "Send the key in the apikey header", 4001)
    const token = bearer(request) ?? payload["token"]
    const caps = payload["caps"]
    const hello = {
      ...payload,
      t: "hello",
      key,
      ...(typeof token === "string" ? { token } : {}),
      ...(Array.isArray(caps) ? { caps: caps.filter((cap) => cap !== "batch") } : {}),
    }
    const session = new HttpSession(
      realtime,
      key,
      retainBytes,
      peer === undefined ? undefined : realtime.clientAddress(request.headers, peer),
    )
    session.connection.message(JSON.stringify(hello))
    const timeout = setTimeout(
      () => session.end(CloseCode.InternalError, "no welcome in time"),
      HELLO_TIMEOUT_MS,
    )
    const welcome = await session.first
    clearTimeout(timeout)
    if (welcome === undefined) {
      const err = session.entries.find((entry) => entry.text.includes('"t":"err"'))
      let code: ErrorCode = ErrorCode.Unauthorized
      let detail = "The session was refused"
      if (err !== undefined) {
        const parsed = JSON.parse(err.text) as { code?: unknown; msg?: unknown }
        if (isErrorCode(parsed.code)) code = parsed.code
        if (typeof parsed.msg === "string") detail = parsed.msg
      }
      const close = session.closed?.code ?? CloseCode.InternalError
      return problem(
        close === CloseCode.Normal ? httpStatusOf(code) : statusOfClose(close),
        code,
        detail,
        close,
      )
    }
    session.sid = (JSON.parse(welcome) as { sid: string }).sid
    sessions.set(session.sid, session)
    await new Promise((resolve) => setTimeout(resolve, 0))
    return new Response(welcome, { status: 201, headers: { "content-type": "application/json" } })
  }

  const events = (request: Request, session: HttpSession): Response => {
    const header = request.headers.get("last-event-id")
    const after = header === null || header === "" ? undefined : Number(header)
    if (after !== undefined && (!Number.isSafeInteger(after) || after < 0))
      return problem(400, ErrorCode.ProtocolError, "Last-Event-ID must be a sequence number")
    if (after !== undefined && session.lost(after))
      return problem(410, ErrorCode.NotFound, "Frames after that position are gone", 4000)
    let start = after
    let stop: (() => void) | undefined
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let finished = false
        const write = (chunk: string): void => {
          try {
            controller.enqueue(encoder.encode(chunk))
          } catch {
            finish()
          }
        }
        const flush = (): void => {
          if (finished) return
          const selected = session.select(start)
          start = undefined
          let chunk = ""
          for (const entry of selected)
            chunk += `${entry.seq === undefined ? "" : `id: ${entry.seq}\n`}data: ${entry.text}\n\n`
          session.markDelivered(selected)
          if (chunk !== "") write(chunk)
          if (session.closed !== undefined) {
            write(`event: close\ndata: ${JSON.stringify(session.closed)}\n\n`)
            finish()
          }
        }
        const keepAlive = setInterval(() => write(": keepalive\n\n"), keepAliveMs)
        const finish = (): void => {
          if (finished) return
          finished = true
          clearInterval(keepAlive)
          if (session.wake === flush) session.wake = undefined
          if (session.stopStream === finish) session.stopStream = undefined
          try {
            controller.close()
          } catch {
            // The client already cancelled the stream.
          }
        }
        session.stopStream?.()
        session.wake?.()
        session.wake = flush
        session.stopStream = finish
        stop = finish
        write("retry: 1000\n\n")
        flush()
      },
      cancel() {
        stop?.()
      },
    })
    request.signal.addEventListener("abort", () => stop?.(), { once: true })
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      },
    })
  }

  const poll = async (request: Request, url: URL, session: HttpSession): Promise<Response> => {
    const afterText = url.searchParams.get("after")
    const after = afterText === null ? undefined : Number(afterText)
    if (after !== undefined && (!Number.isSafeInteger(after) || after < 0))
      return problem(400, ErrorCode.ProtocolError, "after must be a sequence number")
    const wait = Math.min(maxWait, Math.max(0, Number(url.searchParams.get("wait") ?? "25") || 0))
    if (after !== undefined && session.lost(after))
      return problem(410, ErrorCode.NotFound, "Frames after that position are gone", 4000)
    let selected = session.select(after)
    if (selected.length === 0 && session.closed === undefined && wait > 0) {
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          setTimeout(done, 0)
        }
        const done = (): void => {
          clearTimeout(timer)
          request.signal.removeEventListener("abort", done)
          if (session.wake === wake) session.wake = undefined
          resolve()
        }
        const timer = setTimeout(done, wait * 1000)
        request.signal.addEventListener("abort", done, { once: true })
        session.wake?.()
        session.wake = wake
      })
      selected = session.select(after)
    }
    if (selected.length === 0 && session.closed !== undefined) return closedResponse(session)
    session.markDelivered(selected)
    return new Response(`[${selected.map((entry) => entry.text).join(",")}]`, {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    })
  }

  const messages = async (request: Request, session: HttpSession): Promise<Response> => {
    if (session.closed !== undefined) return closedResponse(session)
    const text = await readText(request, maxBody)
    if (text === undefined) return problem(413, ErrorCode.PayloadTooLarge, "The body is too large")
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      body = undefined
    }
    if (!Array.isArray(body))
      return problem(400, ErrorCode.ProtocolError, "The body must be a JSON array of messages")
    for (const message of body) {
      const type = (message as { t?: unknown } | null)?.t
      if (typeof type !== "string" || !CLIENT_TYPES.has(type))
        return problem(
          400,
          ErrorCode.ProtocolError,
          "Only sub, unsub, mut, auth and ping are allowed",
        )
    }
    for (const message of body) session.connection.message(JSON.stringify(message))
    return new Response(null, { status: 202 })
  }

  const ticket = async (request: Request): Promise<Response> => {
    const text = await readText(request, 4096)
    let sid: unknown
    try {
      sid = (JSON.parse(text ?? "") as { sid?: unknown }).sid
    } catch {
      sid = undefined
    }
    if (typeof sid !== "string")
      return problem(400, ErrorCode.ProtocolError, "The body must name the session as sid")
    const found = lookup(request, new URL(request.url), sid, false)
    if (found instanceof Response) return found
    return issueTicket(sid)
  }

  const issueTicket = (sid: string): Response => {
    const value = randomToken()
    tickets.set(value, { sid, expiresAt: Date.now() + 30_000 })
    return new Response(JSON.stringify({ ticket: value, expiresIn: 30 }), {
      status: 201,
      headers: { "content-type": "application/json" },
    })
  }

  const route = async (request: Request, peer: string | undefined): Promise<Response> => {
    const url = new URL(request.url)
    const path = url.pathname.slice(base.length)
    const method = request.method
    if (path === "/sessions" && method === "POST") return open(request, peer)
    if (path === "/tickets" && method === "POST") return ticket(request)
    const match = SESSION_PATH.exec(path)
    if (match === null) return problem(404, ErrorCode.NotFound, "No such endpoint")
    const [, sid = "", action] = match
    const allowed =
      action === undefined
        ? method === "DELETE"
        : action === "messages" || action === "tickets"
          ? method === "POST"
          : method === "GET"
    if (!allowed) return problem(405, ErrorCode.ProtocolError, `${method} is not allowed here`)
    const session = lookup(request, url, sid, action === "events" || action === "poll")
    if (session instanceof Response) return session
    switch (action) {
      case "events":
        if (session.closed !== undefined) return closedResponse(session)
        return events(request, session)
      case "poll":
        return poll(request, url, session)
      case "messages":
        return messages(request, session)
      case "tickets":
        return issueTicket(sid)
      default:
        if (session.closed === undefined) session.connection.message('{"t":"bye"}')
        sessions.delete(sid)
        return new Response(null, { status: 204 })
    }
  }

  return {
    matches: (request) => {
      const path = new URL(request.url).pathname
      return path.startsWith(`${base}/sessions`) || path === `${base}/tickets`
    },
    fetch: async (request, info = {}) => {
      const cors = corsHeaders(request)
      const hasCors = cors["access-control-allow-origin"] !== undefined
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: hasCors
            ? {
                ...cors,
                "access-control-allow-methods": "GET, POST, DELETE",
                "access-control-allow-headers":
                  "apikey, authorization, content-type, last-event-id",
                "access-control-max-age": "600",
              }
            : {},
        })
      }
      const response = await route(request, info.ip)
      if (!hasCors) return response
      const headers = new Headers(response.headers)
      for (const [name, value] of Object.entries(cors)) headers.set(name, value)
      return new Response(response.body, { status: response.status, headers })
    },
    close: () => {
      clearInterval(sweeper)
      for (const session of sessions.values())
        session.end(CloseCode.ServiceRestart, "server closing")
      sessions.clear()
    },
  }
}
