import { equalityKey } from "@canopy/matcher"
import { isDocument, regexParts } from "@canopy/protocol"
import type { NormalizedEvent } from "./event.ts"
import type { MembershipHooks, Observer } from "./observers.ts"

const MAX_IN_VALUES = 32

/** An equality conjunct an observer is indexed under. */
interface IndexedConjunct {
  readonly field: string
  readonly keys: readonly string[]
}

function conjunctsOf(filter: Record<string, unknown>): Record<string, unknown>[] {
  const keys = Object.keys(filter)
  if (keys.length === 1 && keys[0] === "$and" && Array.isArray(filter["$and"])) {
    return (filter["$and"] as unknown[]).flatMap((part) =>
      isDocument(part) ? conjunctsOf(part) : [],
    )
  }
  return keys.map((key) => ({ [key]: filter[key] }))
}

function scalarKey(value: unknown): string | undefined {
  if (value === null || value === undefined || Array.isArray(value) || isDocument(value))
    return undefined
  if (regexParts(value) !== undefined) return undefined
  return equalityKey(value)
}

/**
 * Picks the equality conjunct to index an observer under: a top level `field: value`,
 * `field: { $eq: value }` or `field: { $in: [up to 32 values] }`. Policy conjuncts come last in the effective
 * filter, and single values are more selective than lists, so those are preferred.
 */
export function indexableConjunct(filter: Record<string, unknown>): IndexedConjunct | undefined {
  let best: IndexedConjunct | undefined
  for (const conjunct of conjunctsOf(filter).reverse()) {
    const [field] = Object.keys(conjunct)
    if (field === undefined || field.startsWith("$") || field.includes(".")) continue
    const value = conjunct[field]
    let keys: (string | undefined)[] | undefined
    if (isDocument(value)) {
      const ops = Object.keys(value)
      if (ops.length === 1 && ops[0] === "$eq") keys = [scalarKey(value["$eq"])]
      else if (
        ops.length === 1 &&
        ops[0] === "$in" &&
        Array.isArray(value["$in"]) &&
        value["$in"].length <= MAX_IN_VALUES
      ) {
        keys = (value["$in"] as unknown[]).map(scalarKey)
      }
    } else {
      keys = [scalarKey(value)]
    }
    if (keys === undefined || keys.length === 0 || keys.some((key) => key === undefined)) continue
    const candidate = { field, keys: keys as string[] }
    if (best === undefined || candidate.keys.length < best.keys.length) best = candidate
    if (best.keys.length === 1) break
  }
  return best
}

/** Lists the top level fields a filter or sort reads. */
export function referencedTopFields(filter: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(filter)) {
    for (const item of filter) referencedTopFields(item, out)
    return out
  }
  if (!isDocument(filter)) return out
  for (const key of Object.keys(filter)) {
    if (key === "$and" || key === "$or" || key === "$nor") referencedTopFields(filter[key], out)
    else if (!key.startsWith("$")) out.add(key.split(".")[0] ?? key)
  }
  return out
}

interface CollectionIndex {
  readonly byValue: Map<string, Map<string, Set<Observer>>>
  readonly unindexed: Set<Observer>
  readonly byPath: Map<string, Set<Observer>>
  readonly polling: Set<Observer>
  readonly docRefs: Map<string, Set<Observer>>
  /** Observers reading a snapshot, which see every event of the collection until they are done. */
  readonly buffering: Set<Observer>
}

/**
 * Holds every observer and the three candidate indexes (by equality value, by membership and by path), so an event is evaluated only against
 * the observers it can affect.
 */
export class ObserverRegistry implements MembershipHooks {
  private readonly observers = new Map<string, Observer>()
  private readonly indexes = new Map<string, CollectionIndex>()
  private readonly conjuncts = new Map<Observer, IndexedConjunct | undefined>()
  private readonly paths = new Map<Observer, Set<string>>()
  /** The document keys each observer holds, so removing one observer touches only its own entries. */
  private readonly refs = new Map<Observer, Set<string>>()

  private index(coll: string): CollectionIndex {
    let index = this.indexes.get(coll)
    if (index === undefined) {
      index = {
        byValue: new Map(),
        unindexed: new Set(),
        byPath: new Map(),
        polling: new Set(),
        docRefs: new Map(),
        buffering: new Set(),
      }
      this.indexes.set(coll, index)
    }
    return index
  }

  /** Returns the observer for a key, if one exists. */
  get(key: string): Observer | undefined {
    return this.observers.get(key)
  }

  /** All observers. */
  all(): IterableIterator<Observer> {
    return this.observers.values()
  }

  /** Collections that have at least one observer. */
  collections(): string[] {
    return [...this.indexes.entries()]
      .filter(([, index]) => index.unindexed.size + index.polling.size + index.byValue.size > 0)
      .map(([coll]) => coll)
  }

