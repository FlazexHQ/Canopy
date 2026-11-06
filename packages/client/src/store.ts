import { compileSort, type DocComparator } from "@canopy/matcher"
import { type ClusterTime, canonicalString, compareCt, type Document } from "@canopy/protocol"

/** One cached document, reduced to the read path. */
interface DocEntry {
  readonly coll: string
  readonly id: unknown
  doc: Document | undefined
  ct: ClusterTime
  readonly subs: Set<string>
}

/** The cache key of a document: `collection/canonical(_id)`. */
export function cacheKey(coll: string, id: unknown): string {
  return `${coll}/${canonicalString(id)}`
}

/** The status of a live query. */
export type QueryStatus = "loading" | "ready" | "stale" | "error"

/** What a live query exposes. `data` keeps object identity for unchanged documents. */
export interface QueryState<T = Document> {
  readonly data: readonly T[]
  readonly status: QueryStatus
  readonly error: Error | undefined
}

interface QueryEntry {
  readonly id: string
  readonly coll: string
  readonly compare: DocComparator
  status: QueryStatus
  error: Error | undefined
  unconfirmed: Set<string> | undefined
  state: QueryState
  dirty: boolean
}

/**
 * The normalized document cache. Server state only moves forward: a message older than the
 * cached state is ignored, ties are applied because `set` values are absolute.
 */
/** The state of a query that has no data yet. One shared frozen value, so snapshots stay referentially stable. */
export const LOADING_STATE: QueryState<never> = Object.freeze({
  data: Object.freeze([]),
  status: "loading",
  error: undefined,
})

export class Store {
  private readonly docs = new Map<string, DocEntry>()
  private readonly queries = new Map<string, QueryEntry>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private scheduled = false

  /** Registers a live query. */
  addQuery(id: string, coll: string, sort: Readonly<Record<string, 1 | -1>> | undefined): void {
    this.queries.set(id, {
      id,
      coll,
      compare: compileSort(sort ?? {}),
      status: "loading",
      error: undefined,
      unconfirmed: undefined,
      state: { data: [], status: "loading", error: undefined },
      dirty: true,
    })
  }

  /** Removes a live query and its memberships. */
  removeQuery(id: string): void {
    this.queries.delete(id)
    for (const [key, entry] of this.docs) {
      entry.subs.delete(id)
      if (entry.subs.size === 0) this.docs.delete(key)
    }
  }

