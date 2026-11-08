import {
  and,
  type Compiled,
  checkImplied,
  deniedPaths,
  type FieldAccess,
  type PolicyEngine,
  projectReadable,
  type RequestContext,
  Role,
  toFilter,
  toProjection,
} from "@canopy/policy"
import {
  CanopyError,
  type ClusterTime,
  ConflictError,
  canonicalString,
  ErrorCode,
  ForbiddenError,
  InvalidQueryError,
  isDocument,
  PolicyViolationError,
  serverErrorCode,
  toCanopyError,
  toCt,
} from "@canopy/protocol"
import {
  DEFAULT_LIMITS,
  type ParsedFilter,
  parseFilter,
  parseUpdate,
  type QueryLimits,
  validateStoredDocument,
} from "@canopy/query"
import {
  BSON,
  type ClientSession,
  type Collection,
  type Db,
  type Document,
  type MongoClient,
  MongoServerError,
} from "mongodb"
import { abortCheck, EXACT_BSON, toDriver } from "./driver.ts"
import { fromDriverError } from "./errors.ts"
import { immutableViolations, leafPaths } from "./paths.ts"
import { validateCollectionName, validateId } from "./validation.ts"

/** A write requested by a caller. Values may hold protocol BSON classes decoded from EJSON. */
export type WriteRequest =
  | { readonly op: "insert"; readonly collection: string; readonly doc: unknown }
  | { readonly op: "insertMany"; readonly collection: string; readonly docs: unknown }
  | {
      readonly op: "update"
      readonly collection: string
      readonly id: unknown
      readonly update: unknown
      /** A compare and set precondition. When it fails on a visible document the write is a conflict. */
      readonly where?: unknown
    }
  | {
      readonly op: "updateMany"
      readonly collection: string
      readonly filter: unknown
      readonly update: unknown
      /** Bulk writes must be requested explicitly. */
      readonly bulk: true
    }
  | {
      readonly op: "replace"
      readonly collection: string
      readonly id: unknown
      readonly doc: unknown
      readonly where?: unknown
      /** Insert the document when no visible document has the `_id`. Needs insert and update grants. */
      readonly upsert?: boolean
    }
  | {
      readonly op: "delete"
      readonly collection: string
      readonly id: unknown
      readonly where?: unknown
    }
  | {
      readonly op: "deleteMany"
      readonly collection: string
      readonly filter: unknown
      readonly bulk: true
    }

/** The caller of a write: its request context and the subject that owns idempotency records. */
export interface Caller {
  readonly context: RequestContext
  readonly subject: string
}

/** Options for {@link WritePath.execute}. */
export interface WriteOptions {
  /** The idempotency key (the client's mutation ID). A repeated key returns the stored result. */
  readonly mutationId?: string
  readonly signal?: AbortSignal
}

/** A readable document returned by a write. */
export type ReturnedDocument = Record<string, unknown>

/** The outcome of a committed (or replayed) write. */
export interface WriteResult {
  readonly matched: number
  readonly modified: number
  readonly deleted: number
  readonly insertedIds: readonly unknown[]
  readonly upsertedId?: unknown
  /**
   * The `_id`s whose documents the write may have changed: exact for single document writes, and every
   * matched document for bulk writes.
   */
  readonly changedIds: readonly unknown[]
  /**
   * For single document writes, `insert` and `insertMany`: the post image (the pre image for `delete`) projected by the
   * caller's read rules, or `null` when the caller cannot read it. Absent for bulk writes.
   */
  readonly documents?: readonly (ReturnedDocument | null)[]
  /** The cluster time of the commit, or for a replay a cluster time after it. */
  readonly ct: ClusterTime
  readonly replayed: boolean
}

/** The outcome of one operation of a batch. */
export type BatchOperationResult = Omit<WriteResult, "ct" | "replayed">

/** The outcome of a committed (or replayed) atomic batch. */
export interface BatchResult {
  readonly results: readonly BatchOperationResult[]
  readonly ct: ClusterTime
  readonly replayed: boolean
}

/** Limits on writes. */
export interface WriteLimits {
  /** Maximum documents an `updateMany` or `deleteMany` may touch. */
  readonly maxBulk: number
  /** Maximum documents in one `insertMany`. */
  readonly maxInsertMany: number
  /** Time limit per operation inside the transaction. */
  readonly maxTimeMS: number
  /** Time after which a write that keeps hitting transient errors gives up. */
  readonly transactionTimeoutMS: number
  /** Maximum operations in one atomic batch. */
  readonly maxBatch: number
}

/** Default write limits. */
export const DEFAULT_WRITE_LIMITS: WriteLimits = {
  maxBulk: 1000,
  maxInsertMany: 1000,
  maxTimeMS: 10_000,
  transactionTimeoutMS: 30_000,
  maxBatch: 100,
}

