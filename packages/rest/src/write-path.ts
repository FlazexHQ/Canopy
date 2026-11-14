import { createHash } from "node:crypto"
import {
  and,
  type Compiled,
  checkImplied,
  deniedPaths,
  deniesTextSearch,
  type FieldAccess,
  immutableViolations,
  type Operation,
  type PolicyEngine,
  projectReadable,
  type RequestContext,
  Role,
  TEXT_SEARCH_DENIED,
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
  type AnyClientBulkWriteModel,
  BSON,
  type ClientBulkWriteResult,
  type ClientSession,
  type Collection,
  type Db,
  type Document,
  type MongoClient,
  MongoClientBulkWriteError,
  MongoError,
  MongoServerError,
} from "mongodb"
import { abortCheck, EXACT_BSON, toDriver } from "./driver.ts"
import { fromDriverError } from "./errors.ts"
import { leafPaths } from "./paths.ts"
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

const MUTATION_ID = /^[A-Za-z0-9_-]{8,128}$/
const INDEX_OPTIONS_CONFLICT = new Set([85, 86])
const DUPLICATE_KEY = 11000
/** The wire version of MongoDB 8.0, the first with a `bulkWrite` command across namespaces. */
const BULK_WRITE_WIRE_VERSION = 25
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
  /** The fingerprint of the request and roles that wrote the record; absent on older records. */
  fp?: string
}

interface RecordKey {
  readonly c: string
  readonly op: string
  readonly fp: string
}

/** Binds a mutation ID to one request: the same ID with another body or role set is another write. */
function fingerprint(caller: Caller, request: unknown): string {
  return createHash("sha256")
    .update(canonicalString({ request, roles: [...caller.context.roles].sort() }))
    .digest("base64url")
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
  /** The same write sent together with its idempotency record, where the plan supports it. */
  readonly withRecord?: CombinedRun
}

/** The insert of an idempotency record, as a model of a client `bulkWrite`. */
interface RecordModel {
  readonly name: "insertOne"
  readonly namespace: string
  readonly document: Document
}

/**
 * A write that sends its idempotency record in the same command. `expected` is the outcome it has unless
 * the target is missing or unchanged; the record is first written with it.
 */
