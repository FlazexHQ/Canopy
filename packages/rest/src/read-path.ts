import { compileProjection } from "@canopy/matcher"
import {
  and,
  type Compiled,
  canAccess,
  deniedPaths,
  type FieldAccess,
  intersectProjection,
  OPERATIONS,
  type Operation,
  type PolicyEngine,
  projectReadable,
  Role,
  securePipeline,
  toFilter,
} from "@canopy/policy"
import {
  CanopyError,
  type ClusterTime,
  ErrorCode,
  InvalidQueryError,
  isDocument,
  serverErrorCode,
  toCt,
} from "@canopy/protocol"
import {
  DEFAULT_LIMITS,
  type ParsedQuery,
  parseFilter,
  parseQuery,
  pathsOverlap,
  type QueryLimits,
  validatePath,
} from "@canopy/query"
import { type ClientSession, type Db, type Document, type MongoClient, MongoError } from "mongodb"
import {
  type CursorKey,
  cursorKeys,
  cursorQueryHash,
  decodeCursor,
  encodeCursor,
  keysetFilter,
  positionOf,
} from "./cursor.ts"
import { abortCheck, EXACT_BSON, toDriver } from "./driver.ts"
import { fromDriverError } from "./errors.ts"
import type { CountMode } from "./params.ts"
import { validateCollectionName, validateId } from "./validation.ts"
import type { Caller, ReturnedDocument } from "./write-path.ts"

const MAX_TIME_EXPIRED = 50
/** How long a collection's estimated size is reused before it is read again. */
const SIZE_TTL_MS = 60_000

/** Limits on reads. */
export interface ReadLimits {
  /** Page size when the caller sets none. */
  readonly defaultLimit: number
  /** The largest page a caller may request. */
  readonly maxLimit: number
  /** The largest `skip`. Cursors have no such limit. */
  readonly maxSkip: number
  /** The most values a `distinct` may return. */
  readonly maxDistinct: number
  /** The most documents an aggregation may return. */
  readonly maxAggregateResults: number
  /** The most stages an aggregation may have, counting nested ones. */
  readonly maxPipelineStages: number
  /** Time limit of each read. */
  readonly maxTimeMS: number
  /**
   * How long a find without a sort may at least walk documents in `_id` order before it switches to a
   * collection scan with an in memory sort. Walking `_id` order stops early when many documents match, but
   * reads the whole collection through the `_id` index when few do, which a collection scan does faster. On
   * a large collection the walk may go on as long as `scanMSPerMillion` estimates a scan of the whole
   * collection to take, up to half of `maxTimeMS`, so such a find costs about twice the faster plan at
   * most. `0` turns the switch off. Both attempts together stay within `maxTimeMS`.
   */
  readonly unsortedProbeMS: number
  /**
   * The estimated time in milliseconds to scan a million documents, which lets an unsorted find walk `_id`
   * order for longer on a large collection. `0` keeps that walk at `unsortedProbeMS`.
   */
  readonly scanMSPerMillion: number
}

/** Default read limits. */
export const DEFAULT_READ_LIMITS: ReadLimits = {
  defaultLimit: 100,
  maxLimit: 1000,
  maxSkip: 10_000,
  maxDistinct: 1000,
  maxAggregateResults: 1000,
  maxPipelineStages: 20,
  maxTimeMS: 5000,
  unsortedProbeMS: 100,
  scanMSPerMillion: 400,
}

/** Options for {@link ReadPath}. */
export interface ReadPathOptions {
  readonly client: MongoClient
  /** The app database. */
  readonly database: string
  /** The policy engine, or a function returning the current one when policies are hot reloaded. */
  readonly policies: PolicyEngine | (() => PolicyEngine)
  readonly limits?: Partial<ReadLimits>
  readonly queryLimits?: QueryLimits
}

/** A find request. Values may hold protocol BSON classes decoded from EJSON. */
export interface FindRequest {
  readonly collection: string
  readonly filter?: unknown
  readonly sort?: unknown
  /** An inclusion or exclusion projection, intersected with the readable fields. */
  readonly fields?: unknown
  readonly limit?: number
  readonly skip?: number
  /** The cursor of the previous page. */
  readonly after?: string
  /** Also count every matching document. */
  readonly count?: CountMode
}

/** One page of a find. */
export interface FindResult {
  readonly docs: readonly ReturnedDocument[]
  readonly limit: number
  /** The cursor of the next page, or `null` on the last page. */
  readonly next: string | null
  /** The number of matching documents, when a count was requested. */
  readonly total?: number
  /** The snapshot the page was read at. */
  readonly ct: ClusterTime
}

