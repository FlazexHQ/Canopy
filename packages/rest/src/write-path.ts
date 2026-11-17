import { type PolicyEngine, type RequestContext, Role } from "@canopy/policy"
import {
  CanopyError,
  type ClusterTime,
  ConflictError,
  ErrorCode,
  InvalidQueryError,
  serverErrorCode,
  toCanopyError,
  toCt,
} from "@canopy/protocol"
import { DEFAULT_LIMITS, type QueryLimits } from "@canopy/query"
import {
  type ClientSession,
  type Db,
  type Document,
  type MongoClient,
  MongoServerError,
} from "mongodb"
import { abortCheck, EXACT_BSON, toDriver } from "./driver.ts"
import { fromDriverError } from "./errors.ts"
import {
  fingerprint,
  type MutationRecord,
  normalizeOutcome,
  type Outcome,
  type RecordKey,
  Replay,
  recordOf,
  sameStored,
  storedOutcome,
  validateMutationId,
  withoutCt,
} from "./idempotency.ts"
import { validateCollectionName } from "./validation.ts"
import { type CombinedRun, isBulkOp, type Plan, planWrite, type Run } from "./write-plans.ts"
import { Scope } from "./write-scope.ts"

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
  /**
   * Whether the result carries the written documents (`documents`). Defaults to `true`. With `false` no
   * document is read back after the write, which saves a command when the caller does not use them (a
   * realtime mutation whose change events reach the caller, or `Prefer: return=minimal`); `check` is still
   * evaluated by MongoDB.
   */
  readonly returnDocuments?: boolean
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
  /**
   * Called once per committed write (each operation of a batch on its own), after the commit; replays of
   * a mutation ID are not reported again. An exception thrown here is ignored: the write has committed.
   */
  readonly onWrite?: (event: WriteEvent) => void
  /**
   * Explains refused writes in the error details (`details.explain`): the policies of the operation with
   * their outcome and resolved clauses, or the fields at fault. It reveals the policy structure, so it is
   * for development only.
   */
  readonly explainDenials?: boolean
}

/** A committed write, as reported to {@link WritePathOptions.onWrite}. */
export interface WriteEvent {
  readonly subject: string
  readonly roles: readonly string[]
  readonly collection: string
  readonly op: WriteRequest["op"]
  /** The `_id` of every document the write inserted, changed or deleted, as driver values. */
  readonly ids: readonly unknown[]
  readonly ct: ClusterTime
  readonly mutationId?: string
}

const INDEX_OPTIONS_CONFLICT = new Set([85, 86])

/** The server error code of a duplicate key. */
export const DUPLICATE_KEY = 11000

/** The wire version of MongoDB 8.0, the first with a `bulkWrite` command across namespaces. */
const BULK_WRITE_WIRE_VERSION = 25