/** Options for {@link WritePath}. */
export interface WritePathOptions {
  readonly client: MongoClient
  /** The app database. */
  readonly database: string
  /** The Canopy meta database, which must live on the same deployment. Defaults to `canopy`. */
  readonly metaDatabase?: string
  /** The policy engine, or a function returning the current one when policies are hot reloaded. */
  readonly policies: PolicyEngine | (() => PolicyEngine)
  readonly limits?: Partial<WriteLimits>
  readonly queryLimits?: QueryLimits
  /** How long idempotency records live. Defaults to 24 hours. */
  readonly mutationTtlSeconds?: number
}

const MUTATION_ID = /^[A-Za-z0-9_-]{8,128}$/
const INDEX_OPTIONS_CONFLICT = new Set([85, 86])
const DUPLICATE_KEY = 11000
const STORED_DOCUMENTS_MAX = 1
/**
 * The largest document checked through `$documents` before a single insert. The check sends it once more,
 * so larger documents stay inside the 16 MiB command limit by checking after the write instead. Inserts
 * of several documents always check after the write, inside their transaction: sending a whole batch twice
 * costs more than reading it back.
 */
const PRECHECK_MAX_BYTES = 8 * 1024 * 1024

interface Outcome {
  readonly matched: number
  readonly modified: number
  readonly deleted: number
  readonly insertedIds: readonly unknown[]
  readonly upsertedId?: unknown
  readonly changedIds: readonly unknown[]
  readonly documents?: readonly (ReturnedDocument | null)[]
  /** Set by fast path runs, which read after writing and must report the time of the write itself. */
  readonly ct?: ClusterTime
}

interface MutationRecord {
  _id: string
  sub: string
  c: string
  op: string
  at: Date
  result?: Outcome
  /** The outcomes of an atomic batch, in operation order. */
  results?: Outcome[]
}

interface RecordKey {
  readonly c: string
  readonly op: string
}

class Replay extends Error {}

type Run = (session: ClientSession) => Promise<Outcome>

/**
 * A planned write. `run` works inside a transaction or, when `fast` is set, on its own: a fast run is one
 * atomic single document operation whose `check` cannot fail, so there is nothing for a transaction to
 * roll back.
 */
interface Plan {
  readonly run: Run
  readonly fast: boolean
}

const MAJORITY = { w: "majority" } as const

/**
 * The transactional write path shared by REST and realtime mutations. A write runs in a multi document
 * transaction: the target is `filter AND USING(op) AND USING(read)`, MongoDB applies the update, and
 * MongoDB itself evaluates `CHECK(op)` on the resulting documents before the commit, so update semantics are
 * never reimplemented here. The idempotency record is written in the same transaction.
 *
 * Fast path: a single document write without a mutation ID whose `check` compiles to "all documents" (and
 * every single document delete, which has no check) runs as one atomic operation on the target filter, with
 * majority write concern and no transaction. Its returned document is read right after the write, so a
 * concurrent write may already be visible in it; `ct` is still the time of this write.
 */
export class WritePath {
  private readonly client: MongoClient
  private readonly db: Db
  private readonly meta: Db
  private readonly engine: () => PolicyEngine
  private readonly limits: WriteLimits
  private readonly queryLimits: QueryLimits
  private readonly ttlSeconds: number
  private indexes: Promise<void> | undefined

  constructor(options: WritePathOptions) {
    this.client = options.client
    this.db = options.client.db(options.database)
    this.meta = options.client.db(options.metaDatabase ?? "canopy")
    if (this.meta.databaseName === this.db.databaseName)
      throw new TypeError("The meta database must differ from the app database")
    const policies = options.policies
    this.engine = typeof policies === "function" ? policies : () => policies
    this.limits = { ...DEFAULT_WRITE_LIMITS, ...options.limits }
    this.queryLimits = options.queryLimits ?? DEFAULT_LIMITS
    this.ttlSeconds = options.mutationTtlSeconds ?? 86_400
  }

  /** The write limits in force. */
  get writeLimits(): WriteLimits {
    return this.limits
  }

  /** Creates the TTL index of the idempotency records. Runs once; writes call it on demand. */
  ensureIndexes(): Promise<void> {
    this.indexes ??= this.createIndexes().catch((error: unknown) => {
      this.indexes = undefined
      throw fromDriverError(error, true)
    })
    return this.indexes
  }

  private async createIndexes(): Promise<void> {
    const mutations = this.meta.collection("mutations")
    try {
      await mutations.createIndex(
        { at: 1 },
        { name: "ttl_at", expireAfterSeconds: this.ttlSeconds },
      )
    } catch (error: unknown) {
      if (
        !(error instanceof MongoServerError) ||
        !INDEX_OPTIONS_CONFLICT.has(serverErrorCode(error) ?? 0)
      )
        throw error
      await this.meta.command({
        collMod: "mutations",
        index: { name: "ttl_at", expireAfterSeconds: this.ttlSeconds },
      })
    }
  }

