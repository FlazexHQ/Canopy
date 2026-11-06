import {
  type ClientMessage,
  closeReaction,
  type Document,
  decodeServerMessage,
  encodeMessage,
  errorFromWire,
  PROTOCOL_VERSION,
  type SequencedMessage,
  SUBPROTOCOL,
  type SubQuery,
  unbatch,
} from '@canopy/protocol'
import { LOADING_STATE, type QueryState, Store } from './store.ts'

/** The connection status an application sees. */
export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'offline' | 'closed'

/** The minimal WebSocket surface the client needs; the global `WebSocket` satisfies it. */
export interface WebSocketLike {
  readonly readyState: number
  readonly protocol: string
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { readonly data: unknown }) => void) | null
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null
  onerror: ((event: unknown) => void) | null
}

/** A WebSocket constructor. */
export type WebSocketConstructor = new (url: string, protocols?: string | string[]) => WebSocketLike

/** Options for {@link createClient}. */
export interface ClientOptions {
  /** The Canopy base URL, for example `https://api.example.com`. The socket connects to `/realtime/v1`. */
  readonly url: string
  readonly publishableKey: string
  /** Bring your own identity provider: returns the current user token, or `null` for anon. */
  readonly auth?: {
    readonly getToken: () => string | null | undefined | Promise<string | null | undefined>
  }
  /** Overrides the global `WebSocket`, for runtimes without one. */
  readonly WebSocket?: WebSocketConstructor
  /** Maximum reconnect delay in milliseconds. Defaults to 30 s. */
  readonly maxBackoffMs?: number
  /** The SDK identifier sent in `hello`. */
  readonly sdk?: string
}

/** A live query description. */
export interface LiveQueryOptions {
  readonly sort?: Readonly<Record<string, 1 | -1>>
  readonly limit?: number
  readonly fields?: Readonly<Record<string, 0 | 1>>
}

/** A live query: a value that stays current. */
export interface LiveQuery<T = Document> {
  /** The current state. Stable between changes, so it is safe for `useSyncExternalStore`. */
  getState(): QueryState<T>
  /** Calls `listener` on every change. Returns a function that stops the subscription. */
  subscribe(listener: (state: QueryState<T>) => void): () => void
}

function backoff(attempt: number, maxMs: number): number {
  return Math.random() * Math.min(maxMs, 250 * 2 ** attempt)
}

function tokenExpiry(token: string): number | undefined {
  const part = token.split('.')[1]
  if (part === undefined) return undefined
  try {
    const json = JSON.parse(atob(part.replaceAll('-', '+').replaceAll('_', '/'))) as {
      exp?: unknown
    }
    return typeof json.exp === 'number' ? json.exp * 1000 : undefined
  } catch {
    return undefined
  }
}

interface Subscription {
  readonly id: string
  readonly coll: string
  readonly query: SubQuery
  refs: number
}

/**
 * The Canopy client: a document cache with live queries over `canopy.v1`, automatic reconnection
 * with full jitter backoff, resume by sequence number and resync reconciliation.
 */
export class CanopyClient {
  readonly store: Store = new Store()
  private readonly options: ClientOptions
  private readonly socketUrl: string
  private socket: WebSocketLike | undefined
  private status: ConnectionStatus = 'connecting'
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>()
  private readonly subscriptions = new Map<string, Subscription>()
  private readonly byQuery = new Map<string, Subscription>()
  private sid: string | undefined
  private lastSeq = 0
  private welcomed = false
  private attempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private refreshTimer: ReturnType<typeof setTimeout> | undefined
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  private lastInbound = 0
  private heartbeatMs = 25_000
  private closed = false
  private nextId = 1

  constructor(options: ClientOptions) {
    this.options = options
    const base = new URL(options.url)
    base.protocol =
      base.protocol === 'https:' ? 'wss:' : base.protocol === 'http:' ? 'ws:' : base.protocol
    base.pathname = `${base.pathname.replace(/\/$/, '')}/realtime/v1`
    this.socketUrl = base.toString()
    this.connect()
  }

  /** The current connection status. */
  get connectionStatus(): ConnectionStatus {
    return this.status
  }

