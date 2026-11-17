import { compileProjection } from "@canopy/matcher/lite"
import {
  type AckMessage,
  CanopyError,
  type ClientMessage,
  type ClusterTime,
  closeReaction,
  type Document,
  decode,
  decodeServerMessage,
  ErrorCode,
  encode,
  encodeMessage,
  errorFromWire,
  type MutationOp,
  type MutMessage,
  ObjectId,
  PROTOCOL_VERSION,
  type SequencedMessage,
  SUBPROTOCOL,
  type SubQuery,
  unbatch,
  uuidv7,
  ZERO_CT,
} from "@canopy/protocol"
import type {
  ClientInternals,
  ClientOptions,
  ConnectionStatus,
  DehydratedState,
  FallbackTransport,
  LiveQuery,
  LiveQueryOptions,
  MutationHandle,
  MutationResult,
  Persister,
  ReplaceOptions,
  Snapshot,
  StaleMutation,
  TokenSource,
  WebSocketConstructor,
  WebSocketLike,
  WriteOptions,
} from "./client-types.ts"
import { type AnyClient, QueryBuilder } from "./query-builder.ts"
import { type CachedDocument, type Layer, LOADING_STATE, type QueryState, Store } from "./store.ts"
import type {
  CollectionName,
  DocumentOf,
  Filter,
  IdOf,
  InsertOf,
  Schema,
  UntypedSchema,
  UpdateFilter,
} from "./types.ts"

interface PendingMutation {
  readonly message: MutMessage
  readonly ids: readonly unknown[]
  /** Settles with the persister key once the mutation is stored. */
  readonly persisted?: Promise<string>
  sent: boolean
  readonly resolve: (result: MutationResult) => void
  readonly reject: (error: Error) => void
}

export function asDocument(value: object): Document {
  return value as Document
}

/** The key identical live queries share. */
function queryKey(collection: string, query: SubQuery): string {
  return `${collection}\u0000${encodeMessage({ t: "sub", id: "k", c: collection, q: query })}`
}

function backoff(attempt: number, maxMs: number): number {
  return Math.random() * Math.min(maxMs, 250 * 2 ** attempt)
}

/** The unverified claims of a JWT; the server verifies, the client only reads `exp` and `sub`. */
function claims(token: string | null | undefined): { exp?: unknown; sub?: unknown } {
  const part = token?.split(".")[1]
  if (part === undefined) return {}
  try {
    return JSON.parse(atob(part.replaceAll("-", "+").replaceAll("_", "/"))) as {
      exp?: unknown
      sub?: unknown
    }
  } catch {
    return {}
  }
}

/** The longest delay timers keep (2147483647 ms, about 24.8 days); longer ones fire after 1 ms instead. */
const MAX_TIMER_MS = 2_147_483_647

function tokenExpiry(token: string): number | undefined {
  const exp = claims(token).exp
  return typeof exp === "number" ? exp * 1000 : undefined
}

interface PersistedMutation {
  readonly m: MutMessage
  readonly ids: readonly unknown[]
  readonly layers: readonly Layer[]
  readonly at: number
}

const HOUR = 3_600_000

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
export class CanopyClient<in out DB extends Schema<DB> = UntypedSchema> {
  readonly store: Store = new Store()
  /**
   * Settles once the update engine is loaded. It is a separate chunk, fetched right after the client is
   * created; update layers made before it arrives show once it has.
   */
  readonly updateEngine: Promise<void>
  private readonly options: ClientOptions
  private readonly socketUrl: string
  private readonly httpUrl: string
  private rung = 0
  private ladder: readonly FallbackTransport[] | undefined
  private failures: number[] = []
  private probeTimer: ReturnType<typeof setInterval> | undefined
  private socket: WebSocketLike | undefined
  private status: ConnectionStatus = "connecting"
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
  private readonly outbox: PendingMutation[] = []
  private inFlight = 0
  private readonly mutationErrorListeners = new Set<(error: Error, mutationId: string) => void>()
  private readonly staleListeners = new Set<(mutations: readonly StaleMutation[]) => void>()
  private stale: StaleMutation[] = []
  /** Resolves once persisted mutations are back in the outbox; nothing is sent before. */
  private restoring: Promise<void> | undefined
  private scope = "anon"
  private readonly saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private lastAttemptAt = 0
  private stopLifecycle: (() => void) | undefined
  private stopAuth: (() => void) | undefined
  private staleToken = false
  private readonly hydrated = new Map<
    string,
    { readonly state: QueryState; readonly ct: ClusterTime }
  >()
  private readonly taps = new Set<(direction: "in" | "out", text: string) => void>()