/** The write concern of every write and idempotency record. */
export const MAJORITY = { w: "majority" } as const

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
  private readonly onWrite: ((event: WriteEvent) => void) | undefined
  private readonly explainDenials: boolean
  private indexes: Promise<void> | undefined
  private bulkSupport: Promise<boolean> | undefined

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
    this.onWrite = options.onWrite
    this.explainDenials = options.explainDenials === true
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
    const read = options.returnDocuments !== false
    const engine = this.engine()
    const plan = this.plan(engine, caller.context, request, read)
    if (plan.fast && options.mutationId === undefined) {
      const result = await this.executeFast(plan.run, service)
      this.report(caller, request, result, result.ct, undefined)
      return result
    }
    const committed = await this.transact(
      caller,
      {
        c: request.collection,
        op: request.op,
        fp: options.mutationId === undefined ? "" : fingerprint(caller, request),
      },
      [plan],
      options,
    )
    const [stored] = committed.outcomes
    if (stored === undefined) throw new CanopyError(ErrorCode.Internal, "The write has no outcome")
    if (!committed.replayed) this.report(caller, request, stored, committed.ct, options.mutationId)
    const outcome =
      committed.replayed && read ? await this.readBack(engine, caller, request, stored) : stored
    return { ...withoutCt(outcome), ct: committed.ct, replayed: committed.replayed }
  }

  /**
   * The readable documents of a committed write that ran with `returnDocuments: false`, read now: the
   * current readable version of each written document, `null` where it is gone or unreadable (always for
   * a delete). `undefined` for bulk writes, which return no documents.
   */
  async documentsOf(
    caller: Caller,
    request: WriteRequest,
    result: WriteResult,
  ): Promise<readonly (ReturnedDocument | null)[] | undefined> {
    if (isBulkOp(request.op)) return undefined
    if (result.documents !== undefined) return result.documents
    return (await this.readBack(this.engine(), caller, request, result)).documents
  }

  /**
   * The documents of a replayed write, read again because idempotency records keep no documents: the
   * current readable version of each written document, `null` where it is gone or unreadable. A replayed
   * delete has no pre image left to return.
   */
  private async readBack(
    engine: PolicyEngine,
    caller: Caller,
    request: WriteRequest,
    outcome: Outcome,
  ): Promise<Outcome> {
    if (outcome.documents !== undefined) return outcome
    let ids: readonly unknown[]
    switch (request.op) {
      case "insert":
      case "insertMany":
        ids = outcome.insertedIds
        break
      case "update":
      case "replace":
        ids = outcome.matched > 0 || outcome.upsertedId !== undefined ? [toDriver(request.id)] : []
        break
      case "delete":
        return outcome.deleted > 0 ? { ...outcome, documents: [null] } : outcome
      default:
        return outcome
    }
    if (ids.length === 0) return outcome
    const scope = this.scope(engine, caller.context, request.collection)
    const session = this.client.startSession()
    try {
      const documents = await scope.verify(session, ids, undefined, "update", true)
      return documents === undefined ? outcome : { ...outcome, documents }
    } catch (error: unknown) {
      throw fromDriverError(error, scope.service)
    } finally {
      await session.endSession()
    }
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
    const read = options.returnDocuments !== false
    const plans = requests.map((request, index) => {
      try {
        return this.plan(engine, caller.context, request, read)
      } catch (error: unknown) {
        throw atIndex(toCanopyError(error), index)
      }
    })
    const committed = await this.transact(
      caller,
      {
        c: "",
        op: "batch",
        fp: options.mutationId === undefined ? "" : fingerprint(caller, requests),
      },
      plans,
      options,
    )
    if (!committed.replayed)
      for (const [index, outcome] of committed.outcomes.entries()) {
        const request = requests[index]
        if (request !== undefined)
          this.report(caller, request, outcome, committed.ct, options.mutationId)
      }
    const outcomes =
      committed.replayed && read
        ? await Promise.all(
            committed.outcomes.map((outcome, index) => {
              const request = requests[index]
              return request === undefined || isBulkOp(request.op)
                ? outcome
                : this.readBack(engine, caller, request, outcome)
            }),
          )
        : committed.outcomes
    return {
      results: outcomes.map(withoutCt),
      ct: committed.ct,
      replayed: committed.replayed,
    }
  }

  private async transact(
    caller: Caller,
    key: RecordKey,
    plans: readonly Plan[],
    options: WriteOptions,
  ): Promise<{ outcomes: readonly Outcome[]; ct: ClusterTime; replayed: boolean }> {
    const service = caller.context.roles.has(Role.Service)
    const { mutationId } = options
    await this.ensureIndexes()
    const [only] = plans
    const combined =
      mutationId !== undefined &&
      plans.length === 1 &&
      only?.withRecord !== undefined &&
      (await this.clientBulkWrite())
        ? only.withRecord
        : undefined
    const runs = plans.map((plan) => plan.run)
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
            if (combined !== undefined && mutationId !== undefined) {
              failedAt = 0
              const outcome = await this.runWithRecord(s, combined, mutationId, caller, key)
              failedAt = undefined
              return [outcome]
            }
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

  /**
   * Runs a fast path write. The write runs in a session only to read its `operationTime`; the reads after
   * it (the read back and the conflict check) run outside the session, so they carry no `afterClusterTime`
   * and do not wait for the cluster time to advance. That is safe because the write was acknowledged by a
   * majority: it is on every node that can be primary afterwards, so a primary read that starts after the
   * acknowledgment sees it.
   */
  private report(
    caller: Caller,
    request: WriteRequest,
    outcome: Outcome,
    ct: ClusterTime,
    mutationId: string | undefined,
  ): void {
    if (this.onWrite === undefined) return
    const ids = outcome.changedIds
    if (ids.length === 0) return
    try {
      this.onWrite({
        subject: caller.subject,
        roles: [...caller.context.roles].sort(),
        collection: request.collection,
        op: request.op,
        ids,
        ct,
        ...(mutationId === undefined ? {} : { mutationId }),
      })
    } catch {
      // The write has committed; a failing observer must not turn it into an error.
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
    try {
      await this.meta
        .collection<MutationRecord>("mutations")
        .insertOne(recordOf(id, caller, key, outcomes), { session })
    } catch (error: unknown) {
      if (error instanceof MongoServerError && serverErrorCode(error) === DUPLICATE_KEY)
        throw new Replay()
      throw error
    }
  }

  /**
   * Whether the deployment runs MongoDB 8.0 or later (wire version 25), whose `bulkWrite` command writes to
   * several namespaces at once. Read once from `hello`; a failed read means no.
   */
  private clientBulkWrite(): Promise<boolean> {
    this.bulkSupport ??= this.client
      .db("admin")
      .command({ hello: 1 })
      .then(
        (hello) => Number(hello["maxWireVersion"]) >= BULK_WRITE_WIRE_VERSION,
        () => {
          this.bulkSupport = undefined
          return false
        },
      )
    return this.bulkSupport
  }

  /**
   * Runs a single document write and the insert of its idempotency record as one `bulkWrite` command. The
   * record is written with the outcome the write has in the common case; when the write turns out
   * differently (nothing matched, or nothing changed) the record is corrected in the same transaction, so a
   * committed record always holds the write's real outcome.
   */
  private async runWithRecord(
    session: ClientSession,
    combined: CombinedRun,
    id: string,
    caller: Caller,
    key: RecordKey,
  ): Promise<Outcome> {
    const mutations = this.meta.collection<MutationRecord>("mutations")
    const recordModel = {
      name: "insertOne" as const,
      namespace: `${this.meta.databaseName}.mutations`,
      document: recordOf(id, caller, key, [combined.expected]) as unknown as Document,
    }
    const outcome = await combined.run(session, recordModel)
    if (!sameStored(outcome, combined.expected))
      await mutations.updateOne(
        { _id: id },
        { $set: { result: storedOutcome(outcome) } },
        { session, maxTimeMS: this.limits.maxTimeMS },
      )
    return outcome
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
      if (
        record.c !== key.c ||
        record.op !== key.op ||
        (record.fp !== undefined && record.fp !== key.fp)
      )
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

  private scope(engine: PolicyEngine, ctx: RequestContext, name: string): Scope {
    validateCollectionName(name)
    const service = ctx.roles.has(Role.Service)
    if (!service && !engine.isExposed(name))
      throw new CanopyError(ErrorCode.NotFound, `Unknown collection '${name}'`)
    return new Scope(engine, ctx, this.db, name, {
      maxTimeMS: this.limits.maxTimeMS,
      filterLimits: this.queryLimits,
      explain: this.explainDenials,
    })
  }

  private plan(
    engine: PolicyEngine,
    ctx: RequestContext,
    request: WriteRequest,
    read: boolean,
  ): Plan {
    return planWrite(
      { write: this.limits, query: this.queryLimits },
      this.scope(engine, ctx, request.collection),
      request,
      read,
    )
  }
}

/** Adds the position of the failing operation of a batch to an error. */
function atIndex(error: CanopyError, index: number): CanopyError {
  return new CanopyError(error.code, `Operation ${index}: ${error.message}`, {
    cause: error,
    details: { ...error.details, index },
  })
}
