import {
  type CanopyClient,
  createClient,
  type LiveQueryOptions,
  type QueryState,
  type WebSocketConstructor,
  type WebSocketLike,
} from "@canopy/client"
import { CanopyError, type Document, ErrorCode, SUBPROTOCOL, type SubQuery } from "@canopy/protocol"
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
function inProcessSocket(realtime: RealtimeConnector): WebSocketConstructor {
  return class InProcessSocket implements WebSocketLike {
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
  readonly client: CanopyClient
  refs: number
}

/**
 * Follows live queries for GraphQL subscriptions through the realtime engine's own observers. Requests
 * with the same credentials share one in-process session, which is closed when its last subscription
 * ends. DLS applies exactly as for WebSocket clients, because the engine sees the same `hello`.
 */
export class LiveQueries {
  private readonly socket: WebSocketConstructor
  private readonly shared = new Map<string, Shared>()

  constructor(realtime: RealtimeConnector) {
    this.socket = inProcessSocket(realtime)
  }

  /** The number of open in-process sessions. */
  get sessions(): number {
    return this.shared.size
  }

  private acquire(credentials: LiveCredentials): [CanopyClient, () => void] {
    const id = `${credentials.key}\u0000${credentials.token ?? ""}`
    let entry = this.shared.get(id)
    if (entry === undefined) {
      const token = credentials.token
      entry = {
        client: createClient({
          url: "http://canopy.in-process",
          publishableKey: credentials.key,
          WebSocket: this.socket,
          lifecycle: false,
          sdk: "canopy-graphql/0.1.0",
          ...(token === undefined ? {} : { auth: { getToken: () => token } }),
        }),
        refs: 0,
      }
      this.shared.set(id, entry)
    }
    const current = entry
    current.refs += 1
    let released = false
    return [
      current.client,
      () => {
        if (released) return
        released = true
        current.refs -= 1
        if (current.refs > 0) return
        this.shared.delete(id)
        current.client.close()
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
    const acquire = (): [CanopyClient, () => void] => this.acquire(credentials)
    return {
      [Symbol.asyncIterator]: () => {
        const [client, release] = acquire()
        const pending: LiveResult[] = []
        let failure: Error | undefined
        let done = false
        let wake: (() => void) | undefined
        const notify = (): void => {
          wake?.()
          wake = undefined
        }
        const options = {
          ...(query.sort === undefined ? {} : { sort: query.sort }),
          ...(query.limit === undefined ? {} : { limit: query.limit }),
          ...(query.fields === undefined ? {} : { fields: query.fields }),
        } as LiveQueryOptions
        const live = client.live(collection, query.filter as Document, options)
        let last: readonly Document[] | undefined
        const stopQuery = live.subscribe((state: QueryState) => {
          if (state.status === "error") {
            failure = state.error ?? new CanopyError(ErrorCode.Internal, "The live query failed")
            notify()
            return
          }
          if (state.status !== "ready" || state.data === last) return
          last = state.data
          if (pending.length > 0) pending.length = 0
          pending.push({ docs: state.data })
          notify()
        })
        const stopStatus = client.onStatus((status) => {
          if (status !== "closed") return
          failure ??= new CanopyError(ErrorCode.Unavailable, "The realtime session closed")
          notify()
        })
        const finish = (): void => {
          if (done) return
          done = true
          stopQuery()
          stopStatus()
          release()
          signal.removeEventListener("abort", finish)
          notify()
        }
        signal.addEventListener("abort", finish)
        return {
          async next(): Promise<IteratorResult<LiveResult>> {
            for (;;) {
              const value = pending.shift()
              if (value !== undefined) return { done: false, value }
              if (failure !== undefined) {
                const error = failure
                finish()
                throw error
              }
              if (done) return { done: true, value: undefined }
              await new Promise<void>((resolve) => {
                wake = resolve
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

  /** Closes every in-process session. */
  close(): void {
    for (const entry of this.shared.values()) entry.client.close()
    this.shared.clear()
  }
}
