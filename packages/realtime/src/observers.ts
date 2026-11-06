import { type CompiledFilter, compileSort, type DocComparator } from "@canopy/matcher"
import {
  CanopyError,
  type ClusterTime,
  canonicalString,
  compareCt,
  ErrorCode,
  maxCt,
} from "@canopy/protocol"
import { type Doc, docKey, type NormalizedEvent } from "./event.ts"

/** A query an observer keeps current. */
export interface ObservedQuery {
  readonly coll: string
  /** The effective filter: the caller's filter AND `USING(read)`. */
  readonly filter: Record<string, unknown>
  readonly sort: Readonly<Record<string, 1 | -1>> | undefined
  readonly limit: number | undefined
  /** Strips fields the caller may not read. Applied before anything is stored or sent. */
  readonly readable: (doc: Doc) => Doc
}

/** Reads query results from MongoDB at a known cluster time. */
export interface SnapshotReader {
  read(query: {
    readonly coll: string
    readonly filter: Record<string, unknown>
    readonly sort: Readonly<Record<string, 1 | -1>> | undefined
    readonly limit: number | undefined
  }): Promise<{ readonly docs: readonly Doc[]; readonly ct: ClusterTime }>
}

/** Receives the changes of one observer for one subscription. */
export interface ObserverListener {
  added(key: string, id: unknown, doc: Doc, ct: ClusterTime): void
  changed(key: string, id: unknown, doc: Doc, ct: ClusterTime): void
  removed(key: string, id: unknown, ct: ClusterTime): void
  ready(ct: ClusterTime): void
  failed(error: CanopyError): void
}

/** Hooks the registry uses to keep the membership index current. */
export interface MembershipHooks {
  memberAdded(observer: Observer, key: string): void
  memberRemoved(observer: Observer, key: string): void
}

/** The observer types: in process filter, sorted window, and MongoDB polling. */
export type ObserverType = "filter" | "window" | "polling"

/** Limits that apply to observers. */
export interface ObserverLimits {
  /** Documents a filter observer may track. */
  readonly maxTrackedDocs: number
  /** Look ahead documents kept behind a window, at most `min(limit, this)`. */
  readonly maxBuffer: number
  /** Minimum time between window re-queries, in milliseconds. */
  readonly requeryIntervalMs: number
  /** Minimum and maximum time between polling re-runs, in milliseconds. */
  readonly pollMinMs: number
  readonly pollMaxMs: number
}

interface Member {
  readonly id: unknown
  doc: Doc
}

function sameDoc(a: Doc, b: Doc): boolean {
  return canonicalString(a) === canonicalString(b)
}

/**
 * Maintains the live result of one effective query and fans it out to every subscription that shares it
 *. Subscriptions attach at any time: a live observer serves them from its state, a loading one
 * queues them until its snapshot is complete. Events that arrive while a snapshot runs are buffered and
 * applied afterwards when their cluster time is after the snapshot's.
 */
export abstract class Observer {
  readonly key: string
  readonly query: ObservedQuery
  abstract readonly type: ObserverType
  protected readonly reader: SnapshotReader
  protected readonly hooks: MembershipHooks
  protected readonly limits: ObserverLimits
  protected readonly listeners = new Set<ObserverListener>()
  private readonly waiting = new Set<ObserverListener>()
  protected state: "idle" | "loading" | "live" | "failed" = "idle"
  protected ct: ClusterTime = "0"
  private buffered: NormalizedEvent[] = []
  private failure: CanopyError | undefined
  private refreshing = false
  private refreshAgain = false
  private muted = false

  constructor(
    key: string,
    query: ObservedQuery,
    reader: SnapshotReader,
    hooks: MembershipHooks,
    limits: ObserverLimits,
  ) {
    this.key = key
    this.query = query
    this.reader = reader
    this.hooks = hooks
    this.limits = limits
  }

  /** The number of attached subscriptions. */
  get size(): number {
    return this.listeners.size + this.waiting.size
  }

  /** The cluster time the observer's state reflects. */
  get clusterTime(): ClusterTime {
    return this.ct
  }

  /** Whether the observer currently tracks the document (in its window or its look ahead buffer). */
  abstract has(key: string): boolean

  /** Every document key the observer tracks. */
  protected abstract trackedKeys(): Iterable<string>

  protected notifyAdded(key: string, id: unknown, doc: Doc, ct: ClusterTime): void {
    if (this.muted) return
    for (const listener of this.listeners) listener.added(key, id, doc, ct)
  }