/** A collection a caller can reach, with the operations its policies grant. */
export interface CollectionInfo {
  readonly name: string
  readonly operations: readonly Operation[]
  readonly realtime: boolean
}

/** Options of a single read. */
export interface ReadOptions {
  readonly signal?: AbortSignal
}

interface Planned {
  readonly name: string
  readonly engine: PolicyEngine
  readonly readable: FieldAccess
  readonly service: boolean
}

/**
 * The DLS enforced read path of the Data API. Every read runs `filter AND USING(read)` inside a snapshot
 * session and reports the snapshot's cluster time, so a page lines up with realtime events: every change
 * with `ct <= T` is already in it. Filters and sorts may only reference readable fields, and returned
 * documents keep only readable fields.
 */
export class ReadPath {
  private readonly client: MongoClient
  private readonly db: Db
  private readonly engine: () => PolicyEngine
  private readonly limits: ReadLimits
  private readonly queryLimits: QueryLimits
  private readonly sizes = new Map<string, { readonly docs: number; readonly at: number }>()

  constructor(options: ReadPathOptions) {
    this.client = options.client
    this.db = options.client.db(options.database)
    const policies = options.policies
    this.engine = typeof policies === "function" ? policies : () => policies
    this.limits = { ...DEFAULT_READ_LIMITS, ...options.limits }
    this.queryLimits = options.queryLimits ?? DEFAULT_LIMITS
  }

  /** How long an unsorted find on this collection may walk `_id` order, from its estimated size. */
  private async probeBudget(collection: string): Promise<number> {
    const { unsortedProbeMS, scanMSPerMillion, maxTimeMS } = this.limits
    if (scanMSPerMillion <= 0) return unsortedProbeMS
    const docs = await this.estimatedDocuments(collection)
    const estimate = Math.min(maxTimeMS / 2, (docs / 1e6) * scanMSPerMillion)
    return Math.round(Math.max(unsortedProbeMS, estimate))
  }

  /**
   * The collection's estimated document count from its metadata, reused for a minute. When the estimate
   * cannot be read, the last one (or none) is used, which only shortens the `_id` walk of unsorted finds.
   */
  private async estimatedDocuments(collection: string): Promise<number> {
    const cached = this.sizes.get(collection)
    if (cached !== undefined && Date.now() - cached.at < SIZE_TTL_MS) return cached.docs
    let docs = cached?.docs ?? 0
    try {
      docs = await this.db.collection(collection).estimatedDocumentCount({ maxTimeMS: 1000 })
    } catch (error: unknown) {
      if (!(error instanceof MongoError)) throw error
    }
    this.sizes.set(collection, { docs, at: Date.now() })
    return docs
  }

  /** The read limits in force. */
  get readLimits(): ReadLimits {
    return this.limits
  }

  /**
   * Lists the collections a caller can reach. Other callers see the exposed collections whose policies
   * grant their roles at least one operation; `service` also sees every collection of the database.
   */
  async collections(caller: Caller, options: ReadOptions = {}): Promise<CollectionInfo[]> {
    abortCheck(options.signal, "read")
    const engine = this.engine()
    const ctx = caller.context
    const names = new Set<string>()
    for (const def of engine.set.collections.values()) {
      if (def.exposed) names.add(def.collection)
    }
    if (ctx.roles.has(Role.Service)) {
      try {
        const listed = await this.db.listCollections({}, { nameOnly: true }).toArray()
        for (const { name } of listed) if (!name.startsWith("system.")) names.add(name)
      } catch (error: unknown) {
        throw fromDriverError(error, true)
      }
    }
    return [...names]
      .sort()
      .map((name) => ({
        name,
        operations: OPERATIONS.filter((op) => engine.hasGrant(name, op, ctx)),
        realtime: engine.isRealtime(name),
      }))
      .filter((info) => info.operations.length > 0)
  }