  /** Subscribes to state changes of one query. */
  listen(id: string, listener: () => void): () => void {
    const set = this.listeners.get(id) ?? new Set()
    set.add(listener)
    this.listeners.set(id, set)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(id)
    }
  }

  /** The current state of a query. */
  state(id: string): QueryState {
    const query = this.queries.get(id)
    if (query === undefined) return LOADING_STATE
    if (query.dirty) {
      query.dirty = false
      const members: Document[] = []
      for (const entry of this.docs.values()) {
        if (entry.coll === query.coll && entry.subs.has(id) && entry.doc !== undefined)
          members.push(entry.doc)
      }
      members.sort(query.compare)
      const previous = query.state.data
      const same =
        previous.length === members.length && previous.every((doc, index) => doc === members[index])
      query.state = {
        data: same ? previous : members,
        status: query.status,
        error: query.error,
      }
    }
    return query.state
  }

  private touch(ids: Iterable<string>): void {
    for (const id of ids) {
      const query = this.queries.get(id)
      if (query !== undefined) query.dirty = true
    }
    this.schedule()
  }

  private schedule(): void {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      for (const [id, query] of this.queries) {
        if (!query.dirty) continue
        const before = query.state
        const after = this.state(id)
        if (before === after) continue
        for (const listener of this.listeners.get(id) ?? []) listener()
      }
    })
  }

  private entry(coll: string, id: unknown): DocEntry {
    const key = cacheKey(coll, id)
    let entry = this.docs.get(key)
    if (entry === undefined) {
      entry = { coll, id, doc: undefined, ct: "0", subs: new Set() }
      this.docs.set(key, entry)
    }
    return entry
  }

  /** Applies `added`: the document enters subscriptions, with its content when `d` is present. */
  added(
    coll: string,
    id: unknown,
    doc: Document | undefined,
    ct: ClusterTime,
    subs: readonly string[],
  ): void {
    const entry = this.entry(coll, id)
    const key = cacheKey(coll, id)
    if (doc !== undefined && compareCt(ct, entry.ct) >= 0) {
      if (entry.doc === undefined || canonicalString(entry.doc) !== canonicalString(doc))
        entry.doc = doc
      entry.ct = ct
    }
    const affected = new Set(entry.subs)
    for (const sub of subs) {
      entry.subs.add(sub)
      affected.add(sub)
      this.queries.get(sub)?.unconfirmed?.delete(key)
    }
    this.touch(affected)
  }

  /** Applies `changed`: a document level update, once for every subscription that holds it. */
  changed(
    coll: string,
    id: unknown,
    ct: ClusterTime,
    change: { set?: Document; unset?: readonly string[]; replace?: Document },
  ): void {
    const entry = this.docs.get(cacheKey(coll, id))
    if (entry === undefined || compareCt(ct, entry.ct) < 0) return
    const next: Document =
      change.replace === undefined
        ? { ...(entry.doc ?? {}), ...(change.set ?? {}) }
        : { ...change.replace }
    if (change.replace === undefined) for (const field of change.unset ?? []) delete next[field]
    entry.ct = ct
    if (entry.doc !== undefined && canonicalString(entry.doc) === canonicalString(next)) return
    entry.doc = next
    this.touch(entry.subs)
  }

  /** Applies `removed`: the document leaves subscriptions. */
  removed(coll: string, id: unknown, ct: ClusterTime, subs: readonly string[]): void {
    const key = cacheKey(coll, id)
    const entry = this.docs.get(key)
    if (entry === undefined) return
    if (compareCt(ct, entry.ct) > 0) entry.ct = ct
    for (const sub of subs) entry.subs.delete(sub)
    if (entry.subs.size === 0) this.docs.delete(key)
    this.touch(subs)
  }

  /** Marks the query ready, dropping members a resync did not confirm. */
  ready(id: string): void {
    const query = this.queries.get(id)
    if (query === undefined) return
    const unconfirmed = query.unconfirmed
    query.unconfirmed = undefined
    if (unconfirmed !== undefined) {
      for (const key of unconfirmed) {
        const entry = this.docs.get(key)
        if (entry === undefined) continue
        entry.subs.delete(id)
        if (entry.subs.size === 0) this.docs.delete(key)
      }
    }
    query.status = "ready"
    query.error = undefined
    this.touch([id])
  }

  /**
   * Starts a resync of a query: every current member becomes unconfirmed; the cache stays in place, so the UI
   * changes only where data really changed.
   */
  beginResync(id: string): void {
    const query = this.queries.get(id)
    if (query === undefined) return
    const unconfirmed = new Set<string>()
    for (const [key, entry] of this.docs) if (entry.subs.has(id)) unconfirmed.add(key)
    query.unconfirmed = unconfirmed
    if (query.status === "ready") query.status = "stale"
    this.touch([id])
  }

  /** Ends a query with an error. */
  fail(id: string, error: Error): void {
    const query = this.queries.get(id)
    if (query === undefined) return
    query.status = "error"
    query.error = error
    this.touch([id])
  }

  /** Marks every query stale, for example while the connection is down. */
  markStale(): void {
    for (const query of this.queries.values()) {
      if (query.status === "ready") {
        query.status = "stale"
        query.dirty = true
      }
    }
    this.schedule()
  }

  /** The cached document, if any. */
  get(coll: string, id: unknown): Document | undefined {
    return this.docs.get(cacheKey(coll, id))?.doc
  }

  /** Number of cached documents. */
  get size(): number {
    return this.docs.size
  }
}