  protected notifyChanged(key: string, id: unknown, doc: Doc, ct: ClusterTime): void {
    if (this.muted) return
    for (const listener of this.listeners) listener.changed(key, id, doc, ct)
  }

  protected notifyRemoved(key: string, id: unknown, ct: ClusterTime): void {
    if (this.muted) return
    for (const listener of this.listeners) listener.removed(key, id, ct)
  }

  /** The documents the observer currently shows, in order. */
  protected abstract visible(): readonly (readonly [string, Member])[]

  /** Loads the initial state from a snapshot. */
  protected abstract load(docs: readonly Doc[], ct: ClusterTime): void

  /** Applies one event to the state and reports the visible changes. */
  protected abstract applyEvent(event: NormalizedEvent): void

  /** Attaches a subscription. */
  attach(listener: ObserverListener): void {
    if (this.state === "failed" && this.failure !== undefined) {
      listener.failed(this.failure)
      return
    }
    if (this.state !== "live") {
      this.waiting.add(listener)
      if (this.state === "idle") this.start()
      return
    }
    this.serve(listener)
  }

  /** Detaches a subscription. Returns true when no subscription is left. */
  detach(listener: ObserverListener): boolean {
    this.listeners.delete(listener)
    this.waiting.delete(listener)
    return this.size === 0
  }

  private serve(listener: ObserverListener): void {
    for (const [key, member] of this.visible()) listener.added(key, member.id, member.doc, this.ct)
    listener.ready(this.ct)
    this.listeners.add(listener)
  }

  private start(): void {
    this.state = "loading"
    this.refresh(true)
  }

  /** Re-reads the query from MongoDB and diffs the result into the visible state. */
  protected refresh(initial = false): void {
    if (this.refreshing) {
      this.refreshAgain = true
      return
    }
    this.refreshing = true
    const before = initial ? new Map<string, Member>() : new Map(this.visible())
    this.reader
      .read({
        coll: this.query.coll,
        filter: this.query.filter,
        sort: this.query.sort,
        limit: this.readLimit(),
      })
      .then(
        ({ docs, ct }) => {
          this.refreshing = false
          if (this.state === "failed") return
          const pending = this.buffered
          this.buffered = []
          this.muted = true
          try {
            this.load(
              docs.map((doc) => this.query.readable(doc)),
              ct,
            )
            this.ct = maxCt(this.ct, ct)
            for (const event of pending) {
              if (compareCt(event.ct, ct) > 0) {
                this.applyEvent(event)
                this.ct = maxCt(this.ct, event.ct)
              }
            }
          } finally {
            this.muted = false
          }
          if (this.isFailed()) return
          if (initial) {
            this.state = "live"
            const waiting = [...this.waiting]
            this.waiting.clear()
            for (const listener of waiting) this.serve(listener)
          } else {
            this.emitDiff(before, this.ct)
          }
          if (this.refreshAgain) {
            this.refreshAgain = false
            this.refresh()
          }
        },
        (error: unknown) => {
          this.refreshing = false
          this.fail(
            error instanceof CanopyError
              ? error
              : new CanopyError(ErrorCode.Unavailable, "Snapshot failed", { cause: error }),
          )
        },
      )
  }

  /** The number of documents a snapshot reads. */
  protected readLimit(): number | undefined {
    return this.query.limit
  }

  /** Whether the observer failed and serves nothing. */
  isFailed(): boolean {
    return this.state === "failed"
  }

  /** Marks the observer as failed and ends every subscription with the error. */
  fail(error: CanopyError): void {
    if (this.state === "failed") return
    this.state = "failed"
    this.failure = error
    for (const key of [...this.trackedKeys()]) this.hooks.memberRemoved(this, key)
    const all = [...this.listeners, ...this.waiting]
    this.listeners.clear()
    this.waiting.clear()
    for (const listener of all) listener.failed(error)
  }

  /** Routes an event to the observer. */
  apply(event: NormalizedEvent): void {
    if (this.state === "failed" || this.state === "idle") return
    if (this.state === "loading" || this.refreshing) {
      this.buffered.push(event)
      return
    }
    this.applyEvent(event)
    this.ct = maxCt(this.ct, event.ct)
  }

  /** Records that the stream advanced, so `ready` for new subscriptions carries a current time. */
  advance(ct: ClusterTime): void {
    if (this.state === "live" && !this.refreshing) this.ct = maxCt(this.ct, ct)
  }