  constructor(options: ClientOptions) {
    this.options = options
    this.httpUrl = options.url.replace(/\/$/, "")
    const base = new URL(options.url)
    base.protocol =
      base.protocol === "https:" ? "wss:" : base.protocol === "http:" ? "ws:" : base.protocol
    base.pathname = `${base.pathname.replace(/\/$/, "")}/realtime/v1`
    this.socketUrl = base.toString()
    this.store.onRefetch = (coll) => this.refetch(coll)
    this.updateEngine = import("@canopy/matcher/update").then(
      (engine) => this.store.useUpdater((doc, update) => engine.applyUpdate(doc, update)),
      () => {},
    )
    if (options.persist !== undefined) this.track(this.restore(options.persist))
    this.watchLifecycle()
    this.stopAuth = options.auth?.onChange?.(() => this.reidentify())
    this.connect()
  }

  /** The token source passed as `auth`, such as the `createAuth()` handle. */
  get auth(): TokenSource | undefined {
    return this.options.auth
  }

  /** Holds back sending (and persisting) mutations until `work` settles. */
  private track(work: Promise<void>): void {
    const restoring: Promise<void> = work
      .catch(() => {})
      .finally(() => {
        if (this.restoring !== restoring) return
        this.restoring = undefined
        this.pump()
      })
    this.restoring = restoring
  }

  /** Starts a fresh session as the current user: the server refuses `auth` frames that switch subject. */
  private reidentify(): void {
    const previous = this.scope
    const before = this.restoring
    this.track(
      (async () => {
        await before
        if ((await this.subject()) === previous) return
        // The previous user's queue must not be sent as this user: it stays persisted for their return.
        this.abandon(ErrorCode.Unauthorized, "The user changed")
        this.stale = []
        for (const listener of this.staleListeners) listener(this.stale)
        if (this.options.persist === undefined) this.scope = await this.subject()
        else await this.restore(this.options.persist)
      })(),
    )
    this.sid = undefined
    const socket = this.socket
    if (socket !== undefined) {
      this.detach()
      socket.close(1000)
    }
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.attempt = 0
    this.connect()
  }

  /** Drops every queued mutation's optimistic layer and rejects its promise. */
  private abandon(code: ErrorCode, reason: string): void {
    this.inFlight = 0
    for (const pending of this.outbox.splice(0)) {
      this.store.dropLayer(pending.message.id)
      pending.reject(new CanopyError(code, `${reason} before the server confirmed the mutation`))
    }
  }

  private async subject(): Promise<string> {
    const sub = claims(await this.options.auth?.getToken()).sub
    return typeof sub === "string" ? sub : "anon"
  }

  /** Brings persisted mutations back: recent ones are queued again, older ones become stale. */
  private async restore(persist: Persister): Promise<void> {
    const sub = claims(await this.options.auth?.getToken()).sub
    this.scope = typeof sub === "string" ? sub : "anon"
    const prefix = `${this.scope}\u0000`
    const cutoff = Date.now() - ((this.options.mutationTtlMs ?? 24 * HOUR) - 4 * HOUR)
    const restored: PendingMutation[] = []
    for (const [key, value] of await persist.entries("mutations")) {
      if (!key.startsWith(prefix)) continue
      const record = decode(JSON.parse(value)) as PersistedMutation
      if (record.at < cutoff) {
        this.stale.push(this.staleMutation(persist, key, record))
        continue
      }
      for (const layer of record.layers) this.store.addLayer(record.m.id, layer)
      restored.push({
        message: record.m,
        ids: record.ids,
        persisted: Promise.resolve(key),
        sent: false,
        resolve: () => {},
        reject: () => {},
      })
    }
    this.outbox.unshift(...restored)
    if (this.stale.length > 0) for (const listener of this.staleListeners) listener(this.stale)
  }

  private staleMutation(persist: Persister, key: string, record: PersistedMutation): StaleMutation {
    const forget = (): void => {
      const before = this.stale.length
      this.stale = this.stale.filter((entry) => entry.mutationId !== record.m.id)
      void persist.delete("mutations", key).catch(() => {})
      if (this.stale.length !== before)
        for (const listener of this.staleListeners) listener(this.stale)
    }
    return {
      mutationId: record.m.id,
      collection: record.m.c,
      op: record.m.op,
      args: record.m.args,
      createdAt: record.at,
      retry: () => {
        forget()
        return this.mutate(record.m.c, record.m.op, record.m.args, record.layers, record.ids)
      },
      discard: forget,
    }
  }