  /** Calls `listener` whenever the connection status changes. */
  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return
    this.status = status
    for (const listener of this.statusListeners) listener(status)
  }

  /** Starts a query builder for a collection. */
  from<T extends Document = Document>(collection: string): QueryBuilder<T> {
    return new QueryBuilder<T>(this, collection, {}, {})
  }

  /** Returns a live query; identical queries share one server subscription. */
  live<T extends Document = Document>(
    collection: string,
    filter: Document,
    options: LiveQueryOptions = {},
  ): LiveQuery<T> {
    const query: SubQuery = {
      filter,
      ...(options.sort === undefined ? {} : { sort: options.sort }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.fields === undefined ? {} : { fields: options.fields }),
    }
    const key = `${collection}\u0000${encodeMessage({ t: 'sub', id: 'k', c: collection, q: query })}`
    return {
      getState: () => {
        const sub = this.byQuery.get(key)
        return (sub === undefined ? LOADING_STATE : this.store.state(sub.id)) as QueryState<T>
      },
      subscribe: (listener) => {
        let sub = this.byQuery.get(key)
        if (sub === undefined) {
          sub = { id: `s${this.nextId}`, coll: collection, query, refs: 0 }
          this.nextId += 1
          this.byQuery.set(key, sub)
          this.subscriptions.set(sub.id, sub)
          this.store.addQuery(sub.id, collection, options.sort)
          this.send({ t: 'sub', id: sub.id, c: collection, q: query })
        }
        sub.refs += 1
        const current = sub
        const stop = this.store.listen(current.id, () =>
          listener(this.store.state(current.id) as QueryState<T>),
        )
        listener(this.store.state(current.id) as QueryState<T>)
        return () => {
          stop()
          current.refs -= 1
          if (current.refs > 0) return
          this.byQuery.delete(key)
          this.subscriptions.delete(current.id)
          this.store.removeQuery(current.id)
          this.send({ t: 'unsub', id: current.id })
        }
      },
    }
  }

  private send(message: ClientMessage): void {
    if (this.socket !== undefined && this.welcomed && this.socket.readyState === 1)
      this.socket.send(encodeMessage(message))
  }

  private connect(): void {
    if (this.closed) return
    const WebSocketImpl =
      this.options.WebSocket ?? (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket
    if (WebSocketImpl === undefined)
      throw new TypeError('No WebSocket implementation is available; pass one in options')
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting')
    const socket = new WebSocketImpl(this.socketUrl, SUBPROTOCOL)
    this.socket = socket
    this.welcomed = false
    socket.onopen = () => {
      this.hello(socket).catch(() => socket.close(4500, 'token source failed'))
    }
    socket.onmessage = (event) => {
      if (typeof event.data === 'string') this.receive(event.data)
    }
    socket.onclose = (event) => this.onClose(socket, event.code)
    socket.onerror = () => {}
  }

  private async hello(socket: WebSocketLike): Promise<void> {
    const token = (await this.options.auth?.getToken()) ?? undefined
    if (this.socket !== socket || socket.readyState !== 1) return
    const message: ClientMessage = {
      t: 'hello',
      v: PROTOCOL_VERSION,
      key: this.options.publishableKey,
      ...(token === undefined || token === null ? {} : { token }),
      ...(this.sid === undefined ? {} : { resume: { sid: this.sid, seq: this.lastSeq } }),
      caps: ['batch', 'diff'],
      sdk: this.options.sdk ?? 'canopy-js/0.1.0',
    }
    socket.send(encodeMessage(message))
    this.scheduleRefresh(token ?? undefined)
  }

  private scheduleRefresh(token: string | undefined): void {
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer)
    this.refreshTimer = undefined
    if (token === undefined || this.options.auth === undefined) return
    const expiry = tokenExpiry(token)
    if (expiry === undefined) return
    const lifetime = expiry - Date.now()
    this.refreshTimer = setTimeout(
      () => {
        Promise.resolve(this.options.auth?.getToken())
          .then((next) => {
            this.send({ t: 'auth', token: next ?? '' })
            this.scheduleRefresh(next ?? undefined)
          })
          .catch(() => {})
      },
      Math.max(1000, lifetime * 0.8),
    )
  }

  /** Feeds one server frame to the client. Public for transports and conformance tests. */
  receive(text: string): void {
    this.lastInbound = Date.now()
    const message = decodeServerMessage(text)
    if (message === undefined) return
    for (const part of unbatch(message)) {
      if (part.t === 'pong') continue
      this.handle(part)
    }
  }

  private handle(message: SequencedMessage): void {
    if (message.t === 'welcome') {
      this.welcomed = true
      this.attempt = 0
      this.heartbeatMs = message.hb
      this.startHeartbeat()
      const resumed = message.resumed && message.sid === this.sid
      this.sid = message.sid
      if (!resumed) {
        this.lastSeq = 0
        for (const sub of this.subscriptions.values()) {
          this.store.beginResync(sub.id)
          this.send({ t: 'sub', id: sub.id, c: sub.coll, q: sub.query })
        }
      }
      this.setStatus('live')
      return
    }
    if (message.seq <= this.lastSeq) return
    this.lastSeq = message.seq
    switch (message.t) {
      case 'added':
        this.store.added(message.c, message.id, message.d, message.ct, message.s)
        return
      case 'changed':
        this.store.changed(message.c, message.id, message.ct, {
          ...(message.set === undefined ? {} : { set: message.set }),
          ...(message.unset === undefined ? {} : { unset: message.unset }),
          ...(message.replace === true && message.d !== undefined ? { replace: message.d } : {}),
        })
        return
      case 'removed':
        this.store.removed(message.c, message.id, message.ct, message.s)
        return
      case 'ready':
        this.store.ready(message.s)
        return
      case 'nosub': {
        if (message.err !== undefined) this.store.fail(message.s, errorFromWire(message.err))
        return
      }
      case 'resync': {
        const ids = message.s ?? [...this.subscriptions.keys()]
        for (const id of ids) {
          const sub = this.subscriptions.get(id)
          if (sub === undefined) continue
          this.store.beginResync(id)
          this.send({ t: 'sub', id, c: sub.coll, q: sub.query })
        }
        return
      }
      case 'reconnect': {
        const socket = this.socket
        this.detach()
        socket?.close(1000, 'server asked to reconnect')
        this.scheduleReconnect(message.retryAfterMs)
        return
      }
      default:
        return
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer)
    this.lastInbound = Date.now()
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastInbound > 2 * this.heartbeatMs) {
        this.socket?.close(4000, 'heartbeat timeout')
        return
      }
      this.send({ t: 'ping', ts: Date.now() })
    }, this.heartbeatMs)
  }

  private detach(): void {
    this.socket = undefined
    this.welcomed = false
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
    if (!this.closed) this.store.markStale()
  }

  private onClose(socket: WebSocketLike, code: number): void {
    if (this.socket !== socket) return
    this.detach()
    if (this.closed) {
      this.setStatus('closed')
      return
    }
    const reaction = closeReaction(code)
    if (!reaction.reconnect) {
      this.setStatus('closed')
      return
    }
    if (!reaction.resume) this.sid = undefined
    this.scheduleReconnect(reaction.minDelayMs)
  }

  private scheduleReconnect(minDelayMs: number): void {
    if (this.reconnectTimer !== undefined || this.closed) return
    this.setStatus('reconnecting')
    const delay = Math.max(minDelayMs, backoff(this.attempt, this.options.maxBackoffMs ?? 30_000))
    this.attempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.connect()
    }, delay)
  }

  /** Reconnects now, for example on `online` or when the page becomes visible. */
  reconnectNow(): void {
    if (this.socket !== undefined || this.closed) return
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.connect()
  }

  /** Closes the connection for good (`bye`). */
  close(): void {
    this.closed = true
    for (const timer of [this.reconnectTimer, this.refreshTimer])
      if (timer !== undefined) clearTimeout(timer)
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer)
    if (this.socket !== undefined && this.socket.readyState === 1)
      this.socket.send(encodeMessage({ t: 'bye' }))
    this.socket?.close(1000, 'bye')
    this.setStatus('closed')
  }
}

