import { CanopyError, ErrorCode, SUBPROTOCOL, type SubQuery } from "@canopy/protocol"
import {
  type LiveWebSocket,
  type LiveWebSocketConstructor,
  RealtimeFollower,
} from "./realtime-follower.ts"
import type { LiveResult } from "./schema.ts"

/** The realtime socket surface the engine writes to. */
export interface LiveSocket {
  send(text: string): void
  close(code: number, reason: string): void
  readonly bufferedAmount: number
}

/** What GraphQL subscriptions need from the realtime engine: its in-process connection entry point. */
export interface RealtimeConnector {
  connect(socket: LiveSocket): { message(text: string): void; close(): void }
}

/**
 * A realtime server in another process, such as the native gateway in front of this one: live queries connect
 * to it over a WebSocket at `url` (the HTTP base, `/realtime/v1` is added), with the caller's credentials.
 */
export interface RemoteRealtime {
  /** The HTTP base URL, or a function returning it when it is known only after startup. */
  readonly url: string | (() => string)
  /** The WebSocket class. Defaults to the global `WebSocket`. */
  readonly WebSocket?: LiveWebSocketConstructor
}

/** The credentials a live query connects with, as the request presented them. */
export interface LiveCredentials {
  readonly key: string
  readonly token: string | undefined
}

const later: (callback: () => void) => void =
  typeof setImmediate === "function"
    ? (callback) => {
        setImmediate(callback)
      }
    : (callback) => {
        setTimeout(callback, 0)
      }

/** A WebSocket class whose instances are in-process connections to the realtime engine. */
function inProcessSocket(realtime: RealtimeConnector): LiveWebSocketConstructor {
  return class InProcessSocket implements LiveWebSocket {
    readyState = 0
    readonly protocol = SUBPROTOCOL
    onopen: ((event: unknown) => void) | null = null
    onmessage: ((event: { readonly data: unknown }) => void) | null = null
    onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null = null
    onerror: ((event: unknown) => void) | null = null
    private readonly handler: { message(text: string): void; close(): void }

    private readonly inbox: (string | { readonly code: number; readonly reason: string })[] = []
    private flushing = false

    constructor() {
      this.handler = realtime.connect({
        send: (text) => this.deliver(text),
        close: (code, reason) => this.deliver({ code, reason }),
        bufferedAmount: 0,
      })
      queueMicrotask(() => {
        if (this.readyState !== 0) return
        this.readyState = 1
        this.onopen?.({})
      })
    }

    /**
     * Hands server frames over on a later macrotask, in order, as a network would: the engine may still
     * be finishing its own bookkeeping for a frame when it writes it.
     */
    private deliver(frame: string | { readonly code: number; readonly reason: string }): void {
      this.inbox.push(frame)
      if (this.flushing) return
      this.flushing = true
      later(() => {
        this.flushing = false
        for (const next of this.inbox.splice(0)) {
          if (typeof next !== "string") this.finish(next.code, next.reason)
          else if (this.readyState === 1) this.onmessage?.({ data: next })
        }
      })
    }

    send(data: string): void {
      if (this.readyState === 1) this.handler.message(data)
    }

    close(code = 1000, reason = ""): void {
      if (this.readyState >= 2) return
      this.handler.close()
      this.finish(code, reason)
    }

    private finish(code: number, reason: string): void {
      if (this.readyState === 3) return
      this.readyState = 3
      this.onclose?.({ code, reason })
    }
  }
}

interface Shared {
  readonly follower: RealtimeFollower
  refs: number
}

/**
 * Follows live queries for GraphQL subscriptions through the realtime engine's own observers. Requests
 * with the same credentials share one session, which is closed when its last subscription
 * ends. DLS applies exactly as for WebSocket clients, because the engine sees the same `hello`.
 */
export class LiveQueries {
  private readonly socket: LiveWebSocketConstructor
  private readonly url: () => string
  private readonly shared = new Map<string, Shared>()
  private closed = false

  constructor(realtime: RealtimeConnector | RemoteRealtime) {
    if ("connect" in realtime) {
      this.socket = inProcessSocket(realtime)
      this.url = () => "http://canopy.in-process"
      return
    }
    const socket =
      realtime.WebSocket ??
      (globalThis as { WebSocket?: LiveWebSocketConstructor }).WebSocket ??
      undefined
    if (socket === undefined)
      throw new CanopyError(ErrorCode.Unavailable, "Remote realtime needs a WebSocket class")
    this.socket = socket
    const url = realtime.url
    this.url = typeof url === "function" ? url : () => url
  }

  /** The number of open realtime sessions. */
  get sessions(): number {
    return this.shared.size
  }

  private acquire(credentials: LiveCredentials): [RealtimeFollower, () => void] {
    if (this.closed) throw new CanopyError(ErrorCode.Unavailable, "The realtime session closed")
    const id = JSON.stringify([credentials.key, credentials.token])
    let entry = this.shared.get(id)
    if (entry === undefined) {
      entry = {
        follower: new RealtimeFollower(this.socket, this.url, credentials),
        refs: 0,
      }
      this.shared.set(id, entry)
    }
    const current = entry
    current.refs += 1
    let released = false
    return [
      current.follower,
      () => {
        if (released) return
        released = true
        current.refs -= 1
        if (current.refs > 0) return
        this.shared.delete(id)
        current.follower.close()
      },
    ]
  }

  /**
   * Yields the full result of a live query once it is ready and again after every change. Ends with the
   * query's error, or with `CANOPY_UNAVAILABLE` when the session closes for good.
   */
  follow(
    credentials: LiveCredentials,
    collection: string,
    query: SubQuery,
    signal: AbortSignal,
  ): AsyncIterable<LiveResult> {
    return {
      [Symbol.asyncIterator]: () => {
        if (signal.aborted)
          return {
            next: async () => ({ done: true, value: undefined }),
          }
        const [follower, release] = this.acquire(credentials)
        let pending: LiveResult | undefined
        let failure: CanopyError | undefined
        let done = false
        const waiting = new Set<() => void>()
        const notify = (): void => {
          for (const wake of waiting) wake()
          waiting.clear()
        }
        const stopQuery = follower.subscribe(
          collection,
          query,
          (docs) => {
            pending = docs === undefined ? undefined : { docs }
            notify()
          },
          (error) => {
            pending = undefined
            failure = error
            notify()
          },
        )
        const finish = (): void => {
          if (done) return
          done = true
          pending = undefined
          stopQuery()
          release()
          signal.removeEventListener("abort", finish)
          notify()
        }
        signal.addEventListener("abort", finish, { once: true })
        if (signal.aborted) finish()
        return {
          async next(): Promise<IteratorResult<LiveResult>> {
            for (;;) {
              if (done) return { done: true, value: undefined }
              const value = pending
              pending = undefined
              if (value !== undefined) return { done: false, value }
              if (failure !== undefined) {
                const error = failure
                finish()
                throw error
              }
              await new Promise<void>((resolve) => {
                waiting.add(resolve)
              })
            }
          },
          async return(): Promise<IteratorResult<LiveResult>> {
            finish()
            return { done: true, value: undefined }
          },
        }
      },
    }
  }

  /** Closes every realtime session. */
  close(): void {
    this.closed = true
    for (const entry of this.shared.values()) entry.follower.close()
    this.shared.clear()
  }
}