  /** The persisted mutations that were too old to replay and are not retried or discarded yet. */
  get staleMutations(): readonly StaleMutation[] {
    return this.stale
  }

  /**
   * Calls `listener` with the persisted mutations that are too old to replay (at once when some are
   * already known), and again whenever one is retried or discarded.
   */
  onStaleMutations(listener: (mutations: readonly StaleMutation[]) => void): () => void {
    this.staleListeners.add(listener)
    if (this.restoring === undefined && this.stale.length > 0) listener(this.stale)
    return () => this.staleListeners.delete(listener)
  }

  private watchLifecycle(): void {
    const target = globalThis as {
      addEventListener?: (type: string, listener: () => void) => void
      removeEventListener?: (type: string, listener: () => void) => void
      document?: { readonly visibilityState?: string }
    }
    const add = target.addEventListener
    const remove = target.removeEventListener
    const source = this.options.lifecycle
    const online = (): void => this.reconnectNow()
    const offline = (): void => {
      const socket = this.socket
      if (socket !== undefined) {
        this.detach()
        socket.close(4000, "offline")
      }
      if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
      if (!this.closed) this.setStatus("offline")
    }
    const wake = (): void => {
      if (target.document?.visibilityState === "hidden") return
      if (this.status === "reconnecting" && Date.now() - this.lastAttemptAt > 5000)
        this.reconnectNow()
    }
    if (typeof source === "function") {
      this.stopLifecycle = source({ online, offline, wake })
      return
    }
    if (source === false || add === undefined || remove === undefined) return
    const events: [string, () => void][] = [
      ["online", online],
      ["offline", offline],
      ["visibilitychange", wake],
      ["focus", wake],
    ]
    for (const [type, listener] of events) add.call(globalThis, type, listener)
    this.stopLifecycle = () => {
      for (const [type, listener] of events) remove.call(globalThis, type, listener)
    }
  }

  private static offline(): boolean {
    return (globalThis as { navigator?: { onLine?: boolean } }).navigator?.onLine === false
  }

  /** Calls `listener` whenever a mutation is rolled back. */
  onMutationError(listener: (error: Error, mutationId: string) => void): () => void {
    this.mutationErrorListeners.add(listener)
    return () => this.mutationErrorListeners.delete(listener)
  }

  /** The number of mutations not yet acknowledged. */
  get pendingMutations(): number {
    return this.outbox.length
  }

  private newId(collection: string): unknown {
    const type = this.options.idTypes?.[collection] ?? "objectId"
    if (type === "uuid") return decode({ $uuid: uuidv7() })
    if (type === "string")
      throw new TypeError(`Documents of ${collection} need an _id; its id type is string`)
    return new ObjectId()
  }

  /** Inserts a document. The optimistic copy, with a client generated `_id`, is visible at once. */
  insert<C extends CollectionName<DB>>(
    collection: C,
    doc: InsertOf<DB, C>,
  ): MutationHandle<IdOf<DocumentOf<DB, C>>> {
    const id = asDocument(doc)["_id"] ?? this.newId(collection)
    const full = { ...doc, _id: id }
    return this.mutate(
      collection,
      "insert",
      { doc: full },
      [{ kind: "insert", coll: collection, id, doc: full }],
      [id],
    ) as MutationHandle<IdOf<DocumentOf<DB, C>>>
  }

  /** Inserts several documents in one mutation. */
  insertMany<C extends CollectionName<DB>>(
    collection: C,
    docs: readonly InsertOf<DB, C>[],
  ): MutationHandle {
    const full = docs.map((doc) => ({
      ...asDocument(doc),
      _id: asDocument(doc)["_id"] ?? this.newId(collection),
    }))
    return this.mutate(
      collection,
      "insertMany",
      { docs: full },
      full.map((doc): Layer => ({ kind: "insert", coll: collection, id: doc["_id"], doc })),
      full.map((doc) => doc["_id"]),
    )
  }