  /**
   * Reads one page. Pages continue from `after`, a cursor that is only valid for the same collection,
   * filter and sort. Throws {@link InvalidQueryError} for malformed queries, references to unreadable
   * fields and cursors of another query, and `CANOPY_NOT_FOUND` for unknown collections.
   */
  async find(caller: Caller, request: FindRequest, options: ReadOptions = {}): Promise<FindResult> {
    abortCheck(options.signal, "read")
    const planned = this.plan(caller, request.collection)
    const parsed = this.parse(planned, {
      filter: request.filter ?? {},
      sort: request.sort,
      fields: request.fields,
    })
    const limit = this.pageLimit(request.limit)
    if (request.skip !== undefined && request.after !== undefined)
      throw new InvalidQueryError("skip and after cannot be combined")
    const skip = this.skipOf(request.skip)
    const keys = cursorKeys(parsed.sort?.sort)
    const hash = cursorQueryHash(planned.name, parsed.filter.filter, keys)
    const effective = planned.engine.effectiveRead(
      planned.name,
      parsed.filter.filter,
      caller.context,
    )
    const ranged =
      request.after === undefined
        ? effective
        : and(effective, {
            kind: "filter",
            filter: this.validated(keysetFilter(keys, decodeCursor(request.after, keys, hash))),
          })
    const userProjection = parsed.fields?.projection
    const pushdown = intersectProjection(
      userProjection === undefined ? undefined : keepPaths(userProjection, keys),
      planned.readable,
    )
    const shape = userProjection === undefined ? undefined : compileProjection(userProjection)
    const sort = Object.fromEntries(keys.map((key) => [key.path, key.direction]))
    const probeMS =
      parsed.sort === undefined && this.limits.unsortedProbeMS > 0
        ? await this.probeBudget(planned.name)
        : 0
    return this.inSnapshot(planned.service, async (session) => {
      const read = (maxTimeMS: number, natural: boolean): Promise<Record<string, unknown>[]> =>
        this.db
          .collection(planned.name)
          .find(toDriver(toFilter(ranged)), {
            session,
            sort,
            limit: limit + 1,
            ...(skip === 0 ? {} : { skip }),
            ...(pushdown === undefined ? {} : { projection: pushdown }),
            ...(natural ? { hint: { $natural: 1 } } : {}),
            maxTimeMS,
            ...EXACT_BSON,
          })
          .toArray() as Promise<Record<string, unknown>[]>
      let raw: Record<string, unknown>[]
      if (probeMS > 0 && probeMS < this.limits.maxTimeMS) {
        try {
          raw = await read(probeMS, false)
        } catch (error: unknown) {
          if (serverErrorCode(error) !== MAX_TIME_EXPIRED) throw error
          raw = await read(this.limits.maxTimeMS - probeMS, true)
        }
      } else raw = await read(this.limits.maxTimeMS, false)
      abortCheck(options.signal, "read")
      const more = raw.length > limit
      const page = more ? raw.slice(0, limit) : raw
      const last = page.at(-1)
      const next =
        more && last !== undefined ? encodeCursor({ values: positionOf(last, keys) }, hash) : null
      const docs = page.map((doc) => {
        const readable = projectReadable(planned.readable, doc)
        return shape === undefined ? readable : shape.apply(readable)
      })
      const total =
        request.count === undefined ? undefined : await this.countIn(session, planned, effective)
      return { docs, limit, next, ...(total === undefined ? {} : { total }) }
    })
  }

  /** Reads one document by `_id`, or `null` when it does not exist or the caller cannot see it. */
  async findById(
    caller: Caller,
    collection: string,
    id: unknown,
    fields?: unknown,
    options: ReadOptions = {},
  ): Promise<{ readonly doc: ReturnedDocument | null; readonly ct: ClusterTime }> {
    abortCheck(options.signal, "read")
    if (id === undefined) throw new InvalidQueryError("The id is missing")
    validateId(id)
    const planned = this.plan(caller, collection)
    const parsed = this.parse(planned, { filter: {}, fields })
    const effective = planned.engine.effectiveRead(
      planned.name,
      { _id: { $eq: id } },
      caller.context,
    )
    const userProjection = parsed.fields?.projection
    const pushdown = intersectProjection(userProjection, planned.readable)
    const shape = userProjection === undefined ? undefined : compileProjection(userProjection)
    return this.inSnapshot(planned.service, async (session) => {
      const found = (await this.db.collection(planned.name).findOne(toDriver(toFilter(effective)), {
        session,
        ...(pushdown === undefined ? {} : { projection: pushdown }),
        maxTimeMS: this.limits.maxTimeMS,
        ...EXACT_BSON,
      })) as Record<string, unknown> | null
      if (found === null) return { doc: null }
      const readable = projectReadable(planned.readable, found)
      return { doc: shape === undefined ? readable : shape.apply(readable) }
    })
  }

