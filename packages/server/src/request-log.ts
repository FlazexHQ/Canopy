import type { Logger } from "@canopy/realtime"
import { type Collection, type Db, type Filter, ObjectId } from "mongodb"

/** The parts of the server a logged request went to. */
export type RequestSurface = "rest" | "graphql" | "auth" | "admin" | "realtime"

/**
 * One sampled request in `canopy.request_log`. Only the path is kept, never the query string, headers or
 * bodies, so filters, tokens and document contents stay out of the log.
 */
export interface RequestLogEntry {
  readonly _id: ObjectId
  readonly at: Date
  readonly surface: RequestSurface
  readonly method: string
  readonly path: string
  readonly status: number
  readonly durationMs: number
  /** The peer address. */
  readonly ip?: string
  readonly requestId?: string
}

/** What is known about a request when it is done. */
export interface RequestLogInput {
  readonly surface: RequestSurface
  readonly method: string
  readonly path: string
  readonly status: number
  readonly durationMs: number
  readonly ip?: string
  readonly requestId?: string
}

/** A query over the request log, newest first. */
export interface RequestLogQuery {
  readonly surface?: RequestSurface
  /** An exact status, or a class such as `4xx`. */
  readonly status?: number | `${1 | 2 | 3 | 4 | 5}xx`
  /** Entries strictly older than this entry id, for paging. */
  readonly before?: string
  readonly limit?: number
}

/** How requests are sampled and kept. */
export interface RequestLogSettings {
  /** The share of requests kept, from 0 (off) to 1 (all). Server errors (5xx) are kept whenever it is above 0. */
  readonly sampleRate: number
  readonly retentionDays: number
}

const TTL_INDEX = "ttl_at"
const MAX_PATH = 512

/** Which surface a path belongs to, or `undefined` for paths that are not logged (health, the host app). */
export function surfaceOf(path: string): RequestSurface | undefined {
  const under = (prefix: string): boolean => path === prefix || path.startsWith(`${prefix}/`)
  if (under("/rest/v1")) return "rest"
  if (under("/graphql/v1")) return "graphql"
  if (under("/auth/v1") || path === "/.well-known/jwks.json") return "auth"
  if (under("/admin") || under("/studio")) return "admin"
  if (under("/realtime/v1")) return "realtime"
  return undefined
}

/**
 * Sampled request logs in `canopy.request_log`, kept for a retention period through a TTL index. Writes
 * never delay or fail a request: they happen after the response and errors are only logged.
 */
export class RequestLog {
  readonly collection: Collection<RequestLogEntry>
  private settings: RequestLogSettings
  private readonly logger: Logger
  private readonly random: () => number
  private lastWarning = 0

  constructor(
    meta: Db,
    options: {
      readonly logger: Logger
      readonly settings: RequestLogSettings
      /** Injected by tests. */
      readonly random?: () => number
    },
  ) {
    this.collection = meta.collection<RequestLogEntry>("request_log")
    this.logger = options.logger
    this.settings = options.settings
    this.random = options.random ?? Math.random
  }

  /** Applies new sampling settings at once; the retention is applied with {@link setRetention}. */
  configure(settings: RequestLogSettings): void {
    this.settings = settings
  }

  /** Whether a request with this status is kept under the current sampling settings. */
  sampled(status: number): boolean {
    const rate = this.settings.sampleRate
    if (rate <= 0) return false
    return status >= 500 || rate >= 1 || this.random() < rate
  }

  /** Records a finished request when it is sampled. Returns at once; the write happens in the background. */
  record(input: RequestLogInput): void {
    if (!this.sampled(input.status)) return
    const entry: RequestLogEntry = {
      _id: new ObjectId(),
      at: new Date(),
      surface: input.surface,
      method: input.method.slice(0, 16),
      path: input.path.slice(0, MAX_PATH),
      status: input.status,
      durationMs: Math.round(input.durationMs * 10) / 10,
      ...(input.ip === undefined ? {} : { ip: input.ip.slice(0, 64) }),
      ...(input.requestId === undefined ? {} : { requestId: input.requestId.slice(0, 128) }),
    }
    this.collection.insertOne(entry).then(
      () => {},
      (error: unknown) => {
        const now = Date.now()
        if (now - this.lastWarning < 60_000) return
        this.lastWarning = now
        this.logger.warn({ err: error }, "could not write the request log")
      },
    )
  }

  /** Reads entries, newest first. */
  async list(query: RequestLogQuery = {}): Promise<RequestLogEntry[]> {
    const status = query.status
    const filter: Filter<RequestLogEntry> = {
      ...(query.surface === undefined ? {} : { surface: query.surface }),
      ...(status === undefined
        ? {}
        : typeof status === "number"
          ? { status }
          : {
              status: {
                $gte: Number(status[0]) * 100,
                $lt: (Number(status[0]) + 1) * 100,
              },
            }),
      ...(query.before !== undefined && ObjectId.isValid(query.before)
        ? { _id: { $lt: new ObjectId(query.before) } }
        : {}),
    }
    return this.collection
      .find(filter)
      .sort({ _id: -1 })
      .limit(Math.min(Math.max(query.limit ?? 100, 1), 1000))
      .toArray()
  }

  /** Keeps entries for `days` days, creating or changing the TTL index. */
  async setRetention(days: number): Promise<void> {
    const seconds = Math.round(days * 86_400)
    const existing = await this.collection
      .indexes()
      .then((indexes) => indexes.find((index) => index.name === TTL_INDEX))
      .catch(() => undefined)
    if (existing === undefined) {
      await this.collection.createIndex({ at: 1 }, { name: TTL_INDEX, expireAfterSeconds: seconds })
      return
    }
    if (existing.expireAfterSeconds === seconds) return
    await this.collection.db.command({
      collMod: this.collection.collectionName,
      index: { name: TTL_INDEX, expireAfterSeconds: seconds },
    })
  }
}