  /** Updates one document with update operators. */
  update<C extends CollectionName<DB>>(
    collection: C,
    id: IdOf<DocumentOf<DB, C>>,
    changes: UpdateFilter<DocumentOf<DB, C>>,
    options: WriteOptions<DocumentOf<DB, C>> = {},
  ): MutationHandle {
    const update = asDocument(changes)
    return this.mutate(
      collection,
      "update",
      { id, update, ...(options.where === undefined ? {} : { where: asDocument(options.where) }) },
      [{ kind: "update", coll: collection, id, update }],
      [id],
    )
  }

  /** Replaces one document. With `upsert`, a missing document is inserted. */
  replace<C extends CollectionName<DB>>(
    collection: C,
    id: IdOf<DocumentOf<DB, C>>,
    replacement: InsertOf<DB, C>,
    options: ReplaceOptions<DocumentOf<DB, C>> = {},
  ): MutationHandle {
    const doc = asDocument(replacement)
    return this.mutate(
      collection,
      "replace",
      {
        id,
        doc,
        ...(options.where === undefined ? {} : { where: asDocument(options.where) }),
        ...(options.upsert === undefined ? {} : { upsert: options.upsert }),
      },
      [{ kind: "replace", coll: collection, id, doc, upsert: options.upsert === true }],
      [id],
    )
  }

  /** Deletes one document. */
  delete<C extends CollectionName<DB>>(
    collection: C,
    id: IdOf<DocumentOf<DB, C>>,
    options: WriteOptions<DocumentOf<DB, C>> = {},
  ): MutationHandle {
    return this.mutate(
      collection,
      "delete",
      { id, ...(options.where === undefined ? {} : { where: asDocument(options.where) }) },
      [{ kind: "delete", coll: collection, id }],
      [id],
    )
  }

  /** Updates every visible document matching `filter`. The optimistic change covers cached documents. */
  updateMany<C extends CollectionName<DB>>(
    collection: C,
    where: Filter<DocumentOf<DB, C>>,
    changes: UpdateFilter<DocumentOf<DB, C>>,
  ): MutationHandle {
    const filter = asDocument(where)
    const update = asDocument(changes)
    return this.mutate(
      collection,
      "updateMany",
      { filter, update, bulk: true },
      [{ kind: "updateMany", coll: collection, filter, update }],
      [],
    )
  }

  /** Deletes every visible document matching `filter`. */
  deleteMany<C extends CollectionName<DB>>(
    collection: C,
    where: Filter<DocumentOf<DB, C>>,
  ): MutationHandle {
    const filter = asDocument(where)
    return this.mutate(
      collection,
      "deleteMany",
      { filter, bulk: true },
      [{ kind: "deleteMany", coll: collection, filter }],
      [],
    )
  }

  private mutate(
    collection: string,
    op: MutationOp,
    args: Document,
    layers: readonly Layer[],
    ids: readonly unknown[],
  ): MutationHandle {
    const mutationId = uuidv7()
    let resolve: (result: MutationResult) => void = () => {}
    let reject: (error: Error) => void = () => {}
    const promise = new Promise<MutationResult>((ok, fail) => {
      resolve = ok
      reject = fail
    })
    promise.catch(() => {})
    if (this.closed) {
      reject(new CanopyError(ErrorCode.Unavailable, "The client is closed"))
    } else {
      for (const layer of layers) this.store.addLayer(mutationId, layer)
      const message: MutMessage = { t: "mut", id: mutationId, c: collection, op, args }
      const persist = this.options.persist
      const record: PersistedMutation = { m: message, ids, layers, at: Date.now() }
      const persisted =
        persist === undefined
          ? undefined
          : (this.restoring ?? Promise.resolve()).then(async () => {
              const key = `${this.scope}\u0000${mutationId}`
              await persist
                .set("mutations", key, JSON.stringify(encode(record)))
                .catch((error: unknown) =>
                  console.warn(
                    "Canopy could not store a queued mutation; it is lost if the page closes before it is sent",
                    error,
                  ),
                )
              return key
            })
      this.outbox.push({
        message,
        ids,
        ...(persisted === undefined ? {} : { persisted }),
        sent: false,
        resolve,
        reject,
      })
      this.pump()
    }
    return Object.assign(promise, { mutationId, id: ids[0] })
  }