  /**
   * Validates, authorizes and commits one write. Throws a {@link CanopyError}: `CANOPY_FORBIDDEN` when no
   * policy grants the operation, `CANOPY_POLICY_VIOLATION` when a field rule or `check` rejects it,
   * `CANOPY_CONFLICT` when `where` fails or the mutation ID belongs to another write, and
   * `CANOPY_INVALID_QUERY`, `CANOPY_BULK_LIMIT`, `CANOPY_DUPLICATE_KEY` or `CANOPY_VALIDATION_FAILED`.
   */
  async execute(
    caller: Caller,
    request: WriteRequest,
    options: WriteOptions = {},
  ): Promise<WriteResult> {
    const service = caller.context.roles.has(Role.Service)
    abortCheck(options.signal, "write")
    validateMutationId(options.mutationId)
    const plan = this.plan(this.engine(), caller.context, request)
    if (plan.fast && options.mutationId === undefined) return this.executeFast(plan.run, service)
    const committed = await this.transact(
      caller,
      { c: request.collection, op: request.op },
      [plan.run],
      options,
    )
    const [outcome] = committed.outcomes
    if (outcome === undefined) throw new CanopyError(ErrorCode.Internal, "The write has no outcome")
    const { ct: _ignored, ...rest } = outcome
    return { ...rest, ct: committed.ct, replayed: committed.replayed }
  }

  /**
   * Commits several writes in one transaction: DLS and `check` apply to each, each sees the effects of
   * the ones before it, and the first failure aborts all of them. A mutation ID covers the whole batch.
   * Errors carry `details.index`, the position of the operation that failed.
   */
  async executeBatch(
    caller: Caller,
    requests: readonly WriteRequest[],
    options: WriteOptions = {},
  ): Promise<BatchResult> {
    abortCheck(options.signal, "write")
    validateMutationId(options.mutationId)
    if (requests.length === 0) throw new InvalidQueryError("A batch needs at least one operation")
    if (requests.length > this.limits.maxBatch)
      throw new CanopyError(
        ErrorCode.BulkLimit,
        `A batch may not have more than ${this.limits.maxBatch} operations`,
      )
    const engine = this.engine()
    const runs = requests.map((request, index) => {
      try {
        return this.plan(engine, caller.context, request).run
      } catch (error: unknown) {
        throw atIndex(toCanopyError(error), index)
      }
    })
    const committed = await this.transact(caller, { c: "", op: "batch" }, runs, options)
    return {
      results: committed.outcomes.map(({ ct: _ignored, ...rest }) => rest),
      ct: committed.ct,
      replayed: committed.replayed,
    }
  }

  private async transact(
    caller: Caller,
    key: RecordKey,
    runs: readonly Run[],
    options: WriteOptions,
  ): Promise<{ outcomes: readonly Outcome[]; ct: ClusterTime; replayed: boolean }> {
    const service = caller.context.roles.has(Role.Service)
    const { mutationId } = options
    await this.ensureIndexes()
    const deadline = Date.now() + this.limits.transactionTimeoutMS
    const session = this.client.startSession()
    let failedAt: number | undefined
    try {
      let outcomes: Outcome[]
      try {
        outcomes = await session.withTransaction(
          async (s) => {
            abortCheck(options.signal, "write")
            if (Date.now() > deadline)
              throw new CanopyError(ErrorCode.Timeout, "The write could not commit in time")
            const results: Outcome[] = []
            for (const [index, run] of runs.entries()) {
              failedAt = index
              results.push(await run(s))
            }
            failedAt = undefined
            if (mutationId !== undefined) await this.record(s, mutationId, caller, key, results)
            return results
          },
          {
            readConcern: { level: "snapshot" },
            writeConcern: { w: "majority" },
            readPreference: "primary",
            maxCommitTimeMS: this.limits.maxTimeMS,
          },
        )
      } catch (error: unknown) {
        if (mutationId !== undefined) {
          const replayed = await this.replay(mutationId, caller, key)
          if (replayed !== undefined) return { ...replayed, replayed: true }
          if (error instanceof Replay)
            throw new CanopyError(
              ErrorCode.Unavailable,
              "The mutation is being retried; send it again",
            )
        }
        const canopy = fromDriverError(error, service)
        throw key.op === "batch" && failedAt !== undefined ? atIndex(canopy, failedAt) : canopy
      }
      const ct = toCt(session.operationTime)
      if (ct === undefined)
        throw new CanopyError(ErrorCode.Internal, "The commit has no cluster time")
      return { outcomes, ct, replayed: false }
    } finally {
      await session.endSession()
    }
  }

  private async executeFast(fast: Run, service: boolean): Promise<WriteResult> {
    const session = this.client.startSession({ causalConsistency: true })
    try {
      let outcome: Outcome
      try {
        outcome = await fast(session)
      } catch (error: unknown) {
        throw fromDriverError(error, service)
      }
      const { ct: written, ...rest } = outcome
      const ct = written ?? toCt(session.operationTime)
      if (ct === undefined)
        throw new CanopyError(ErrorCode.Internal, "The write has no cluster time")
      return { ...rest, ct, replayed: false }
    } finally {
      await session.endSession()
    }
  }