  /**
   * Counts the documents a caller can see that match `filter`. `estimated` uses the collection metadata,
   * which is only possible when nothing restricts the count: an empty filter and a read policy that admits
   * every document. Otherwise the count is exact, because an estimate would reveal invisible documents.
   */
  async count(
    caller: Caller,
    collection: string,
    filter: unknown,
    mode: CountMode = "exact",
    options: ReadOptions = {},
  ): Promise<{ readonly count: number; readonly exact: boolean; readonly ct: ClusterTime }> {
    abortCheck(options.signal, "read")
    const planned = this.plan(caller, collection)
    const parsed = this.parse(planned, { filter: filter ?? {} })
    const effective = planned.engine.effectiveRead(
      planned.name,
      parsed.filter.filter,
      caller.context,
    )
    if (mode === "estimated" && estimable(effective, parsed)) {
      const session = this.client.startSession()
      try {
        const count = await this.db
          .collection(planned.name)
          .estimatedDocumentCount({ session, maxTimeMS: this.limits.maxTimeMS })
        const ct = toCt(session.operationTime)
        if (ct === undefined)
          throw new CanopyError(ErrorCode.Internal, "The read has no cluster time")
        return { count, exact: false, ct }
      } catch (error: unknown) {
        throw fromDriverError(error, planned.service)
      } finally {
        await session.endSession()
      }
    }
    return this.inSnapshot(planned.service, async (session) => ({
      count: await this.countIn(session, planned, effective),
      exact: true,
    }))
  }

  /**
   * Returns the distinct values of a readable field among the documents a caller can see. Throws
   * {@link InvalidQueryError} when there are more than `maxDistinct` values.
   */
  async distinct(
    caller: Caller,
    collection: string,
    field: unknown,
    filter: unknown,
    options: ReadOptions = {},
  ): Promise<{ readonly values: readonly unknown[]; readonly ct: ClusterTime }> {
    abortCheck(options.signal, "read")
    if (typeof field !== "string") throw new InvalidQueryError("field must be a string")
    validatePath(field, { maxLength: this.queryLimits.maxPathLength })
    const planned = this.plan(caller, collection)
    if (!canAccess(planned.readable, field))
      throw new InvalidQueryError(`The field ${field} is not readable`)
    const parsed = this.parse(planned, { filter: filter ?? {} })
    const effective = planned.engine.effectiveRead(
      planned.name,
      parsed.filter.filter,
      caller.context,
    )
    return this.inSnapshot(planned.service, async (session) => {
      const values: unknown[] = await this.db
        .collection(planned.name)
        .distinct(field, toDriver(toFilter(effective)), {
          session,
          maxTimeMS: this.limits.maxTimeMS,
          ...EXACT_BSON,
        })
      if (values.length > this.limits.maxDistinct)
        throw new InvalidQueryError(
          `The field has more than ${this.limits.maxDistinct} distinct values; narrow the filter`,
        )
      return { values }
    })
  }

  /**
   * Runs a caller's aggregation pipeline after {@link securePipeline} has put the DLS prefix in front of
   * it and rewritten its `$lookup` and `$unionWith` stages. Throws {@link InvalidQueryError} for rejected
   * stages and expressions, and when the result has more than `maxAggregateResults` documents.
   */
  async aggregate(
    caller: Caller,
    collection: string,
    pipeline: unknown,
    options: ReadOptions = {},
  ): Promise<{ readonly docs: readonly Record<string, unknown>[]; readonly ct: ClusterTime }> {
    abortCheck(options.signal, "read")
    const planned = this.plan(caller, collection)
    const max = this.limits.maxAggregateResults
    const secured = securePipeline(planned.engine, planned.name, pipeline, caller.context, {
      maxStages: this.limits.maxPipelineStages,
      maxSample: max,
      query: this.queryLimits,
    })
    return this.inSnapshot(planned.service, async (session) => {
      const docs = (await this.db
        .collection(planned.name)
        .aggregate(toDriver([...secured, { $limit: max + 1 }]) as unknown as Document[], {
          session,
          maxTimeMS: this.limits.maxTimeMS,
          allowDiskUse: planned.service,
          ...EXACT_BSON,
        })
        .toArray()) as Record<string, unknown>[]
      abortCheck(options.signal, "read")
      if (docs.length > max)
        throw new InvalidQueryError(
          `The aggregation returned more than ${max} documents; add a $limit stage`,
        )
      return { docs }
    })
  }

  private plan(caller: Caller, name: string): Planned {
    validateCollectionName(name)
    const engine = this.engine()
    const service = caller.context.roles.has(Role.Service)
    if (!service && !engine.isExposed(name))
      throw new CanopyError(ErrorCode.NotFound, `Unknown collection '${name}'`)
    return { name, engine, service, readable: engine.readable(name, caller.context) }
  }

