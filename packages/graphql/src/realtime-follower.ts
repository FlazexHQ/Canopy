import { compileSort, withIdTieBreaker } from "@canopy/matcher"
import {
  CanopyError,
  type ClientMessage,
  CloseCode,
  canonicalString,
  closeReaction,
  compareCt,
  type Document,
  decodeServerMessage,
  ErrorCode,
  encodeMessage,
  errorFromWire,
  isDocument,
  PROTOCOL_VERSION,
  ProtocolError,
  type SequencedMessage,
  SUBPROTOCOL,
  type SubQuery,
  trimTrailingSlashes,
} from "@canopy/protocol"
import type { LiveCredentials } from "./live.ts"

/** The browser-compatible socket surface used by the realtime follower. */
export interface LiveWebSocket {
  readonly readyState: number
  readonly protocol: string
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { readonly data: unknown }) => void) | null
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null
  onerror: ((event: unknown) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

/** Constructs a WebSocket for the realtime wire protocol. */
export type LiveWebSocketConstructor = new (
  url: string,
  protocols?: string | string[],
) => LiveWebSocket

interface Subscription {
  readonly collection: string
  readonly query: SubQuery
  readonly order: ReturnType<typeof compileSort>
  readonly keys: Set<string>
  readonly update: (docs: readonly Document[] | undefined) => void
  readonly fail: (error: CanopyError) => void
  ready: boolean
  last: readonly Document[] | undefined
}

interface Cached {
  readonly doc: Document
  readonly ct: string
  readonly members: Set<string>
}

function changedDocument(
  doc: Document,
  message: Extract<SequencedMessage, { t: "changed" }>,
): Document {
  if (message.replace && message.d !== undefined) return message.d
  const next = { ...doc, ...message.set }
  for (const field of message.unset ?? []) delete next[field]
  return next
}

// The codec drops unknown message types, which still consume sequence positions.
function wirePositions(text: string): readonly unknown[] {
  const value: unknown = JSON.parse(text)
  return isDocument(value) && value["t"] === "batch" && Array.isArray(value["m"])
    ? value["m"]
    : [value]
}

/** Follows the read-only realtime stream for one set of request credentials. */
export class RealtimeFollower {
  private readonly subscriptions = new Map<string, Subscription>()
  private readonly cache = new Map<string, Cached>()
  private socket: LiveWebSocket | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private attempt = 0
  private seq = 0
  private id = 0
  private welcomed = false
  private lastInbound = 0
  private lastOutbound = 0
  private failure: CanopyError | undefined
  private readonly createSocket: () => LiveWebSocket
  private readonly credentials: LiveCredentials

  constructor(Socket: LiveWebSocketConstructor, url: () => string, credentials: LiveCredentials) {
    this.credentials = credentials
    this.createSocket = () => {
      const endpoint = new URL(`${trimTrailingSlashes(url())}/realtime/v1`)
      if (endpoint.protocol === "http:") endpoint.protocol = "ws:"
      if (endpoint.protocol === "https:") endpoint.protocol = "wss:"
      return new Socket(endpoint.href, SUBPROTOCOL)
    }
  }

  /** Starts a subscription and returns its unsubscribe function. */
  subscribe(
    collection: string,
    query: SubQuery,
    update: Subscription["update"],
    fail: Subscription["fail"],
  ): () => void {
    if (this.failure !== undefined) {
      fail(this.failure)
      return () => {}
    }
    const id = `s${++this.id}`
    const sub: Subscription = {
      collection,
      query,
      order: compileSort(withIdTieBreaker(query.sort ?? {})),
      keys: new Set(),
      update,
      fail,
      ready: false,
      last: undefined,
    }
    this.subscriptions.set(id, sub)
    if (this.welcomed) this.sendSub(id, sub)
    else if (this.socket === undefined && this.timer === undefined) this.connect()
    return () => {
      if (!this.subscriptions.delete(id)) return
      this.clearMembership(id, sub)
      if (this.welcomed) this.send({ t: "unsub", id })
    }
  }

  private send(message: ClientMessage): void {
    const socket = this.socket
    if (socket?.readyState !== 1) return
    try {
      socket.send(encodeMessage(message))
      this.lastOutbound = Date.now()
    } catch (error: unknown) {
      this.close(toFollowerError(error))
    }
  }

  private sendSub(id: string, sub: Subscription): void {
    this.send({ t: "sub", id, c: sub.collection, q: sub.query })
  }

  private connect(): void {
    let socket: LiveWebSocket
    try {
      socket = this.createSocket()
    } catch (error: unknown) {
      this.close(toFollowerError(error))
      return
    }
    this.socket = socket
    this.timer = setTimeout(() => this.reconnect(), 10_000)
    socket.onopen = () => {
      if (this.socket !== socket) return
      if (socket.protocol !== SUBPROTOCOL) {
        this.close(new ProtocolError("The realtime server selected an unsupported subprotocol"))
        return
      }
      const { key, token } = this.credentials
      this.send({
        t: "hello",
        v: PROTOCOL_VERSION,
        key,
        ...(token === undefined ? {} : { token }),
        caps: ["batch", "diff"],
        sdk: "canopy-graphql/0.1.0",
      })
    }
    socket.onmessage = ({ data }) => {
      if (this.socket !== socket) return
      try {
        if (typeof data !== "string") throw new ProtocolError("Expected a realtime text frame")
        this.lastInbound = Date.now()
        this.receive(data)
      } catch (error: unknown) {
        this.close(toFollowerError(error))
      }
    }
    socket.onerror = () => {}
    socket.onclose = ({ code }) => {
      if (this.socket !== socket) return
      switch (code) {
        case CloseCode.Normal:
          this.close()
          break
        case CloseCode.Unauthorized:
          this.close(new CanopyError(ErrorCode.Unauthorized, "Realtime credentials were rejected"))
          break
        case CloseCode.Forbidden:
          this.close(new CanopyError(ErrorCode.Forbidden, "Realtime access was denied"))
          break
        case CloseCode.UnsupportedVersion:
          this.close(
            new ProtocolError("The realtime server does not support this protocol version"),
          )
          break
        default:
          this.reconnect(closeReaction(code).minDelayMs)
      }
    }
  }

  private receive(text: string): void {
    const message = decodeServerMessage(text)
    const dirty = new Set<Subscription>()
    if (message?.t === "pong") return
    if (message !== undefined && message.t !== "batch") {
      if (!this.applySequenced(message.seq, message, dirty)) return
    } else {
      const decoded = message?.m ?? []
      let index = 0
      for (const frame of wirePositions(text)) {
        if (!isDocument(frame) || typeof frame["seq"] !== "number") continue
        const part = decoded[index]
        const known = part?.t === frame["t"] && part?.seq === frame["seq"] ? part : undefined
        if (known !== undefined) index += 1
        if (!this.applySequenced(frame["seq"], known, dirty)) return
      }
    }
    for (const sub of dirty) this.publish(sub)
  }

  private applySequenced(
    seq: number,
    message: SequencedMessage | undefined,
    dirty: Set<Subscription>,
  ): boolean {
    if (message?.t === "welcome") {
      this.welcome(message)
      return this.welcomed
    }
    if (this.welcomed && seq <= this.seq) return true
    if (message?.t === "err" && (!this.welcomed || isAuthError(message.code))) {
      if (message.code !== ErrorCode.RateLimited) this.close(errorFromWire(message))
      return false
    }
    if (!Number.isSafeInteger(seq) || seq <= 0) return true
    if (!this.welcomed || seq !== this.seq + 1) {
      this.reconnect()
      return false
    }
    this.seq = seq
    if (message !== undefined) this.apply(message, dirty)
    return this.welcomed
  }

  private welcome(message: Extract<SequencedMessage, { t: "welcome" }>): void {
    if (this.welcomed || message.seq !== 0 || message.v !== PROTOCOL_VERSION || message.resumed) {
      throw new ProtocolError("Unexpected realtime welcome")
    }
    clearTimeout(this.timer)
    this.timer = undefined
    this.attempt = 0
    this.seq = 0
    this.welcomed = true
    const interval = message.hb >= 100 && message.hb <= 300_000 ? message.hb : 25_000
    this.heartbeat = setInterval(() => {
      const now = Date.now()
      if (now - this.lastInbound >= 2 * interval) this.reconnect()
      else if (now - this.lastOutbound >= interval) this.send({ t: "ping", ts: now })
    }, interval)
    for (const [id, sub] of this.subscriptions) this.sendSub(id, sub)
  }

  private apply(message: SequencedMessage, dirty: Set<Subscription>): void {
    switch (message.t) {
      case "added":
      case "changed":
      case "removed":
        this.applyDocument(message, dirty)
        break
      case "ready": {
        const sub = this.subscriptions.get(message.s)
        if (sub !== undefined) {
          sub.ready = true
          dirty.add(sub)
        }
        break
      }
      case "nosub": {
        const sub = this.subscriptions.get(message.s)
        if (sub !== undefined) {
          this.subscriptions.delete(message.s)
          this.clearMembership(message.s, sub)
          sub.fail(
            message.err === undefined
              ? new CanopyError(ErrorCode.Unavailable, "The realtime subscription ended")
              : errorFromWire(message.err),
          )
        }
        break
      }
      case "resync":
        for (const id of message.s ?? this.subscriptions.keys()) {
          const sub = this.subscriptions.get(id)
          if (sub !== undefined) {
            this.reset(id, sub)
            this.sendSub(id, sub)
          }
        }
        break
      case "reconnect":
        this.reconnect(message.retryAfterMs)
        break
      default:
        break
    }
  }

  private applyDocument(
    message: Extract<SequencedMessage, { t: "added" | "changed" | "removed" }>,
    dirty: Set<Subscription>,
  ): void {
    const key = `${message.c}/${canonicalString(message.id)}`
    const prior = this.cache.get(key)
    if (message.t === "removed") {
      for (const id of message.s) {
        const sub = this.subscriptions.get(id)
        if (prior?.members.delete(id) && sub?.keys.delete(key)) dirty.add(sub)
      }
      if (prior?.members.size === 0) this.cache.delete(key)
      else if (prior !== undefined && compareCt(message.ct, prior.ct) > 0) {
        this.cache.set(key, { ...prior, ct: message.ct })
      }
      return
    }
    if (message.t === "changed" && prior === undefined) return
    if (message.t === "changed" && message.refetch) {
      this.reconnect()
      return
    }
    const newer = prior === undefined || compareCt(message.ct, prior.ct) >= 0
    const next =
      message.t === "changed" && prior !== undefined && newer
        ? changedDocument(prior.doc, message)
        : ((newer ? message.d : undefined) ?? prior?.doc)
    const members = prior?.members ?? new Set<string>()
    if (message.t === "added") {
      for (const id of message.s) {
        const sub = this.subscriptions.get(id)
        if (sub?.collection !== message.c) continue
        members.add(id)
        sub.keys.add(key)
        dirty.add(sub)
      }
    }
    if (members.size === 0) return
    if (next === undefined) {
      this.reconnect()
      return
    }
    const doc =
      prior !== undefined &&
      (next === prior.doc || canonicalString(next) === canonicalString(prior.doc))
        ? prior.doc
        : next
    this.cache.set(key, { doc, ct: newer ? message.ct : prior.ct, members })
    if (doc !== prior?.doc) {
      for (const id of members) {
        const sub = this.subscriptions.get(id)
        if (sub !== undefined) dirty.add(sub)
      }
    }
  }

  private publish(sub: Subscription): void {
    if (!sub.ready) return
    const docs = [...sub.keys].flatMap((key) => {
      const cached = this.cache.get(key)
      return cached === undefined ? [] : [cached.doc]
    })
    docs.sort(sub.order)
    const data = docs.slice(0, sub.query.limit)
    if (sub.last?.length === data.length && data.every((doc, i) => doc === sub.last?.[i])) return
    sub.last = data
    sub.update(data)
  }

  private clearMembership(id: string, sub: Subscription): void {
    for (const key of sub.keys) {
      const cached = this.cache.get(key)
      cached?.members.delete(id)
      if (cached?.members.size === 0) this.cache.delete(key)
    }
    sub.keys.clear()
    sub.ready = false
  }

  private reset(id: string, sub: Subscription): void {
    this.clearMembership(id, sub)
    sub.last = undefined
    sub.update(undefined)
  }

  private disconnect(graceful = false): void {
    if (graceful && this.welcomed && this.socket?.readyState === 1) {
      try {
        this.socket.send(encodeMessage({ t: "bye" }))
      } catch {
        // Closing the transport still releases the session.
      }
    }
    const socket = this.socket
    this.socket = undefined
    this.welcomed = false
    clearTimeout(this.timer)
    clearInterval(this.heartbeat)
    this.timer = undefined
    this.heartbeat = undefined
    if (socket !== undefined && socket.readyState < 2) socket.close()
  }

  private reconnect(delay = 0): void {
    this.disconnect(true)
    for (const [id, sub] of this.subscriptions) this.reset(id, sub)
    const backoff = Math.min(10_000, 250 * 2 ** Math.min(this.attempt++, 6))
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        this.connect()
      },
      Math.min(2_147_483_647, Math.max(delay, backoff)),
    )
  }

  /** Stops the follower and releases the realtime session. */
  close(error = new CanopyError(ErrorCode.Unavailable, "The realtime session closed")): void {
    if (this.failure !== undefined) return
    this.failure = error
    this.disconnect(true)
    for (const sub of this.subscriptions.values()) sub.fail(error)
    this.subscriptions.clear()
    this.cache.clear()
  }
}

function isAuthError(code: ErrorCode): boolean {
  return (
    code === ErrorCode.Unauthorized ||
    code === ErrorCode.TokenExpired ||
    code === ErrorCode.Forbidden
  )
}

function toFollowerError(error: unknown): CanopyError {
  return error instanceof CanopyError
    ? error
    : new CanopyError(ErrorCode.Unavailable, "The realtime connection failed", { cause: error })
}