  private async record(
    session: ClientSession,
    id: string,
    caller: Caller,
    key: RecordKey,
    outcomes: readonly Outcome[],
  ): Promise<void> {
    const stored = outcomes.map((outcome) =>
      (outcome.documents?.length ?? 0) > STORED_DOCUMENTS_MAX ? withoutDocuments(outcome) : outcome,
    )
    const [first] = stored
    const record: MutationRecord = {
      _id: id,
      sub: caller.subject,
      c: key.c,
      op: key.op,
      at: new Date(),
      ...(key.op === "batch" ? { results: stored } : first === undefined ? {} : { result: first }),
    }
    try {
      await this.meta.collection<MutationRecord>("mutations").insertOne(record, { session })
    } catch (error: unknown) {
      if (error instanceof MongoServerError && serverErrorCode(error) === DUPLICATE_KEY)
        throw new Replay()
      throw error
    }
  }

  /** Returns the stored outcomes of a committed mutation, or `undefined` when there is none. */
  private async replay(
    id: string,
    caller: Caller,
    key: RecordKey,
  ): Promise<{ outcomes: readonly Outcome[]; ct: ClusterTime } | undefined> {
    const session = this.client.startSession({ causalConsistency: true })
    try {
      const record = await this.meta
        .collection<MutationRecord>("mutations")
        .findOne({ _id: id }, { session, readConcern: { level: "majority" }, ...EXACT_BSON })
      if (record === null) return undefined
      if (record.sub !== caller.subject)
        throw new ConflictError("The mutation ID was used by another caller")
      if (record.c !== key.c || record.op !== key.op)
        throw new ConflictError("The mutation ID was used for a different write")
      const stored =
        key.op === "batch"
          ? record.results
          : record.result === undefined
            ? undefined
            : [record.result]
      if (stored === undefined)
        throw new CanopyError(ErrorCode.Internal, "The idempotency record has no result")
      const ct = toCt(session.operationTime)
      if (ct === undefined)
        throw new CanopyError(ErrorCode.Internal, "The read has no cluster time")
      return { outcomes: stored.map(normalizeOutcome), ct }
    } finally {
      await session.endSession()
    }
  }

  private plan(engine: PolicyEngine, ctx: RequestContext, request: WriteRequest): Plan {
    const name = request.collection
    validateCollectionName(name)
    const service = ctx.roles.has(Role.Service)
    if (!service && !engine.isExposed(name))
      throw new CanopyError(ErrorCode.NotFound, `Unknown collection '${name}'`)
    const scope = new Scope(engine, ctx, this.db, name, {
      maxTimeMS: this.limits.maxTimeMS,
      filterLimits: this.queryLimits,
    })
    switch (request.op) {
      case "insert":
        return this.planInsert(scope, [request.doc], true)
      case "insertMany": {
        if (!Array.isArray(request.docs)) throw new InvalidQueryError("docs must be an array")
        return this.planInsert(scope, request.docs, false)
      }
      case "update":
        return this.planUpdate(scope, { id: request.id }, request.update, request.where)
      case "updateMany":
        requireBulk(request.bulk)
        return this.planUpdate(scope, { filter: request.filter }, request.update, undefined)
      case "replace":
        return this.planReplace(scope, request)
      case "delete":
        return this.planDelete(scope, { id: request.id }, request.where)
      case "deleteMany":
        requireBulk(request.bulk)
        return this.planDelete(scope, { filter: request.filter }, undefined)
      default:
        throw new InvalidQueryError("Unknown write operation")
    }
  }

  private planInsert(scope: Scope, docs: readonly unknown[], single: boolean): Plan {
    if (docs.length === 0) throw new InvalidQueryError("There is nothing to insert")
    if (docs.length > this.limits.maxInsertMany)
      throw new CanopyError(
        ErrorCode.BulkLimit,
        `An insert may not have more than ${this.limits.maxInsertMany} documents`,
      )
    scope.requireGrant("insert")
    const writable = scope.writable("insert")
    const prepared: Document[] = docs.map((doc) => {
      validateStoredDocument(doc, this.queryLimits)
      const record = doc as Record<string, unknown>
      if (!scope.service) assertWritable(writable, leafPaths(record), scope.name)
      validateId(record["_id"])
      const { _id: given, ...fields } = toDriver(record) as Document
      return { _id: given ?? new BSON.ObjectId(), ...fields }
    })
    const check = scope.engine.check(scope.name, "insert", scope.ctx)
    if (check.kind === "deny") throw violation("insert", scope.name)
    const precheck = single && BSON.calculateObjectSize({ prepared }) <= PRECHECK_MAX_BYTES
    const run: Run = async (session) => {
      const checked = precheck ? await scope.precheck(prepared, check) : undefined
      const [first] = prepared
      if (single && first !== undefined)
        await scope.coll.insertOne(first, scope.writeOptions(session))
      else await scope.coll.insertMany(prepared, { ...scope.writeOptions(session), ordered: true })
      const ct = scope.fastTime(session)
      const ids = prepared.map((doc) => doc["_id"])
      const documents = checked ?? (await scope.verify(session, ids, check, "insert", true))
      return {
        matched: 0,
        modified: 0,
        deleted: 0,
        insertedIds: ids,
        changedIds: ids,
        ...(documents === undefined ? {} : { documents }),
        ...(ct === undefined ? {} : { ct }),
      }
    }
    return { run, fast: single && (check.kind === "all" || precheck) }
  }