  /** Sends queued mutations in order, keeping at most `maxInFlight` unacknowledged. */
  private pump(): void {
    if (this.restoring !== undefined) return
    if (this.socket === undefined || !this.welcomed || this.socket.readyState !== 1) return
    const max = this.options.maxInFlight ?? 32
    for (const pending of this.outbox) {
      if (this.inFlight >= max) break
      if (pending.sent) continue
      pending.sent = true
      this.inFlight += 1
      this.write(this.socket, encodeMessage(pending.message))
    }
  }

  private acknowledge(ack: AckMessage): void {
    const index = this.outbox.findIndex((pending) => pending.message.id === ack.m)
    if (index < 0) return
    const [pending] = this.outbox.splice(index, 1)
    if (pending === undefined) return
    if (pending.sent) this.inFlight = Math.max(0, this.inFlight - 1)
    const persist = this.options.persist
    if (persist !== undefined)
      void pending.persisted?.then((key) => persist.delete("mutations", key)).catch(() => {})
    const { message } = pending
    if (!ack.ok) {
      this.store.dropLayer(message.id)
      const error = errorFromWire(
        ack.err ?? { code: ErrorCode.Internal, msg: "The mutation failed" },
      )
      for (const listener of this.mutationErrorListeners) listener(error, message.id)
      pending.reject(error)
      this.pump()
      return
    }
    const ct = ack.ct ?? ZERO_CT
    if (ack.echo === true) this.store.dropLayer(message.id)
    else this.settleWithoutEcho(pending, ct, ack.res?.docs)
    pending.resolve({
      ct,
      echo: ack.echo === true,
      replayed: ack.replayed === true,
      matched: ack.res?.matched ?? 0,
      modified: ack.res?.modified ?? 0,
      insertedIds: ack.res?.insertedIds ?? [],
    })
    this.pump()
  }

  /**
   * Without an echo, post images in the ack become server state and the layer is dropped. Without them
   * (bulk writes, unreadable results) the layer stays until the server state catches up with the ack.
   */
  private settleWithoutEcho(
    pending: PendingMutation,
    ct: ClusterTime,
    docs: readonly Document[] | undefined,
  ): void {
    const { message } = pending
    const single = message.op !== "updateMany" && message.op !== "deleteMany"
    if (message.op === "delete") {
      for (const id of pending.ids) this.store.confirm(message.c, id, null, ct)
      this.store.dropLayer(message.id)
      return
    }
    const confirmed = new Set<unknown>()
    for (const doc of docs ?? []) {
      this.store.confirm(message.c, doc["_id"], doc, ct)
      confirmed.add(doc["_id"])
    }
    if (single && docs !== undefined && docs.length >= pending.ids.length) {
      this.store.dropLayer(message.id)
      return
    }
    this.store.awaitServer(message.id, ct)
  }