  private parse(
    planned: Planned,
    input: { readonly filter: unknown; readonly sort?: unknown; readonly fields?: unknown },
  ): ParsedQuery {
    if (!isDocument(input.filter)) throw new InvalidQueryError("The filter must be a document")
    const parsed = parseQuery(
      {
        filter: input.filter,
        ...(input.sort === undefined ? {} : { sort: input.sort }),
        ...(input.fields === undefined ? {} : { fields: input.fields }),
      },
      this.queryLimits,
    )
    const denied = deniedPaths(planned.readable, parsed.paths)
    if (denied.length > 0)
      throw new InvalidQueryError(
        `The query may not reference unreadable fields: ${denied.join(", ")}`,
      )
    return parsed
  }

  /** Runs the generated keyset filter through the filter validator, as a guard on decoded cursor values. */
  private validated(filter: Record<string, unknown>): Record<string, unknown> {
    return parseFilter(filter, { context: "filter", limits: this.queryLimits }).filter
  }

  private pageLimit(limit: number | undefined): number {
    if (limit === undefined) return Math.min(this.limits.defaultLimit, this.limits.maxLimit)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.limits.maxLimit)
      throw new InvalidQueryError(`limit must be between 1 and ${this.limits.maxLimit}`)
    return limit
  }

  private skipOf(skip: number | undefined): number {
    if (skip === undefined) return 0
    if (!Number.isSafeInteger(skip) || skip < 0 || skip > this.limits.maxSkip)
      throw new InvalidQueryError(`skip must be between 0 and ${this.limits.maxSkip}`)
    return skip
  }

  private async countIn(
    session: ClientSession,
    planned: Planned,
    effective: Compiled,
  ): Promise<number> {
    return this.db.collection(planned.name).countDocuments(toDriver(toFilter(effective)), {
      session,
      maxTimeMS: this.limits.maxTimeMS,
    })
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

  private async inSnapshot<T extends object>(
    service: boolean,
    read: (session: ClientSession) => Promise<T>,
  ): Promise<T & { readonly ct: ClusterTime }> {
    const attempt = async (): Promise<{ result: T; ct: ClusterTime | undefined }> => {
      const session = this.client.startSession({ snapshot: true })
      try {
        const result = await read(session)
        const internal = session as unknown as { snapshotTime?: unknown }
        return { result, ct: toCt(internal.snapshotTime) ?? toCt(session.operationTime) }
      } finally {
        await session.endSession()
      }
    }
    try {
      const first = await attempt()
      if (first.ct !== undefined) return { ...first.result, ct: first.ct }
      // A read of a collection that does not exist yet carries no snapshot time. Take a cluster time T
      // first, then read again: a result still without a snapshot time is empty as of T.
      const before = await this.currentClusterTime()
      const second = await attempt()
      const ct = second.ct ?? before
      if (ct === undefined)
        throw new CanopyError(ErrorCode.Internal, "The read has no cluster time")
      return { ...second.result, ct }
    } catch (error: unknown) {
      throw fromDriverError(error, service)
    }
  }
}

/**
 * Adjusts a caller projection so the sort fields and `_id` reach the server side page, which needs them for
 * the next cursor. The caller's own projection is applied again in process afterwards.
 */
function keepPaths(
  projection: Readonly<Record<string, 0 | 1>>,
  keys: readonly CursorKey[],
): Record<string, 0 | 1> | undefined {
  const paths = Object.keys(projection).filter((path) => path !== "_id")
  const include = paths.some((path) => projection[path] === 1)
  if (include) {
    const out: Record<string, 0 | 1> = Object.fromEntries(paths.map((path) => [path, 1 as const]))
    for (const key of keys) if (key.path !== "_id") out[key.path] = 1
    return pruneDescendants(out)
  }
  const kept = paths.filter((path) => !keys.some((key) => pathsOverlap(path, key.path)))
  return kept.length === 0 ? undefined : Object.fromEntries(kept.map((path) => [path, 0 as const]))
}

function pruneDescendants(projection: Record<string, 0 | 1>): Record<string, 0 | 1> {
  const paths = Object.keys(projection)
  return Object.fromEntries(
    paths
      .filter((path) => !paths.some((other) => other !== path && path.startsWith(`${other}.`)))
      .map((path) => [path, projection[path] ?? 1]),
  )
}

function estimable(effective: Compiled, parsed: ParsedQuery): boolean {
  return effective.kind === "all" && Object.keys(parsed.filter.filter).length === 0
}