  protected emitDiff(before: ReadonlyMap<string, Member>, ct: ClusterTime): void {
    const after = new Map(this.visible())
    for (const [key, member] of before) {
      if (!after.has(key)) this.notifyRemoved(key, member.id, ct)
    }
    for (const [key, member] of after) {
      const previous = before.get(key)
      if (previous === undefined) this.notifyAdded(key, member.id, member.doc, ct)
      else if (!sameDoc(previous.doc, member.doc))
        this.notifyChanged(key, member.id, member.doc, ct)
    }
  }
}

/** Matcher safe filter, no limit. Tracks members, capped at `maxTrackedDocs`. */
export class FilterObserver extends Observer {
  readonly type: ObserverType = "filter"
  private readonly matcher: CompiledFilter
  private members = new Map<string, Member>()

  constructor(
    key: string,
    query: ObservedQuery,
    matcher: CompiledFilter,
    reader: SnapshotReader,
    hooks: MembershipHooks,
    limits: ObserverLimits,
  ) {
    super(key, query, reader, hooks, limits)
    this.matcher = matcher
  }

  has(key: string): boolean {
    return this.members.has(key)
  }

  protected trackedKeys(): Iterable<string> {
    return this.members.keys()
  }

  protected visible(): readonly (readonly [string, Member])[] {
    return [...this.members.entries()]
  }

  protected override readLimit(): number {
    return this.limits.maxTrackedDocs + 1
  }

  protected load(docs: readonly Doc[]): void {
    if (docs.length > this.limits.maxTrackedDocs) {
      this.fail(
        new CanopyError(
          ErrorCode.SubscriptionTooLarge,
          `The subscription matches more than ${this.limits.maxTrackedDocs} documents; add a limit`,
        ),
      )
      return
    }
    for (const key of this.members.keys()) this.hooks.memberRemoved(this, key)
    this.members = new Map()
    for (const doc of docs) {
      const key = docKey(this.query.coll, doc["_id"])
      this.members.set(key, { id: doc["_id"], doc })
      this.hooks.memberAdded(this, key)
    }
  }

  protected applyEvent(event: NormalizedEvent): void {
    const before = this.members.get(event.key)
    let after: boolean
    if (event.op === "delete") after = false
    else if (event.post === undefined || event.post === null) return
    else after = this.matcher.matches(event.post)
    if (after && event.post !== null && event.post !== undefined) {
      const doc = this.query.readable(event.post)
      if (before === undefined) {
        if (this.members.size >= this.limits.maxTrackedDocs) {
          this.fail(
            new CanopyError(
              ErrorCode.SubscriptionTooLarge,
              "The subscription grew beyond the tracked document limit",
            ),
          )
          return
        }
        this.members.set(event.key, { id: event.id, doc })
        this.hooks.memberAdded(this, event.key)
        this.notifyAdded(event.key, event.id, doc, event.ct)
      } else if (!sameDoc(before.doc, doc)) {
        before.doc = doc
        this.notifyChanged(event.key, event.id, doc, event.ct)
      }
      return
    }
    if (before !== undefined) {
      this.members.delete(event.key)
      this.hooks.memberRemoved(this, event.key)
      this.notifyRemoved(event.key, before.id, event.ct)
    }
  }
}

interface Ranked {
  readonly key: string
  readonly member: Member
}

/**
 * Matcher safe filter with sort and limit. Keeps the window plus a look ahead buffer. When the
 * known documents no longer fill the window and the result may hold more, it re-queries (at most every
 * `requeryIntervalMs`).
 */
export class WindowObserver extends Observer {
  readonly type: ObserverType = "window"
  private readonly matcher: CompiledFilter
  private readonly compare: DocComparator
  private known: Ranked[] = []
  private complete = true
  private requeryTimer: ReturnType<typeof setTimeout> | undefined
  private lastRequery = 0

  constructor(
    key: string,
    query: ObservedQuery,
    matcher: CompiledFilter,
    reader: SnapshotReader,
    hooks: MembershipHooks,
    limits: ObserverLimits,
  ) {
    super(key, query, reader, hooks, limits)
    this.matcher = matcher
    this.compare = compileSort(query.sort ?? {})
  }

  private get limit(): number {
    return this.query.limit ?? 0
  }

  private get capacity(): number {
    return this.limit + Math.min(this.limit, this.limits.maxBuffer)
  }

  has(key: string): boolean {
    return this.known.some((entry) => entry.key === key)
  }

  protected trackedKeys(): Iterable<string> {
    return this.known.map((entry) => entry.key)
  }

  protected visible(): readonly (readonly [string, Member])[] {
    return this.known.slice(0, this.limit).map((entry) => [entry.key, entry.member] as const)
  }

  protected override readLimit(): number {
    return this.capacity
  }