  private refetch(coll: string): void {
    for (const sub of this.subscriptions.values()) {
      if (sub.coll !== coll) continue
      this.store.beginResync(sub.id)
      this.send({ t: "sub", id: sub.id, c: sub.coll, q: sub.query })
    }
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
  from<C extends CollectionName<DB>>(
    collection: C,
  ): QueryBuilder<DocumentOf<DB, C>, InsertOf<DB, C>> {
    return new QueryBuilder(this as unknown as AnyClient, collection, {}, {})
  }

  /** Returns a live query; identical queries share one server subscription. */
  live<C extends CollectionName<DB>, Out = DocumentOf<DB, C>>(
    collection: C,
    where: Filter<DocumentOf<DB, C>>,
    options: LiveQueryOptions<DocumentOf<DB, C>> = {},
  ): LiveQuery<Out> {
    const filter = asDocument(where)
    const sort = options.sort as Readonly<Record<string, 1 | -1>> | undefined
    const fields = options.fields as Readonly<Record<string, 0 | 1>> | undefined
    const query: SubQuery = {
      filter,
      ...(sort === undefined ? {} : { sort: sort }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(fields === undefined ? {} : { fields: fields }),
    }
    const key = queryKey(collection, query)
    return {
      getState: () => {
        const sub = this.byQuery.get(key)
        if (sub === undefined)
          return (this.hydrated.get(key)?.state ?? LOADING_STATE) as QueryState<Out>
        return this.store.state(sub.id) as QueryState<Out>
      },
      subscribe: (listener) => {
        let sub = this.byQuery.get(key)
        if (sub === undefined) {
          sub = { id: `s${this.nextId}`, coll: collection, query, refs: 0 }
          this.nextId += 1
          this.byQuery.set(key, sub)
          this.subscriptions.set(sub.id, sub)
          this.store.addQuery(sub.id, collection, {
            filter,
            ...(sort === undefined ? {} : { sort: sort }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
            ...(fields === undefined
              ? {}
              : { project: (doc: Document) => compileProjection(fields).apply(doc) }),
          })
          this.send({ t: "sub", id: sub.id, c: collection, q: query })
          const seed = this.hydrated.get(key)
          if (seed !== undefined) {
            this.hydrated.delete(key)
            this.store.seed(
              sub.id,
              seed.state.data.map((doc) => ({ id: doc["_id"], doc, ct: seed.ct })),
            )
          }
          if (this.options.cacheDocuments === true) this.cache(sub, key)
        }
        sub.refs += 1
        const current = sub
        const stop = this.store.listen(current.id, () =>
          listener(this.store.state(current.id) as QueryState<Out>),
        )
        listener(this.store.state(current.id) as QueryState<Out>)
        return () => {
          stop()
          current.refs -= 1
          if (current.refs > 0) return
          const timer = this.saveTimers.get(current.id)
          if (timer !== undefined) clearTimeout(timer)
          this.saveTimers.delete(current.id)
          this.byQuery.delete(key)
          this.subscriptions.delete(current.id)
          this.store.removeQuery(current.id)
          this.send({ t: "unsub", id: current.id })
        }
      },
    }
  }

  /** Seeds a new query from the document cache and keeps the cache current once it is ready. */
  private cache(sub: Subscription, key: string): void {
    const persist = this.options.persist
    if (persist === undefined) return
    const cacheKey = (): string => `${this.scope}\u0000${key}`
    void (this.restoring ?? Promise.resolve())
      .then(() => persist.get("docs", cacheKey()))
      .then((text) => {
        if (text !== undefined && this.subscriptions.get(sub.id) === sub)
          this.store.seed(sub.id, decode(JSON.parse(text)) as CachedDocument[])
      })
      .catch(() => {})
    this.store.listen(sub.id, () => {
      if (this.store.state(sub.id).status !== "ready" || this.saveTimers.has(sub.id)) return
      this.saveTimers.set(
        sub.id,
        setTimeout(() => {
          this.saveTimers.delete(sub.id)
          if (this.subscriptions.get(sub.id) !== sub) return
          const docs = JSON.stringify(encode(this.store.members(sub.id)))
          void persist.set("docs", cacheKey(), docs).catch(() => {})
        }, 500),
      )
    })
  }

  private send(message: ClientMessage): void {
    if (this.socket !== undefined && this.welcomed && this.socket.readyState === 1)
      this.write(this.socket, encodeMessage(message))
  }

  private write(socket: WebSocketLike, text: string): void {
    for (const tap of this.taps) tap("out", text)
    socket.send(text)
  }

  /**
   * Seeds live queries with server rendered results (`dehydrate()` from `@canopy/client/server`). A
   * hydrated query shows its documents at once, as `stale`, and becomes `ready` when the server confirms
   * it; events older than the snapshot are ignored.
   */
  hydrate(state: DehydratedState): void {
    for (const encoded of state.queries) {
      const snapshot = decode(encoded) as Snapshot
      this.hydrated.set(queryKey(snapshot.c, snapshot.q), {
        state: { data: snapshot.docs, status: "stale", error: undefined },
        ct: snapshot.ct,
      })
    }
  }

  /** The client's internals, for `@canopy/devtools`. Not a stable API. */
  devtools(): ClientInternals {
    return {
      sid: this.sid,
      rung: this.rung,
      subscriptions: this.subscriptions,
      outbox: this.outbox,
      tap: (listener) => {
        this.taps.add(listener)
        return () => this.taps.delete(listener)
      },
      discard: (mutationId) =>
        this.acknowledge({
          t: "ack",
          m: mutationId,
          ok: false,
          seq: 0,
          err: { code: ErrorCode.Conflict, msg: "Discarded in devtools" },
        }),
    }
  }

  private webSocket(): WebSocketConstructor | undefined {
    return this.options.WebSocket ?? (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket
  }

  private connect(): void {
    if (this.closed) return
    const WebSocketImpl = this.webSocket()
    if (this.rung === 0 && WebSocketImpl === undefined) {
      if (this.options.fallback === undefined)
        throw new TypeError("No WebSocket implementation is available; pass one in options")
      void this.descend()
      return
    }
    if (CanopyClient.offline()) {
      this.setStatus("offline")
      return
    }
    this.lastAttemptAt = Date.now()
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting")
    const transport = this.ladder?.[this.rung - 1]
    let socket: WebSocketLike
    if (transport !== undefined)
      socket = transport.connect(
        this.httpUrl,
        this.options.fetch ?? globalThis.fetch.bind(globalThis),
      )
    else if (WebSocketImpl === undefined) return
    else
      socket =
        this.options.shared?.connect(this.socketUrl, SUBPROTOCOL, WebSocketImpl) ??
        new WebSocketImpl(this.socketUrl, SUBPROTOCOL)
    this.socket = socket
    this.welcomed = false
    socket.onopen = () => {
      this.hello(socket).catch(() => socket.close(4500, "token source failed"))
    }
    socket.onmessage = (event) => {
      if (typeof event.data === "string") this.receive(event.data)
    }
    socket.onclose = (event) => this.onClose(socket, event.code)
    socket.onerror = () => {}
  }

  private async hello(socket: WebSocketLike): Promise<void> {
    const source = this.options.auth
    const stale = this.staleToken && source?.refresh !== undefined
    this.staleToken = false
    const token = (await (stale ? source?.refresh?.() : source?.getToken())) ?? undefined
    if (this.socket !== socket || socket.readyState !== 1) return
    if (this.restoring === undefined) {
      const sub = claims(token).sub
      this.scope = typeof sub === "string" ? sub : "anon"
    }
    const message: ClientMessage = {
      t: "hello",
      v: PROTOCOL_VERSION,
      key: this.options.publishableKey,
      ...(token === undefined || token === null ? {} : { token }),
      ...(this.sid === undefined ? {} : { resume: { sid: this.sid, seq: this.lastSeq } }),
      caps: ["batch", "diff"],
      sdk: this.options.sdk ?? "canopy-js/0.1.0",
    }
    this.write(socket, encodeMessage(message))
    this.scheduleRefresh(token ?? undefined)
  }

  private scheduleRefresh(token: string | undefined): void {
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer)
    this.refreshTimer = undefined
    if (token === undefined || this.options.auth === undefined) return
    const expiry = tokenExpiry(token)
    if (expiry === undefined) return
    this.refreshAt(Date.now() + Math.max(1000, (expiry - Date.now()) * 0.8))
  }

  private refreshAt(at: number): void {
    const remaining = at - Date.now()
    if (remaining > MAX_TIMER_MS) {
      this.refreshTimer = setTimeout(() => this.refreshAt(at), MAX_TIMER_MS)
      return
    }
    this.refreshTimer = setTimeout(
      () => {
        Promise.resolve(this.options.auth?.getToken())
          .then((next) => {
            this.send({ t: "auth", token: next ?? "" })
            this.scheduleRefresh(next ?? undefined)
          })
          .catch(() => {})
      },
      Math.max(0, remaining),
    )
  }

  /** Feeds one server frame to the client. Public for transports and conformance tests. */
  receive(text: string): void {
    for (const tap of this.taps) tap("in", text)
    this.lastInbound = Date.now()
    const message = decodeServerMessage(text)
    if (message === undefined) return
    for (const part of unbatch(message)) {
      if (part.t === "pong") continue
      this.handle(part)
    }
  }

  private handle(message: SequencedMessage): void {
    if (message.t === "welcome") {
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
          this.send({ t: "sub", id: sub.id, c: sub.coll, q: sub.query })
        }
      } else this.store.resumed()
      this.inFlight = 0
      for (const pending of this.outbox) pending.sent = false
      this.setStatus(this.rung === 0 ? "live" : "fallback")
      this.pump()
      return
    }
    if (message.seq <= this.lastSeq) return
    this.lastSeq = message.seq
    switch (message.t) {
      case "added":
        this.store.added(message.c, message.id, message.d, message.ct, message.s)
        return
      case "changed":
        this.store.changed(message.c, message.id, message.ct, {
          ...(message.set === undefined ? {} : { set: message.set }),
          ...(message.unset === undefined ? {} : { unset: message.unset }),
          ...(message.replace === true && message.d !== undefined ? { replace: message.d } : {}),
        })
        return
      case "removed":
        this.store.removed(message.c, message.id, message.ct, message.s)
        return
      case "ready":
        this.store.ready(message.s)
        if (this.ladder?.[this.rung - 1]?.polling === true) this.store.markStale()
        return
      case "ack":
        this.acknowledge(message)
        return
      case "nosub": {
        if (message.err !== undefined) this.store.fail(message.s, errorFromWire(message.err))
        return
      }
      case "resync": {
        const ids = message.s ?? [...this.subscriptions.keys()]
        for (const id of ids) {
          const sub = this.subscriptions.get(id)
          if (sub === undefined) continue
          this.store.beginResync(id)
          this.send({ t: "sub", id, c: sub.coll, q: sub.query })
        }
        return
      }
      case "reconnect": {
        const socket = this.socket
        this.detach()
        socket?.close(1000, "server asked to reconnect")
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
        this.socket?.close(4000, "heartbeat timeout")
        return
      }
      this.send({ t: "ping", ts: Date.now() })
    }, this.heartbeatMs)
  }

