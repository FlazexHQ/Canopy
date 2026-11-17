import { withIdTieBreaker } from "@canopy/matcher"
import { type ClusterTime, snapshotTimeOf, toBsonLibrary, toCt, ZERO_CT } from "@canopy/protocol"
import { BSON, type Db, type Document, type MongoClient } from "mongodb"
import { type Doc, docKey } from "./event.ts"
import type { RealtimeMetrics } from "./metrics.ts"
import type { SnapshotReader } from "./observers.ts"

/** Limits concurrent work, first come first served (the snapshot queue). */
export class Semaphore {
  private active = 0
  private readonly queue: (() => void)[] = []
  private readonly capacity: number
  private readonly onDepth: ((depth: number) => void) | undefined

  constructor(capacity: number, onDepth?: (depth: number) => void) {
    this.capacity = capacity
    this.onDepth = onDepth
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.capacity) {
      await new Promise<void>((resolve) => {
        this.queue.push(resolve)
        this.onDepth?.(this.queue.length)
      })
    }
    this.active += 1
    try {
      return await task()
    } finally {
      this.active -= 1
      const next = this.queue.shift()
      this.onDepth?.(this.queue.length)
      next?.()
    }
  }
}

/** Read options that keep every BSON type exact, so in-process matching agrees with MongoDB. */
export const EXACT_BSON = { promoteValues: false, bsonRegExp: true } as const

/**
 * Reads query results in a snapshot session and reports the snapshot's cluster time. Every write with
 * `ct <= T` is in the result, so change events with `ct <= T` are already included (the session's
 * `snapshotTime`, with `operationTime` as the fallback).
 */
export class MongoSnapshotReader implements SnapshotReader {
  private readonly client: MongoClient
  private readonly db: Db
  private readonly queue: Semaphore
  private readonly metrics: RealtimeMetrics | undefined
  private readonly maxTimeMS: number

  constructor(
    client: MongoClient,
    db: Db,
    options: { concurrency: number; metrics?: RealtimeMetrics; maxTimeMS?: number },
  ) {
    this.client = client
    this.db = db
    this.metrics = options.metrics
    this.maxTimeMS = options.maxTimeMS ?? 30_000
    this.queue = new Semaphore(options.concurrency, (depth) =>
      this.metrics?.snapshotQueueDepth.set(depth),
    )
  }

  async read(query: {
    readonly coll: string
    readonly filter: Record<string, unknown>
    readonly sort: Readonly<Record<string, 1 | -1>> | undefined
    readonly limit: number | undefined
  }): Promise<{ docs: Doc[]; ct: ClusterTime }> {
    return this.queue.run(async () => {
      const started = performance.now()
      const session = this.client.startSession({ snapshot: true })
      try {
        let cursor = this.db
          .collection(query.coll)
          .find(toBsonLibrary(query.filter, BSON) as Document, {
            session,
            ...EXACT_BSON,
            maxTimeMS: this.maxTimeMS,
          })
          .sort(withIdTieBreaker(query.sort ?? {}) as Record<string, 1 | -1>)
        if (query.limit !== undefined) cursor = cursor.limit(query.limit)
        const docs = (await cursor.toArray()) as Doc[]
        const ct = snapshotTimeOf(session) ?? toCt(session.operationTime) ?? ZERO_CT
        this.metrics?.snapshotSeconds.observe((performance.now() - started) / 1000)
        return { docs, ct }
      } finally {
        await session.endSession()
      }
    })
  }

  /** Fetches current documents by `_id`, for the lazy post image resolver. */
  async lookup(coll: string, ids: readonly unknown[]): Promise<Map<string, Doc>> {
    const out = new Map<string, Doc>()
    if (ids.length === 0) return out
    const docs = await this.db
      .collection(coll)
      .find({ _id: { $in: [...ids] } } as Document, EXACT_BSON)
      .toArray()
    for (const doc of docs) out.set(docKey(coll, doc["_id"]), doc as Doc)
    this.metrics?.lazyLookups.inc({}, ids.length)
    return out
  }
}