interface CombinedRun {
  readonly expected: Outcome
  run(session: ClientSession, record: RecordModel): Promise<Outcome>
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
    const scope = this.scope(engine, ctx, request.collection)
    switch (request.op) {
      case "insert":
        return this.planInsert(scope, [request.doc], true, read)
      case "insertMany": {
        if (!Array.isArray(request.docs)) throw new InvalidQueryError("docs must be an array")
        return this.planInsert(scope, request.docs, false, read)
      }
      case "update":
        return this.planUpdate(scope, { id: request.id }, request.update, request.where, read)
      case "updateMany":
        requireBulk(request.bulk)
        return this.planUpdate(scope, { filter: request.filter }, request.update, undefined, false)
      case "replace":
        return this.planReplace(scope, request, read)
      case "delete":
        return this.planDelete(scope, { id: request.id }, request.where, read)
      case "deleteMany":
        requireBulk(request.bulk)
        return this.planDelete(scope, { filter: request.filter }, undefined, false)
      default:
        throw new InvalidQueryError("Unknown write operation")
    }
  }

  private planInsert(scope: Scope, docs: readonly unknown[], single: boolean, read: boolean): Plan {
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
      if (!scope.service && writable.kind !== "all")
        assertWritable(scope, writable, leafPaths(record))
      validateId(record["_id"])
      return idFirst(toDriver(record))
    })
    const check = scope.engine.check(scope.name, "insert", scope.ctx)
    if (check.kind === "deny") throw violation(scope, "insert")
    const precheck = single && BSON.calculateObjectSize({ prepared }) <= PRECHECK_MAX_BYTES
    const ids = prepared.map((doc) => doc["_id"])
    const [first] = prepared
    const run: Run = async (session) => {
      const checked = precheck ? await scope.precheck(prepared, check, read) : undefined
      if (single && first !== undefined)
        await scope.coll.insertOne(first, scope.writeOptions(session))
      else await scope.coll.insertMany(prepared, { ...scope.writeOptions(session), ordered: true })
      const ct = scope.fastTime(session)
      const documents = precheck ? checked : await scope.verify(session, ids, check, "insert", read)
      return withCt(inserted(ids, documents), ct)
    }
    const withRecord: CombinedRun | undefined =
      single && first !== undefined
        ? {
            expected: inserted(ids, undefined),
            run: async (session, record) => {
              await scope.bulkWrite(session, [
                { name: "insertOne", namespace: scope.namespace, document: first },
                record,
              ])
              return inserted(ids, await scope.verify(session, ids, check, "insert", read))
            },
          }
        : undefined
    return {
      run,
      fast: single && (check.kind === "all" || precheck),
      ...(withRecord === undefined ? {} : { withRecord }),
    }
  }

  private planUpdate(
    scope: Scope,
    selector: { readonly id: unknown } | { readonly filter: unknown },
    rawUpdate: unknown,
    rawWhere: unknown,
    read: boolean,
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
      assertWritable(scope, scope.writable("update"), parsed.writtenPaths)
      assertMutable(scope, parsed.writtenPaths)
    }
    const base = scope.selector(selector)
    const where = scope.precondition(rawWhere)
    const using = scope.engine.target(scope.name, "update", scope.ctx)
    const target = and(base, where, using)
    const check = scope.engine.check(scope.name, "update", scope.ctx)
    const update = toDriver(parsed.update) as Document
    if ("id" in selector) {
      const id = toDriver(selector.id)
      const filter = scope.filter(target)
      const implied = check.kind === "all" || checkImplied(check, target, parsed.writtenPaths)
      const effectiveCheck = implied ? undefined : check
      const finish = async (
        session: ClientSession,
        matched: number,
        modifiedCount: number,
      ): Promise<Outcome> => {
        if (matched === 0) {
          if (where.kind !== "all") await scope.assertNoConflict(session, and(base, using))
          return empty()
        }
        const modified = modifiedCount > 0
        const documents = await scope.verify(
          session,
          [id],
          modified ? effectiveCheck : undefined,
          "update",
          read,
        )
        return {
          matched,
          modified: modifiedCount,
          deleted: 0,
          insertedIds: [],
          changedIds: modified ? [id] : [],
          ...(documents === undefined ? {} : { documents }),
        }
      }
      const run: Run = async (session) => {
        const result = await scope.coll.updateOne(filter, update, scope.writeOptions(session))
        const ct = scope.fastTime(session)
        return withCt(await finish(session, result.matchedCount, result.modifiedCount), ct)
      }
      const withRecord: CombinedRun = {
        expected: {
          matched: 1,
          modified: 1,
          deleted: 0,
          insertedIds: [],
          changedIds: [id],
        },
        run: async (session, record) => {
          const result = await scope.bulkWrite(session, [
            { name: "updateOne", namespace: scope.namespace, filter, update },
            record,
          ])
          const written = result.updateResults?.get(0)
          if (written === undefined)
            throw new CanopyError(ErrorCode.Internal, "The bulk write has no update result")
          return finish(session, written.matchedCount, written.modifiedCount)
        },
      }
      return { run, fast: implied, withRecord }
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
    read: boolean,
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
      if (upsert) assertWritable(scope, scope.writable("insert"), leafPaths(doc))
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
        const documents = await scope.verify(session, [id], undefined, "insert", read)
        return withCt(upserted(id, documents), ct)
      }
      if (result.matchedCount === 0) {
        if (where.kind !== "all") await scope.assertNoConflict(session, visible)
        if (insertCheck === undefined) return withCt(empty(), ct)
        if (insertCheck.kind === "deny") throw violation(scope, "insert")
        await scope.coll.insertOne(replacement, scope.writeOptions(session))
        ct = scope.fastTime(session)
        const documents = await scope.verify(session, [id], insertCheck, "insert", read)
        return withCt(upserted(id, documents), ct)
      }
      const modified = result.modifiedCount > 0
      const documents = await scope.verify(
        session,
        [id],
        modified ? updateCheck : undefined,
        "update",
        read,
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
    read: boolean,
  ): Plan {
    scope.requireGrant("delete")
    const base = scope.selector(selector)
    const where = scope.precondition(rawWhere)
    const target = and(base, where, scope.engine.target(scope.name, "delete", scope.ctx))
    const visible = and(base, scope.engine.target(scope.name, "delete", scope.ctx))
    if ("id" in selector) {
      const id = toDriver(selector.id)
      const run: Run = async (session) => {
        if (!read) {
          const result = await scope.coll.deleteOne(
            scope.filter(target),
            scope.writeOptions(session),
          )
          const ct = scope.fastTime(session)
          if (result.deletedCount === 0) {
            if (where.kind !== "all") await scope.assertNoConflict(session, visible)
            return withCt(empty(), ct)
          }
          return withCt(
            { matched: 1, modified: 0, deleted: 1, insertedIds: [], changedIds: [id] },
            ct,
          )
        }
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
  /** Whether refusals carry `details.explain`. */
  readonly explain: boolean
  private readonly db: Db
  private readonly maxTimeMS: number
  private readonly filterLimits: QueryLimits
  private readableAccess: FieldAccess | undefined

  constructor(
    engine: PolicyEngine,
    ctx: RequestContext,
    db: Db,
    name: string,
    limits: {
      readonly maxTimeMS: number
      readonly filterLimits: QueryLimits
      readonly explain: boolean
    },
  ) {
    this.explain = limits.explain
    this.maxTimeMS = limits.maxTimeMS
    this.filterLimits = limits.filterLimits
    this.engine = engine
    this.ctx = ctx
    this.db = db
    this.coll = db.collection(name)
    this.name = name
    this.service = ctx.roles.has(Role.Service)
  }

  /** The collection's namespace, `<database>.<collection>`. */
  get namespace(): string {
    return `${this.db.databaseName}.${this.name}`
  }

  /**
   * Runs an ordered client `bulkWrite` inside the transaction of `session`. The last model is the
   * idempotency record: a duplicate key on it means the mutation ID was used already. A write error of an
   * earlier model is rethrown as that model's server error.
   */
  async bulkWrite(
    session: ClientSession,
    models: readonly AnyClientBulkWriteModel<Document>[],
  ): Promise<ClientBulkWriteResult> {
    try {
      return await this.db.client.bulkWrite([...models], {
        session,
        ordered: true,
        verboseResults: true,
        maxTimeMS: this.maxTimeMS,
      })
    } catch (error: unknown) {
      if (!(error instanceof MongoClientBulkWriteError)) throw error
      if (error.writeErrors.get(models.length - 1)?.code === DUPLICATE_KEY) throw new Replay()
      const [first] = error.writeErrors.values()
      if (first === undefined) throw error.cause instanceof MongoError ? error.cause : error
      const server = new MongoServerError({ message: first.message, code: first.code })
      for (const label of error.errorLabels) server.addErrorLabel(label)
      throw server
    }
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
      throw new ForbiddenError(
        `No policy grants ${op} on '${this.name}'`,
        explained(this, op, "using"),
      )
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
    if (deniesTextSearch(this.readable(), parsed.filter))
      throw new InvalidQueryError(TEXT_SEARCH_DENIED)
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

  /**
   * The session a read after a write runs in: the write's transaction, or none on the fast path (see
   * `executeFast` for why that read still sees the write).
   */
  private readSession(session: ClientSession): { session?: ClientSession } {
    return session.inTransaction() ? { session } : {}
  }

  async findIds(session: ClientSession, target: Compiled, limit: number): Promise<unknown[]> {
    const docs = await this.coll
      .find(this.filter(target), {
        ...this.readSession(session),
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
    if (check?.kind === "deny") throw violation(this, op)
    const [only] = ids
    if (ids.length === 1 && (check === undefined || check.kind === "all"))
      return read ? [await this.readOne(session, only)] : undefined
    if (!read) {
      if (check?.kind === "filter" && ids.length > 0) {
        const failing = await this.coll.countDocuments(
          { $and: [{ _id: { $in: [...ids] } }, { $nor: [toDriver(check.filter)] }] } as Document,
          { ...this.readSession(session), limit: 1, maxTimeMS: this.maxTimeMS },
        )
        if (failing > 0) throw violation(this, op)
      }
      return undefined
    }
    const facet = this.facets(ids, check, read)
    if (Object.keys(facet).length === 0) return read ? ids.map(() => null) : undefined
    const [out] = await this.coll
      .aggregate([{ $match: { _id: { $in: [...ids] } } }, { $facet: facet }], {
        ...this.readSession(session),
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
  async precheck(
    docs: readonly Document[],
    check: Compiled,
    read: boolean,
  ): Promise<(ReturnedDocument | null)[] | undefined> {
    if (check.kind === "deny") throw violation(this, "insert")
    const ids = docs.map((doc) => doc["_id"])
    const facet = this.facets(ids, check, read)
    if (Object.keys(facet).length === 0) return read ? ids.map(() => null) : undefined
    const [out] = await this.db
      .aggregate([{ $documents: [...docs] }, { $facet: facet }], {
        maxTimeMS: this.maxTimeMS,
        ...EXACT_BSON,
      })
      .toArray()
    return this.outcome(out, ids, "insert", read) ?? (read ? ids.map(() => null) : undefined)
  }

  /**
   * Reads one written document back through `USING(read)` and the read field rules, with a plain `find`,
   * or `null` when the caller cannot read it.
   */
  private async readOne(session: ClientSession, id: unknown): Promise<ReturnedDocument | null> {
    const readFilter = this.engine.effectiveRead(this.name, { _id: { $eq: id } }, this.ctx)
    if (readFilter.kind === "deny") return null
    const projection = toProjection(this.readable())
    const [doc] = await this.coll
      .find(this.filter(readFilter), {
        ...this.readSession(session),
        ...(projection === undefined ? {} : { projection }),
        limit: 1,
        batchSize: 1,
        maxTimeMS: this.maxTimeMS,
        ...EXACT_BSON,
      })
      .toArray()
    return doc === undefined ? null : projectReadable(this.readable(), doc)
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
    if (bad !== undefined && Number(bad) > 0) throw violation(this, op)
    if (!read) return undefined
    const access = this.readable()
    const docs = (out?.["docs"] as Document[] | undefined) ?? []
    if (docs.length === 0) return ids.map(() => null)
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

/**
 * The error options of a refusal: with `scope.explain`, `details.explain` lists the policies of the
 * operation's clause with their outcome and resolved filter, so a denial in development says which policy
 * decided it.
 */
function explained(
  scope: Scope,
  op: Operation,
  clause: "using" | "check",
): { details: Record<string, unknown> } | undefined {
  if (!scope.explain) return undefined
  const explanation = scope.engine.explain(scope.name, op, scope.ctx, clause)
  return {
    details: {
      explain: {
        collection: scope.name,
        op,
        clause,
        roles: explanation.roles,
        policies: explanation.policies.map((policy) => ({
          name: policy.name,
          kind: policy.kind,
          applies: policy.applies,
          reason: policy.reason,
          ...(policy.resolved === undefined ? {} : { filter: policy.resolved }),
        })),
      },
    },
  }
}

function violation(scope: Scope, op: "insert" | "update"): PolicyViolationError {
  return new PolicyViolationError(
    `The resulting document does not satisfy the ${op} check for collection '${scope.name}'`,
    explained(scope, op, "check"),
  )
}

function assertWritable(scope: Scope, access: FieldAccess, paths: readonly string[]): void {
  const denied = deniedPaths(
    access,
    paths.filter((path) => path !== "_id"),
  )
  if (denied.length > 0)
    throw new PolicyViolationError(
      `The caller may not write ${denied.join(", ")} in collection '${scope.name}'`,
      scope.explain
        ? { details: { explain: { rule: "fields.write", fields: denied } } }
        : undefined,
    )
}

function assertMutable(scope: Scope, written: readonly string[]): void {
  const frozen = immutableViolations(written, scope.engine.immutable(scope.name))
  if (frozen.length > 0)
    throw new PolicyViolationError(
      `Immutable fields cannot be changed: ${frozen.join(", ")}`,
      scope.explain ? { details: { explain: { rule: "immutable", fields: frozen } } } : undefined,
    )
}

/** The document with `_id` as its first field, as MongoDB stores it, and a new ObjectId when it has none. */
function idFirst(doc: Document): Document {
  for (const key in doc) {
    if (key === "_id" && doc["_id"] !== undefined) return doc
    break
  }
  const out: Document = { _id: doc["_id"] ?? new BSON.ObjectId() }
  for (const key of Object.keys(doc)) if (key !== "_id") out[key] = doc[key]
  return out
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

function inserted(
  ids: readonly unknown[],
  documents: (ReturnedDocument | null)[] | undefined,
): Outcome {
  return {
    matched: 0,
    modified: 0,
    deleted: 0,
    insertedIds: ids,
    changedIds: ids,
    ...(documents === undefined ? {} : { documents }),
  }
}

function withoutCt(outcome: Outcome): Omit<Outcome, "ct"> {
  const { ct: _ct, ...rest } = outcome
  return rest
}

/** An outcome as an idempotency record keeps it: without documents (they are read again on replay). */
function storedOutcome(outcome: Outcome): Outcome {
  const { documents: _documents, ct: _ct, ...rest } = outcome
  return rest
}

function sameStored(a: Outcome, b: Outcome): boolean {
  return canonicalString(storedOutcome(a)) === canonicalString(storedOutcome(b))
}

function recordOf(
  id: string,
  caller: Caller,
  key: RecordKey,
  outcomes: readonly Outcome[],
): MutationRecord {
  const stored = outcomes.map(storedOutcome)
  const [first] = stored
  return {
    _id: id,
    sub: caller.subject,
    c: key.c,
    op: key.op,
    fp: key.fp,
    at: new Date(),
    ...(key.op === "batch" ? { results: stored } : first === undefined ? {} : { result: first }),
  }
}

function isBulkOp(op: WriteRequest["op"]): boolean {
  return op === "insertMany" || op === "updateMany" || op === "deleteMany"
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