  protected load(docs: readonly Doc[]): void {
    for (const entry of this.known) this.hooks.memberRemoved(this, entry.key)
    this.known = docs.map((doc) => ({
      key: docKey(this.query.coll, doc["_id"]),
      member: { id: doc["_id"], doc },
    }))
    this.known.sort((a, b) => this.compare(a.member.doc, b.member.doc))
    this.complete = docs.length < this.capacity
    for (const entry of this.known) this.hooks.memberAdded(this, entry.key)
  }

  protected applyEvent(event: NormalizedEvent): void {
    const before = new Map(this.visible())
    const index = this.known.findIndex((entry) => entry.key === event.key)
    if (event.op !== "delete" && (event.post === undefined || event.post === null)) {
      if (index >= 0) this.scheduleRequery()
      return
    }
    if (index >= 0) {
      const [removed] = this.known.splice(index, 1)
      if (removed !== undefined) this.hooks.memberRemoved(this, removed.key)
    }
    const post = event.op === "delete" ? null : (event.post as Doc)
    if (post !== null && this.matcher.matches(post)) {
      const doc = this.query.readable(post)
      const entry: Ranked = { key: event.key, member: { id: event.id, doc } }
      let position = this.known.findIndex((other) => this.compare(doc, other.member.doc) < 0)
      if (position < 0) position = this.known.length
      if (this.complete || position < this.known.length) {
        this.known.splice(position, 0, entry)
        this.hooks.memberAdded(this, entry.key)
        while (this.known.length > this.capacity) {
          const dropped = this.known.pop()
          if (dropped !== undefined) this.hooks.memberRemoved(this, dropped.key)
          this.complete = false
        }
      } else if (index >= 0) {
        this.complete = false
      }
    }
    if (!this.complete && this.known.length < this.limit) this.scheduleRequery()
    this.emitDiff(before, event.ct)
  }

  private scheduleRequery(): void {
    if (this.requeryTimer !== undefined) return
    const wait = Math.max(0, this.lastRequery + this.limits.requeryIntervalMs - Date.now())
    this.requeryTimer = setTimeout(() => {
      this.requeryTimer = undefined
      this.lastRequery = Date.now()
      this.refresh()
    }, wait)
  }

  override fail(error: CanopyError): void {
    if (this.requeryTimer !== undefined) clearTimeout(this.requeryTimer)
    super.fail(error)
  }

  /** Stops timers. */
  dispose(): void {
    if (this.requeryTimer !== undefined) clearTimeout(this.requeryTimer)
    this.requeryTimer = undefined
  }
}

/**
 * Anything the matcher cannot evaluate: re-runs the query in MongoDB after events in its
 * namespace, throttled, backing off under load, and diffs the result.
 */
export class PollingObserver extends Observer {
  readonly type: ObserverType = "polling"
  private members = new Map<string, Member>()
  private order: string[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private interval: number
  private lastRun = 0

  constructor(
    key: string,
    query: ObservedQuery,
    reader: SnapshotReader,
    hooks: MembershipHooks,
    limits: ObserverLimits,
  ) {
    super(key, query, reader, hooks, limits)
    this.interval = limits.pollMinMs
  }

  has(key: string): boolean {
    return this.members.has(key)
  }

  protected trackedKeys(): Iterable<string> {
    return this.members.keys()
  }

  protected visible(): readonly (readonly [string, Member])[] {
    return this.order.flatMap((key) => {
      const member = this.members.get(key)
      return member === undefined ? [] : [[key, member] as const]
    })
  }

  protected load(docs: readonly Doc[]): void {
    for (const key of this.members.keys()) this.hooks.memberRemoved(this, key)
    this.members = new Map()
    this.order = []
    for (const doc of docs) {
      const key = docKey(this.query.coll, doc["_id"])
      this.members.set(key, { id: doc["_id"], doc })
      this.order.push(key)
      this.hooks.memberAdded(this, key)
    }
  }

  protected applyEvent(): void {
    this.schedule()
  }

  /** Re-runs the query soon. Also used for periodic re-snapshots of time based policies. */
  schedule(): void {
    if (this.timer !== undefined) {
      this.interval = Math.min(this.limits.pollMaxMs, this.interval * 2)
      return
    }
    const wait = Math.max(0, this.lastRun + this.interval - Date.now())
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.lastRun = Date.now()
      this.interval = Math.max(this.limits.pollMinMs, Math.floor(this.interval / 2))
      this.refresh()
    }, wait)
  }

  override fail(error: CanopyError): void {
    this.dispose()
    super.fail(error)
  }

  /** Stops timers. */
  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }
}