  private planUpdate(
    scope: Scope,
    selector: { readonly id: unknown } | { readonly filter: unknown },
    rawUpdate: unknown,
    rawWhere: unknown,
  ): Plan {
    scope.requireGrant("update")
    const parsed = parseUpdate(rawUpdate, {
      allowPipeline: scope.service,
      limits: this.queryLimits,
    })
    if (parsed.kind === "replacement")
      throw new InvalidQueryError(
        "An update needs update operators; use replace for whole documents",
      )
    if (!scope.service) {
      assertWritable(scope.writable("update"), parsed.writtenPaths, scope.name)
      assertMutable(parsed.writtenPaths, scope.engine.immutable(scope.name))
    }
    const base = scope.selector(selector)
    const where = scope.precondition(rawWhere)
    const target = and(base, where, scope.engine.target(scope.name, "update", scope.ctx))
    const visible = and(base, scope.engine.target(scope.name, "update", scope.ctx))
    const check = scope.engine.check(scope.name, "update", scope.ctx)
    const update = toDriver(parsed.update) as Document
    if ("id" in selector) {
      const id = toDriver(selector.id)
      const implied = checkImplied(check, target, parsed.writtenPaths)
      const run: Run = async (session) => {
        const result = await scope.coll.updateOne(
          scope.filter(target),
          update,
          scope.writeOptions(session),
        )
        const ct = scope.fastTime(session)
        if (result.matchedCount === 0) {
          if (where.kind !== "all") await scope.assertNoConflict(session, visible)
          return withCt(empty(), ct)
        }
        const modified = result.modifiedCount > 0
        const documents = await scope
          .verify(session, [id], modified ? check : undefined, "update", true)
          .catch((error: unknown) => {
            if (error instanceof PolicyViolationError && !session.inTransaction())
              throw new CanopyError(
                ErrorCode.Internal,
                "An update that skipped its check as implied wrote a document that fails it",
                { cause: error },
              )
            throw error
          })
        return withCt(
          {
            matched: result.matchedCount,
            modified: result.modifiedCount,
            deleted: 0,
            insertedIds: [],
            changedIds: modified ? [id] : [],
            ...(documents === undefined ? {} : { documents }),
          },
          ct,
        )
      }
      return { run, fast: check.kind === "all" || implied }
    }
    const run: Run = async (session) => {
      const ids = await scope.findIds(session, target, this.limits.maxBulk + 1)
      if (ids.length > this.limits.maxBulk) throw bulkLimit(this.limits.maxBulk)
      if (ids.length === 0) return empty()
      const result = await scope.coll.updateMany(scope.byIds(ids, target), update, {
        session,
        maxTimeMS: this.limits.maxTimeMS,
      })
      if (result.modifiedCount > 0) await scope.verify(session, ids, check, "update", false)
      return {
        matched: result.matchedCount,
        modified: result.modifiedCount,
        deleted: 0,
        insertedIds: [],
        changedIds: result.modifiedCount > 0 ? ids : [],
      }
    }
    return { run, fast: false }
  }