  private detach(): void {
    this.socket = undefined
    this.welcomed = false
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
    if (!this.closed) this.store.markStale()
  }

  /** Moves one rung down the transport ladder, loading the fallback transports on first use. */
  private async descend(): Promise<void> {
    const source = this.options.fallback
    if (source === undefined) return
    try {
      this.ladder ??= (typeof source === "function" ? await source() : source).transports
    } catch {
      this.ladder = []
    }
    if (this.rung < this.ladder.length) {
      this.rung += 1
      this.attempt = 0
    }
    this.failures = []
    this.startProbe()
    this.scheduleReconnect(0)
  }

  private startProbe(): void {
    const WebSocketImpl = this.webSocket()
    if (this.probeTimer !== undefined || WebSocketImpl === undefined || this.rung === 0) return
    this.probeTimer = setInterval(() => {
      if (this.closed || this.rung === 0) return
      const probe = new WebSocketImpl(this.socketUrl, SUBPROTOCOL)
      probe.onopen = () => {
        probe.close(1000, "probe")
        this.ascend()
      }
      probe.onmessage = null
      probe.onerror = () => {}
      probe.onclose = null
    }, this.options.probeIntervalMs ?? 60_000)
  }

  /** Moves back to WebSocket after a successful probe; the session resumes there. */
  private ascend(): void {
    if (this.closed || this.rung === 0) return
    this.rung = 0
    this.failures = []
    if (this.probeTimer !== undefined) clearInterval(this.probeTimer)
    this.probeTimer = undefined
    const socket = this.socket
    this.detach()
    socket?.close(1000, "moving to WebSocket")
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.attempt = 0
    this.connect()
  }