/** An immutable query builder: `from('todos').find({ done: false }).sort({ at: -1 }).limit(20)`. */
export class QueryBuilder<T extends Document = Document> implements LiveQuery<T> {
  private readonly client: CanopyClient
  private readonly collection: string
  private readonly filter: Document
  private readonly options: LiveQueryOptions
  private cached: LiveQuery<T> | undefined

  constructor(
    client: CanopyClient,
    collection: string,
    filter: Document,
    options: LiveQueryOptions,
  ) {
    this.client = client
    this.collection = collection
    this.filter = filter
    this.options = options
  }

  find(filter: Document): QueryBuilder<T> {
    return new QueryBuilder<T>(this.client, this.collection, filter, this.options)
  }

  sort(sort: Readonly<Record<string, 1 | -1>>): QueryBuilder<T> {
    return new QueryBuilder<T>(this.client, this.collection, this.filter, { ...this.options, sort })
  }

  limit(limit: number): QueryBuilder<T> {
    return new QueryBuilder<T>(this.client, this.collection, this.filter, {
      ...this.options,
      limit,
    })
  }

  fields(fields: Readonly<Record<string, 0 | 1>>): QueryBuilder<T> {
    return new QueryBuilder<T>(this.client, this.collection, this.filter, {
      ...this.options,
      fields,
    })
  }

  private live(): LiveQuery<T> {
    this.cached ??= this.client.live<T>(this.collection, this.filter, this.options)
    return this.cached
  }

  getState(): QueryState<T> {
    return this.live().getState()
  }

  subscribe(listener: (state: QueryState<T>) => void): () => void {
    return this.live().subscribe(listener)
  }
}

/** Creates a client and starts connecting. */
export function createClient(options: ClientOptions): CanopyClient {
  return new CanopyClient(options)
}