  private planReplace(
    scope: Scope,
    request: Extract<WriteRequest, { readonly op: "replace" }>,
  ): Plan {
    const upsert = request.upsert === true
    scope.requireGrant("update")
    if (upsert) scope.requireGrant("insert")
    if (upsert && request.where !== undefined)
      throw new InvalidQueryError("A replacement cannot combine where with upsert")
    validateStoredDocument(request.doc, this.queryLimits)
    const doc = request.doc as Record<string, unknown>
    validateId(request.id)
    if (doc["_id"] !== undefined && canonicalString(doc["_id"]) !== canonicalString(request.id))
      throw new InvalidQueryError("The replacement _id must match the target _id")
    if (!scope.service) {
      if (scope.writable("update").kind !== "all" || scope.engine.immutable(scope.name).length > 0)
        throw new ForbiddenError(
          `The field rules of '${scope.name}' do not allow replacing whole documents; send an update`,
        )
      if (upsert) assertWritable(scope.writable("insert"), leafPaths(doc), scope.name)
    }
    const base = scope.selector({ id: request.id })
    const where = scope.precondition(request.where)
    const target = and(base, where, scope.engine.target(scope.name, "update", scope.ctx))
    const visible = and(base, scope.engine.target(scope.name, "update", scope.ctx))
    const updateCheck = scope.engine.check(scope.name, "update", scope.ctx)
    const insertCheck = upsert ? scope.engine.check(scope.name, "insert", scope.ctx) : undefined
    const atomicUpsert = insertCheck?.kind === "all"
    const id = toDriver(request.id)
    const replacement = toDriver({ ...doc, _id: request.id }) as Document
    const run: Run = async (session) => {
      const result = await scope.coll.replaceOne(scope.filter(target), replacement, {
        ...scope.writeOptions(session),
        upsert: atomicUpsert,
      })
      let ct = scope.fastTime(session)
      if (result.upsertedCount > 0) {
        const documents = await scope.verify(session, [id], undefined, "insert", true)
        return withCt(upserted(id, documents), ct)
      }
      if (result.matchedCount === 0) {
        if (where.kind !== "all") await scope.assertNoConflict(session, visible)
        if (insertCheck === undefined) return withCt(empty(), ct)
        if (insertCheck.kind === "deny") throw violation("insert", scope.name)
        await scope.coll.insertOne(replacement, scope.writeOptions(session))
        ct = scope.fastTime(session)
        const documents = await scope.verify(session, [id], insertCheck, "insert", true)
        return withCt(upserted(id, documents), ct)
      }
      const modified = result.modifiedCount > 0
      const documents = await scope.verify(
        session,
        [id],
        modified ? updateCheck : undefined,
        "update",
        true,
      )
      return withCt(
        {
          matched: result.matchedCount,
          modified: result.modifiedCount,
          deleted: 0,
          insertedIds: [],
          changedIds: modified ? [id] : [],
          ...(documents === undefined ? {} : { documents }),
        },
        ct,
      )
    }
    return { run, fast: updateCheck.kind === "all" && (insertCheck === undefined || atomicUpsert) }
  }

  private planDelete(
    scope: Scope,
    selector: { readonly id: unknown } | { readonly filter: unknown },
    rawWhere: unknown,
  ): Plan {
    scope.requireGrant("delete")
    const base = scope.selector(selector)
    const where = scope.precondition(rawWhere)
    const target = and(base, where, scope.engine.target(scope.name, "delete", scope.ctx))
    const visible = and(base, scope.engine.target(scope.name, "delete", scope.ctx))
    if ("id" in selector) {
      const run: Run = async (session) => {
        const projection = toProjection(scope.readable())
        const deleted = await scope.coll.findOneAndDelete(scope.filter(target), {
          ...scope.writeOptions(session),
          ...(projection === undefined ? {} : { projection }),
          ...EXACT_BSON,
        })
        const ct = scope.fastTime(session)
        if (deleted === null) {
          if (where.kind !== "all") await scope.assertNoConflict(session, visible)
          return withCt(empty(), ct)
        }
        return withCt(
          {
            matched: 1,
            modified: 0,
            deleted: 1,
            insertedIds: [],
            changedIds: [deleted["_id"]],
            documents: [projectReadable(scope.readable(), deleted)],
          },
          ct,
        )
      }
      return { run, fast: true }
    }
    const run: Run = async (session) => {
      const ids = await scope.findIds(session, target, this.limits.maxBulk + 1)
      if (ids.length > this.limits.maxBulk) throw bulkLimit(this.limits.maxBulk)
      if (ids.length === 0) return empty()
      const result = await scope.coll.deleteMany(scope.byIds(ids, target), {
        session,
        maxTimeMS: this.limits.maxTimeMS,
      })
      return {
        matched: ids.length,
        modified: 0,
        deleted: result.deletedCount,
        insertedIds: [],
        changedIds: ids,
      }
    }
    return { run, fast: false }
  }
}

/** Everything a planned write needs about its collection and caller. */
class Scope {
  readonly service: boolean
  readonly engine: PolicyEngine
  readonly ctx: RequestContext
  readonly coll: Collection<Document>
  readonly name: string
  private readonly db: Db
  private readonly maxTimeMS: number
  private readonly filterLimits: QueryLimits
  private readableAccess: FieldAccess | undefined

  constructor(
    engine: PolicyEngine,
    ctx: RequestContext,
    db: Db,
    name: string,
    limits: { readonly maxTimeMS: number; readonly filterLimits: QueryLimits },
  ) {
    this.maxTimeMS = limits.maxTimeMS
    this.filterLimits = limits.filterLimits
    this.engine = engine
    this.ctx = ctx
    this.db = db
    this.coll = db.collection(name)
    this.name = name
    this.service = ctx.roles.has(Role.Service)
  }