  private onClose(socket: WebSocketLike, code: number): void {
    if (this.socket !== socket) return
    const welcomed = this.welcomed
    this.detach()
    if (this.closed) {
      this.setStatus("closed")
      return
    }
    const reaction = closeReaction(code)
    if (!reaction.reconnect) {
      this.setStatus("closed")
      return
    }
    if (!reaction.resume) this.sid = undefined
    if (reaction.refreshToken) this.staleToken = true
    if (!welcomed && code === 1006 && this.options.fallback !== undefined) {
      const now = Date.now()
      this.failures = [...this.failures.filter((at) => now - at < 10_000), now]
      if (this.failures.length >= 2) {
        void this.descend()
        return
      }
    }
    this.scheduleReconnect(reaction.minDelayMs)
  }

  private scheduleReconnect(minDelayMs: number): void {
    if (this.reconnectTimer !== undefined || this.closed) return
    if (CanopyClient.offline()) {
      this.setStatus("offline")
      return
    }
    this.setStatus("reconnecting")
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
    for (const timer of [this.heartbeatTimer, this.probeTimer])
      if (timer !== undefined) clearInterval(timer)
    for (const timer of this.saveTimers.values()) clearTimeout(timer)
    this.stopLifecycle?.()
    this.stopAuth?.()
    if (this.socket !== undefined && this.socket.readyState === 1)
      this.write(this.socket, encodeMessage({ t: "bye" }))
    this.socket?.close(1000, "bye")
    this.store.dispose()
    this.abandon(ErrorCode.Unavailable, "The client was closed")
    this.setStatus("closed")
  }
}

/** Creates a client and starts connecting. */
/**
 * Creates a client and starts connecting. Pass the generated `Database` type to check every query and
 * write against your collections: `createClient<Database>({ ... })`.
 */
export function createClient<DB extends Schema<DB> = UntypedSchema>(
  options: ClientOptions,
): CanopyClient<DB> {
  return new CanopyClient<DB>(options)
}
