import { withIdTieBreaker } from "@canopy/matcher"
import {
  CanopyError,
  type ClusterTime,
  ctToParts,
  ErrorCode,
  snapshotTimeOf,
  toBsonLibrary,
  toCt,
} from "@canopy/protocol"
import {
  BSON,
  type Db,
  type Document,
  Long,
  type MongoClient,
  MongoServerError,
  Timestamp,
} from "mongodb"
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

/** MongoDB's `SnapshotUnavailable`: the requested time is not readable yet, for example during a catalog change. */
const SNAPSHOT_UNAVAILABLE = 246
const SNAPSHOT_ATTEMPTS = 5

/** The query a snapshot read runs. */
interface SnapshotQuery {
  readonly coll: string
  readonly filter: Record<string, unknown>
  readonly sort: Readonly<Record<string, 1 | -1>> | undefined
  readonly limit: number | undefined
}

/** Read options that keep every BSON type exact, so in-process matching agrees with MongoDB. */
export const EXACT_BSON = { promoteValues: false, bsonRegExp: true } as const

/**
 * Reads query results in a snapshot session and reports the snapshot's cluster time T. Every write with
 * `ct <= T` is in the result, so change events with `ct <= T` are already included. T is the session's
 * `snapshotTime`, never its `operationTime`, which can be later than the snapshot and would make the events
 * in between look delivered. A read of a collection that does not exist yet has no snapshot time: then a
 * cluster time T is taken and the read repeated at exactly T, so a write at or before T that was not yet
 * visible (such as the insert that creates the collection) is in the result rather than skipped as delivered.
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

  async read(query: SnapshotQuery): Promise<{ docs: Doc[]; ct: ClusterTime }> {
    return this.queue.run(async () => {
      const started = performance.now()
      const first = await this.readOnce(query)
      let result: { docs: Doc[]; ct: ClusterTime }
      if (first.ct !== undefined) {
        result = { docs: first.docs, ct: first.ct }
      } else {
        result = await this.readAtCurrentTime(query)
      }
      this.metrics?.snapshotSeconds.observe((performance.now() - started) / 1000)
      return result
    })
  }

  private async readOnce(
    query: SnapshotQuery,
  ): Promise<{ docs: Doc[]; ct: ClusterTime | undefined }> {
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
      return { docs, ct: snapshotTimeOf(session) }
    } finally {
      await session.endSession()
    }
  }

  /** Reads at a cluster time taken just before, retrying while MongoDB cannot serve that time yet. */
  private async readAtCurrentTime(query: SnapshotQuery): Promise<{ docs: Doc[]; ct: ClusterTime }> {
    for (let attempt = 1; ; attempt += 1) {
      const ct = await this.currentClusterTime()
      if (ct === undefined) {
        throw new CanopyError(ErrorCode.Internal, "The snapshot read has no cluster time")
      }
      try {
        return { docs: await this.readAt(query, ct), ct }
      } catch (error: unknown) {
        if (!(error instanceof MongoServerError) || error.code !== SNAPSHOT_UNAVAILABLE) throw error
        if (attempt >= SNAPSHOT_ATTEMPTS) throw error
      }
    }
  }

  /** Reads the query as of exactly `ct`, which MongoDB waits for until every write up to it is visible. */
  private async readAt(query: SnapshotQuery, ct: ClusterTime): Promise<Doc[]> {
    const { t, i } = ctToParts(ct)
    const reply = await this.db.command(
      {
        find: query.coll,
        filter: toBsonLibrary(query.filter, BSON) as Document,
        sort: withIdTieBreaker(query.sort ?? {}),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
        maxTimeMS: this.maxTimeMS,
        readConcern: { level: "snapshot", atClusterTime: new Timestamp({ t, i }) },
      },
      EXACT_BSON,
    )
    const docs: Doc[] = []
    let cursor = reply["cursor"] as { id: Long | number; firstBatch?: Doc[]; nextBatch?: Doc[] }
    for (;;) {
      docs.push(...(cursor.firstBatch ?? cursor.nextBatch ?? []))
      const id = cursor.id
      if (Long.isLong(id) ? id.isZero() : id === 0) return docs
      const more = await this.db.command(
        { getMore: id, collection: query.coll, maxTimeMS: this.maxTimeMS },
        EXACT_BSON,
      )
      cursor = more["cursor"] as typeof cursor
    }
  }

  private async currentClusterTime(): Promise<ClusterTime | undefined> {
    const session = this.client.startSession()
    try {
      await this.db.command({ ping: 1 }, { session })
      return toCt(session.operationTime)
    } finally {
      await session.endSession()
    }
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