  /** Options for a write: majority write concern outside a transaction, the transaction's otherwise. */
  writeOptions(session: ClientSession): {
    session: ClientSession
    maxTimeMS: number
    writeConcern?: typeof MAJORITY
  } {
    return session.inTransaction()
      ? { session, maxTimeMS: this.maxTimeMS }
      : { session, maxTimeMS: this.maxTimeMS, writeConcern: MAJORITY }
  }

  /**
   * On the fast path, the cluster time of the write that just ran, taken before any read back. Inside a
   * transaction the commit time is used instead, so this returns `undefined`.
   */
  fastTime(session: ClientSession): ClusterTime | undefined {
    if (session.inTransaction()) return undefined
    const ct = toCt(session.operationTime)
    if (ct === undefined) throw new CanopyError(ErrorCode.Internal, "The write has no cluster time")
    return ct
  }

  requireGrant(op: "insert" | "update" | "delete"): void {
    if (!this.engine.hasGrant(this.name, op, this.ctx))
      throw new ForbiddenError(`No policy grants ${op} on '${this.name}'`)
  }

  writable(op: "insert" | "update"): FieldAccess {
    return this.engine.writable(this.name, op, this.ctx)
  }

  readable(): FieldAccess {
    this.readableAccess ??= this.engine.readable(this.name, this.ctx)
    return this.readableAccess
  }

  /** Parses a caller filter and rejects references to unreadable fields, which would leak them. */
  private parseCallerFilter(input: unknown, what: string): ParsedFilter {
    if (!isDocument(input)) throw new InvalidQueryError(`${what} must be a document`)
    const parsed = parseFilter(input, { context: "filter", limits: this.filterLimits })
    const denied = deniedPaths(this.readable(), parsed.paths)
    if (denied.length > 0)
      throw new InvalidQueryError(
        `${what} may not reference unreadable fields: ${denied.join(", ")}`,
      )
    return parsed
  }

  selector(selector: { readonly id: unknown } | { readonly filter: unknown }): Compiled {
    if ("id" in selector) {
      validateId(selector.id)
      return { kind: "filter", filter: { _id: selector.id } }
    }
    return { kind: "filter", filter: this.parseCallerFilter(selector.filter, "The filter").filter }
  }

  precondition(where: unknown): Compiled {
    if (where === undefined) return { kind: "all" }
    const parsed = this.parseCallerFilter(where, "where")
    return Object.keys(parsed.filter).length === 0
      ? { kind: "all" }
      : { kind: "filter", filter: parsed.filter }
  }

  /** The driver filter of a compiled target. A denied target becomes a filter that matches nothing. */
  filter(target: Compiled): Document {
    return toDriver(toFilter(target)) as Document
  }

  byIds(ids: readonly unknown[], target: Compiled): Document {
    return { $and: [{ _id: { $in: [...ids] } }, this.filter(target)] }
  }

  async findIds(session: ClientSession, target: Compiled, limit: number): Promise<unknown[]> {
    const docs = await this.coll
      .find(this.filter(target), {
        session,
        projection: { _id: 1 },
        limit,
        maxTimeMS: this.maxTimeMS,
        ...EXACT_BSON,
      })
      .toArray()
    return docs.map((doc) => doc["_id"])
  }

  /** A failed precondition on a document the caller can see is a conflict; an invisible one is not found. */
  async assertNoConflict(session: ClientSession, visible: Compiled): Promise<void> {
    const ids = await this.findIds(session, visible, 1)
    if (ids.length > 0) throw new ConflictError("The where precondition did not match")
  }

  /**
   * Lets MongoDB evaluate `check` on the written documents and, when `read` is set, reads them back through
   * `USING(read)` and the read field rules, in one aggregation. Throws {@link PolicyViolationError} when a
   * document fails the check. Returns the documents in the order of `ids`, `null` for unreadable ones.
   */
  async verify(
    session: ClientSession,
    ids: readonly unknown[],
    check: Compiled | undefined,
    op: "insert" | "update",
    read: boolean,
  ): Promise<(ReturnedDocument | null)[] | undefined> {
    if (check?.kind === "deny") throw violation(op, this.name)
    const facet = this.facets(ids, check, read)
    if (Object.keys(facet).length === 0) return read ? ids.map(() => null) : undefined
    const [out] = await this.coll
      .aggregate([{ $match: { _id: { $in: [...ids] } } }, { $facet: facet }], {
        session,
        maxTimeMS: this.maxTimeMS,
        ...EXACT_BSON,
      })
      .toArray()
    return this.outcome(out, ids, op, read)
  }

  /**
   * Lets MongoDB evaluate `check(insert)` and the read back on documents before they are inserted, through
   * `$documents`, so a document that fails the check is refused before anything is written and a single
   * insert needs no transaction. MongoDB stores an inserted document as sent, `_id` first, so the read back
   * equals reading it after the write. Throws {@link PolicyViolationError} when a document fails the check.
   */
  async precheck(docs: readonly Document[], check: Compiled): Promise<(ReturnedDocument | null)[]> {
    if (check.kind === "deny") throw violation("insert", this.name)
    const ids = docs.map((doc) => doc["_id"])
    const facet = this.facets(ids, check, true)
    if (Object.keys(facet).length === 0) return ids.map(() => null)
    const [out] = await this.db
      .aggregate([{ $documents: [...docs] }, { $facet: facet }], {
        maxTimeMS: this.maxTimeMS,
        ...EXACT_BSON,
      })
      .toArray()
    return this.outcome(out, ids, "insert", true) ?? ids.map(() => null)
  }