  /** Registers a new observer and indexes it. */
  add(observer: Observer): void {
    this.observers.set(observer.key, observer)
    const index = this.index(observer.query.coll)
    if (observer.type === "polling") {
      index.polling.add(observer)
      return
    }
    const conjunct = indexableConjunct(observer.query.filter)
    this.conjuncts.set(observer, conjunct)
    if (conjunct === undefined) {
      index.unindexed.add(observer)
    } else {
      let byKey = index.byValue.get(conjunct.field)
      if (byKey === undefined) {
        byKey = new Map()
        index.byValue.set(conjunct.field, byKey)
      }
      for (const key of conjunct.keys) {
        let set = byKey.get(key)
        if (set === undefined) {
          set = new Set()
          byKey.set(key, set)
        }
        set.add(observer)
      }
    }
    const fields = referencedTopFields(observer.query.filter)
    for (const field of Object.keys(observer.query.sort ?? {}))
      fields.add(field.split(".")[0] ?? field)
    this.paths.set(observer, fields)
    for (const field of fields) {
      let set = index.byPath.get(field)
      if (set === undefined) {
        set = new Set()
        index.byPath.set(field, set)
      }
      set.add(observer)
    }
  }

  /** Removes an observer from every index. */
  remove(observer: Observer): void {
    this.observers.delete(observer.key)
    const index = this.index(observer.query.coll)
    index.polling.delete(observer)
    index.unindexed.delete(observer)
    index.buffering.delete(observer)
    const conjunct = this.conjuncts.get(observer)
    if (conjunct !== undefined) {
      const byKey = index.byValue.get(conjunct.field)
      for (const key of conjunct.keys) {
        byKey?.get(key)?.delete(observer)
        if (byKey?.get(key)?.size === 0) byKey.delete(key)
      }
      if (byKey?.size === 0) index.byValue.delete(conjunct.field)
    }
    this.conjuncts.delete(observer)
    for (const field of this.paths.get(observer) ?? []) {
      index.byPath.get(field)?.delete(observer)
      if (index.byPath.get(field)?.size === 0) index.byPath.delete(field)
    }
    this.paths.delete(observer)
    for (const key of this.refs.get(observer) ?? []) {
      const set = index.docRefs.get(key)
      set?.delete(observer)
      if (set?.size === 0) index.docRefs.delete(key)
    }
    this.refs.delete(observer)
  }

  memberAdded(observer: Observer, key: string): void {
    const index = this.index(observer.query.coll)
    let set = index.docRefs.get(key)
    if (set === undefined) {
      set = new Set()
      index.docRefs.set(key, set)
    }
    set.add(observer)
    let held = this.refs.get(observer)
    if (held === undefined) {
      held = new Set()
      this.refs.set(observer, held)
    }
    held.add(key)
  }

  buffering(observer: Observer, on: boolean): void {
    if (on && this.observers.get(observer.key) !== observer) return
    const index = this.index(observer.query.coll)
    if (on) index.buffering.add(observer)
    else index.buffering.delete(observer)
  }

  memberRemoved(observer: Observer, key: string): void {
    const index = this.index(observer.query.coll)
    const set = index.docRefs.get(key)
    set?.delete(observer)
    if (set?.size === 0) index.docRefs.delete(key)
    this.refs.get(observer)?.delete(key)
  }

  /**
   * Returns the observers an event can affect: those that hold the document, those whose
   * equality conjunct the new document satisfies, unindexed ones, polling ones, those reading a snapshot,
   * and for updates without a post image, those that read a changed field.
   */
  candidates(event: NormalizedEvent): Set<Observer> {
    const index = this.indexes.get(event.coll)
    const out = new Set<Observer>()
    if (index === undefined) return out
    for (const observer of index.docRefs.get(event.key) ?? []) out.add(observer)
    for (const observer of index.polling) out.add(observer)
    for (const observer of index.buffering) out.add(observer)
    if (event.op === "delete") return out
    const post = event.post
    if (post !== undefined && post !== null) {
      for (const observer of index.unindexed) out.add(observer)
      for (const [field, byKey] of index.byValue) {
        const value = post[field]
        const values = Array.isArray(value) ? value : [value]
        for (const item of values) {
          const key = scalarKey(item)
          if (key === undefined) continue
          for (const observer of byKey.get(key) ?? []) out.add(observer)
        }
      }
      return out
    }
    if (event.diff !== undefined) {
      const touched = new Set<string>()
      for (const path of [...Object.keys(event.diff.set), ...event.diff.unset])
        touched.add(path.split(".")[0] ?? path)
      for (const field of touched)
        for (const observer of index.byPath.get(field) ?? []) out.add(observer)
    } else {
      for (const observer of index.unindexed) out.add(observer)
      for (const byKey of index.byValue.values())
        for (const set of byKey.values()) for (const observer of set) out.add(observer)
    }
    return out
  }
}
