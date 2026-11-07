import { type ClusterTime, isDocument, ZERO_CT } from "@canopy/protocol"
import type { ChangeStream, ChangeStreamOptions, Db, Document, MongoClient } from "mongodb"
import {
  type ControlEvent,
  isDataEvent,
  mergeFragments,
  type NormalizedEvent,
  normalize,
} from "./event.ts"
import type { Logger } from "./logger.ts"
import type { RealtimeMetrics } from "./metrics.ts"
import { EXACT_BSON } from "./snapshot.ts"

/** How full documents are obtained. */
export type FullDocumentMode = "auto" | "updateLookup" | "images"

/** Where the stream position is stored between restarts. */
export interface CheckpointStore {
  load(): Promise<unknown>
  save(token: unknown, ct: ClusterTime): Promise<void>
}

/** Stores checkpoints in `canopy.checkpoints`, which is never the app database. */
export function metaCheckpoints(meta: Db, streamId: string, node: string): CheckpointStore {
  const coll = meta.collection<{ _id: string; token: unknown; ct: string; node: string; at: Date }>(
    "checkpoints",
  )
  return {
    async load() {
      const doc = await coll.findOne({ _id: streamId })
      return doc?.token
    },
    async save(token, ct) {
      await coll.updateOne(
        { _id: streamId },
        { $set: { token, ct, node, at: new Date() } },
        { upsert: true },
      )
    },
  }
}

/** Does not persist the position: the stream starts from now on every start (read only sidecars). */
export const noCheckpoints: CheckpointStore = {
  load: async () => undefined,
  save: async () => {},
}

/** Callbacks of the ingestor. */
export interface IngestorHandlers {
  /** Processes a batch of data events in stream order. The next batch waits for the promise. */
  onEvents(events: NormalizedEvent[]): Promise<void>
  /** A drop, rename, dropDatabase or invalidate. */
  onControl(event: ControlEvent): void
  /** The stream could not resume (history lost or invalid token) and restarted from now. */
  onRestart(reason: string): void
  /** The stream advanced while idle. */
  onProgress(ct: ClusterTime): void
}

/** Options for {@link Ingestor}. */
export interface IngestorOptions {
  readonly client: MongoClient
  readonly db: Db
  readonly mode: FullDocumentMode
  readonly collections: () => readonly string[]
  readonly checkpoints: CheckpointStore
  readonly handlers: IngestorHandlers
  readonly logger: Logger
  readonly metrics: RealtimeMetrics
  readonly checkpointIntervalMs?: number
  readonly maxBatch?: number
}

const HISTORY_LOST = new Set([260, 280, 286])

function errorCode(error: unknown): number | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "number"
  )
    return error.code
  return undefined
}

/**
 * Reads the one change stream of the app database: filters to realtime collections, normalizes
 * events, reassembles split events, checkpoints the position and restarts from now when history is lost.
 */
export class Ingestor {
  private readonly options: IngestorOptions
  private stream: ChangeStream | undefined
  private running = false
  private token: unknown
  private lastCt: ClusterTime = ZERO_CT
  private sinceCheckpoint = 0
  private lastCheckpoint = Date.now()
  private timer: ReturnType<typeof setInterval> | undefined
  private loop: Promise<void> | undefined
  private reopenRequested = false

  constructor(options: IngestorOptions) {
    this.options = options
  }

  /** The cluster time of the last processed event. */
  get position(): ClusterTime {
    return this.lastCt
  }

  /** Opens the stream and starts processing. Resolves once the stream is open. */
  async start(): Promise<void> {
    this.running = true
    this.token = await this.options.checkpoints.load()
    await this.open()
    this.timer = setInterval(() => {
      this.checkpoint(true).catch((error: unknown) =>
        this.options.logger.warn({ err: error }, "checkpoint failed"),
      )
    }, this.options.checkpointIntervalMs ?? 1000)
    this.loop = this.run()
  }

  /** Reopens the stream at the current position with a new collection filter. */
  reopen(): void {
    this.reopenRequested = true
    this.stream?.close().catch(() => {})
  }

  /** Stops the stream and writes a final checkpoint. */
  async stop(): Promise<void> {
    this.running = false
    if (this.timer !== undefined) clearInterval(this.timer)
    await this.stream?.close().catch(() => {})
    await this.loop?.catch(() => {})
    await this.checkpoint(true).catch(() => {})
  }

  private pipeline(): Document[] {
    return [
      {
        $match: {
          $or: [
            {
              operationType: { $in: ["insert", "update", "replace", "delete", "drop", "rename"] },
              "ns.coll": { $in: [...this.options.collections()] },
            },
            { operationType: { $in: ["dropDatabase", "invalidate"] } },
          ],
        },
      },
      { $changeStreamSplitLargeEvent: {} },
    ]
  }