  /** The `$facet` of a check and a read back over the documents with these ids. */
  private facets(ids: readonly unknown[], check: Compiled | undefined, read: boolean): Document {
    const facet: Document = {}
    if (check?.kind === "filter" && ids.length > 0)
      facet["bad"] = [{ $match: { $nor: [toDriver(check.filter)] } }, { $count: "n" }]
    const readFilter = read
      ? this.engine.effectiveRead(this.name, { _id: { $in: [...ids] } }, this.ctx)
      : undefined
    if (readFilter !== undefined && readFilter.kind !== "deny") {
      const projection = toProjection(this.readable())
      facet["docs"] = [
        { $match: this.filter(readFilter) },
        ...(projection === undefined ? [] : [{ $project: projection }]),
      ]
    }
    return facet
  }

  /** Reads the result of {@link facets}: throws on a failed check, returns the readable documents. */
  private outcome(
    out: Document | undefined,
    ids: readonly unknown[],
    op: "insert" | "update",
    read: boolean,
  ): (ReturnedDocument | null)[] | undefined {
    const bad = (out?.["bad"] as Document[] | undefined)?.[0]?.["n"]
    if (bad !== undefined && Number(bad) > 0) throw violation(op, this.name)
    if (!read) return undefined
    const access = this.readable()
    const docs = (out?.["docs"] as Document[] | undefined) ?? []
    const byId = new Map(docs.map((doc) => [canonicalString(doc["_id"]), doc]))
    return ids.map((id) => {
      const doc = byId.get(canonicalString(id))
      return doc === undefined ? null : projectReadable(access, doc)
    })
  }
}

function validateMutationId(mutationId: string | undefined): void {
  if (mutationId !== undefined && !MUTATION_ID.test(mutationId))
    throw new InvalidQueryError(
      "A mutation ID must be 8 to 128 letters, digits, hyphens or underscores",
    )
}

/** Adds the position of the failing operation of a batch to an error. */
function atIndex(error: CanopyError, index: number): CanopyError {
  return new CanopyError(error.code, `Operation ${index}: ${error.message}`, {
    cause: error,
    details: { ...error.details, index },
  })
}

function requireBulk(flag: unknown): void {
  if (flag !== true)
    throw new InvalidQueryError("Writes to many documents must be requested with bulk: true")
}

function bulkLimit(max: number): CanopyError {
  return new CanopyError(
    ErrorCode.BulkLimit,
    `A bulk write may not touch more than ${max} documents`,
  )
}

function violation(op: "insert" | "update", collection: string): PolicyViolationError {
  return new PolicyViolationError(
    `The resulting document does not satisfy the ${op} check for collection '${collection}'`,
  )
}

function assertWritable(access: FieldAccess, paths: readonly string[], collection: string): void {
  const denied = deniedPaths(
    access,
    paths.filter((path) => path !== "_id"),
  )
  if (denied.length > 0)
    throw new PolicyViolationError(
      `The caller may not write ${denied.join(", ")} in collection '${collection}'`,
    )
}

function assertMutable(written: readonly string[], immutable: readonly string[]): void {
  const frozen = immutableViolations(written, immutable)
  if (frozen.length > 0)
    throw new PolicyViolationError(`Immutable fields cannot be changed: ${frozen.join(", ")}`)
}

function empty(): Outcome {
  return { matched: 0, modified: 0, deleted: 0, insertedIds: [], changedIds: [] }
}

function withCt(outcome: Outcome, ct: ClusterTime | undefined): Outcome {
  return ct === undefined ? outcome : { ...outcome, ct }
}

function upserted(id: unknown, documents: (ReturnedDocument | null)[] | undefined): Outcome {
  return {
    matched: 0,
    modified: 0,
    deleted: 0,
    insertedIds: [id],
    upsertedId: id,
    changedIds: [id],
    ...(documents === undefined ? {} : { documents }),
  }
}

function withoutDocuments(outcome: Outcome): Outcome {
  const { documents: _documents, ...rest } = outcome
  return rest
}

function normalizeOutcome(stored: Outcome): Outcome {
  return {
    matched: Number(stored.matched),
    modified: Number(stored.modified),
    deleted: Number(stored.deleted),
    insertedIds: stored.insertedIds,
    ...(stored.upsertedId === undefined ? {} : { upsertedId: stored.upsertedId }),
    changedIds: stored.changedIds,
    ...(stored.documents === undefined ? {} : { documents: stored.documents }),
  }
}