  private async open(): Promise<void> {
    const mode = this.options.mode
    const options: ChangeStreamOptions = {
      ...EXACT_BSON,
      showExpandedEvents: true,
      fullDocument:
        mode === "updateLookup" ? "updateLookup" : mode === "images" ? "required" : "whenAvailable",
      ...(mode === "updateLookup"
        ? {}
        : { fullDocumentBeforeChange: mode === "images" ? "required" : "whenAvailable" }),
      ...(this.token === undefined ? {} : { startAfter: this.token }),
    }
    this.stream = this.options.db.watch(this.pipeline(), options)
    await this.waitOpen(this.stream)
  }

  private async waitOpen(stream: ChangeStream): Promise<void> {
    await stream.tryNext().then((first) => {
      if (first !== null) this.pending.push(first as unknown as Record<string, unknown>)
    })
    this.token = stream.resumeToken ?? this.token
  }

  private pending: Record<string, unknown>[] = []
  private fragments: Record<string, unknown>[] = []

  private async run(): Promise<void> {
    while (this.running) {
      const stream = this.stream
      if (stream === undefined) return
      try {
        const batch: Record<string, unknown>[] = this.pending
        this.pending = []
        if (batch.length === 0) {
          const first = await stream.next()
          batch.push(first as unknown as Record<string, unknown>)
        }
        while (batch.length < (this.options.maxBatch ?? 1000) && stream.bufferedCount() > 0) {
          batch.push((await stream.next()) as unknown as Record<string, unknown>)
        }
        await this.process(batch)
        this.token = stream.resumeToken
      } catch (error: unknown) {
        try {
          await this.recover(error)
        } catch (recoverError: unknown) {
          if (!this.running) return
          this.options.logger.error({ err: recoverError }, "change stream could not be reopened")
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
      }
    }
  }

  /** Reopens the stream after `next()` failed: on request, after lost history, or after an error. */
  private async recover(error: unknown): Promise<void> {
    if (!this.running) return
    if (this.reopenRequested) {
      this.reopenRequested = false
      this.options.metrics.restarts.inc({ reason: "reopen" })
      await this.open()
      return
    }
    const code = errorCode(error)
    if (code !== undefined && HISTORY_LOST.has(code)) {
      this.options.metrics.restarts.inc({ reason: "history_lost" })
      this.options.logger.error({ err: error }, "change stream history lost, restarting from now")
      this.token = undefined
      await this.open()
      this.options.handlers.onRestart("history_lost")
      return
    }
    this.options.metrics.restarts.inc({ reason: "error" })
    this.options.logger.warn({ err: error }, "change stream failed, reopening")
    await new Promise((resolve) => setTimeout(resolve, 500))
    try {
      await this.open()
    } catch (reopenError: unknown) {
      this.options.logger.error({ err: reopenError }, "change stream could not be reopened")
      this.token = undefined
      await new Promise((resolve) => setTimeout(resolve, 2000))
      await this.open().catch(() => {})
      this.options.handlers.onRestart("reopen_failed")
    }
  }

  private async process(raw: Record<string, unknown>[]): Promise<void> {
    const events: NormalizedEvent[] = []
    const flush = async (): Promise<void> => {
      if (events.length === 0) return
      const chunk = events.splice(0, events.length)
      await this.options.handlers.onEvents(chunk)
    }
    for (let change of raw) {
      const split = change["splitEvent"]
      if (isDocument(split)) {
        this.fragments.push(change)
        if (split["fragment"] !== split["of"]) continue
        change = mergeFragments(this.fragments)
        this.fragments = []
      }
      const event = normalize(change)
      if (event === undefined) continue
      this.lastCt = event.ct
      if (!isDataEvent(event)) {
        await flush()
        this.options.handlers.onControl(event)
        continue
      }
      const wall = event.wallTime
      if (wall !== undefined)
        this.options.metrics.lag.set(Math.max(0, (Date.now() - wall.getTime()) / 1000))
      this.options.metrics.events.inc({ coll: event.coll, op: event.op })
      events.push(event)
    }
    await flush()
    this.sinceCheckpoint += raw.length
    await this.checkpoint(false)
  }

  private async checkpoint(force: boolean): Promise<void> {
    const token = this.stream?.resumeToken ?? this.token
    if (token === undefined) return
    const due =
      force ||
      this.sinceCheckpoint >= 1000 ||
      Date.now() - this.lastCheckpoint >= (this.options.checkpointIntervalMs ?? 1000)
    if (!due) return
    this.sinceCheckpoint = 0
    this.lastCheckpoint = Date.now()
    this.options.handlers.onProgress(this.lastCt)
    await this.options.checkpoints.save(token, this.lastCt)
  }
}
