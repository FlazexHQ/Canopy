import { and, type Compiled, checkImplied, projectReadable, toProjection } from "@canopy/policy"
import {
  CanopyError,
  type ClusterTime,
  canonicalString,
  ErrorCode,
  ForbiddenError,
  InvalidQueryError,
} from "@canopy/protocol"
import { parseUpdate, type QueryLimits, validateStoredDocument } from "@canopy/query"
import { type AnyClientBulkWriteModel, BSON, type ClientSession, type Document } from "mongodb"
import { EXACT_BSON, toDriver } from "./driver.ts"
import type { Outcome, RecordModel } from "./idempotency.ts"
import { leafPaths } from "./paths.ts"
import { validateId } from "./validation.ts"
import type { ReturnedDocument, WriteLimits, WriteRequest } from "./write-path.ts"
import {
  assertMutable,
  assertWritable,
  type ReadBacks,
  type Scope,
  violation,
} from "./write-scope.ts"

/**
 * The largest document checked through `$documents` before a single insert. The check sends it once more,
 * so larger documents stay inside the 16 MiB command limit by checking after the write instead. Inserts
 * of several documents always check after the write, inside their transaction: sending a whole batch twice
 * costs more than reading it back.
 */
const PRECHECK_MAX_BYTES = 8 * 1024 * 1024

/**
 * Runs a planned write in a session and reports what it did. With `defer`, the read back of the written
 * document is queued on it and filled when it is flushed, which the caller does before the commit.
 */
export type Run = (session: ClientSession, defer?: ReadBacks) => Promise<Outcome>

/**
 * Runs a write that needs no transaction when it can, or `undefined` when it cannot: nothing has been
 * written then, and the caller runs the plan in a transaction instead.
 */
export type Direct = (session: ClientSession) => Promise<Outcome | undefined>

/** What MongoDB reported for one write of a client `bulkWrite`. */
export interface Written {
  readonly matched: number
  readonly modified: number
}

/**
 * A single document write that can run as one model of an ordered client `bulkWrite` next to others, with
 * its checks and read backs done around it.
 */
export interface Grouped {
  readonly model: AnyClientBulkWriteModel<Document>
  /** The `_id`s of the documents the write names: the model's target, or the document it inserts. */
  readonly ids: readonly unknown[]
  /**
   * The document to check before the write, through `$documents`, when the write needs `check` evaluated
   * by MongoDB: the document is stored exactly as it is sent.
   */
  readonly precheck?: {
    readonly op: "insert" | "update"
    readonly doc: Document
    readonly check: Compiled
    readonly scope: Scope
  }
  /**
   * Builds the outcome once the write ran. `checked` holds the readable documents the precheck returned.
   * A read back that needs no check is queued on `defer`, or a failed `where` precondition is looked at.
   */
  readonly finish: (
    session: ClientSession,
    written: Written,
    checked: (ReturnedDocument | null)[] | undefined,
    defer: ReadBacks,
  ) => Promise<Outcome>
}

/**
 * A planned write. `run` works inside a transaction or, when `fast` is set, on its own: a fast run is one
 * atomic single document operation whose `check` cannot fail, so there is nothing for a transaction to
 * roll back.
 */
export interface Plan {
  readonly run: Run
  readonly fast: boolean
  /**
   * A way to run the write without a transaction that may decline (see {@link Direct}), tried when the
   * plan is not `fast` and the write has no mutation ID.
   */
  readonly direct?: Direct
  /** The same write as a model of a grouped `bulkWrite`, where it is exactly equivalent to `run`. */
  readonly group?: Grouped
  /** The same write sent together with its idempotency record, where the plan supports it. */
  readonly withRecord?: CombinedRun
}

/**
 * A write that sends its idempotency record in the same command. `expected` is the outcome it has unless
 * the target is missing or unchanged; the record is first written with it.
 */
export interface CombinedRun {
  readonly expected: Outcome
  run(session: ClientSession, record: RecordModel): Promise<Outcome>
}

/** The limits a plan checks: the write path's own and those of the filters it parses. */
export interface PlanLimits {
  readonly write: WriteLimits
  readonly query: QueryLimits
}

/** Plans a write: checks it against the caller's policies and limits and returns how to run it. */
export function planWrite(
  limits: PlanLimits,
  scope: Scope,
  request: WriteRequest,
  read: boolean,
): Plan {
  switch (request.op) {
    case "insert":
      return planInsert(limits, scope, [request.doc], true, read)
    case "insertMany": {
      if (!Array.isArray(request.docs)) throw new InvalidQueryError("docs must be an array")
      return planInsert(limits, scope, request.docs, false, read)
    }
    case "update":
      return planUpdate(limits, scope, { id: request.id }, request.update, request.where, read)
    case "updateMany":
      requireBulk(request.bulk)
      return planUpdate(limits, scope, { filter: request.filter }, request.update, undefined, false)
    case "replace":
      return planReplace(limits, scope, request, read)
    case "delete":
      return planDelete(limits, scope, { id: request.id }, request.where, read)
    case "deleteMany":
      requireBulk(request.bulk)
      return planDelete(limits, scope, { filter: request.filter }, undefined, false)
    default:
      throw new InvalidQueryError("Unknown write operation")
  }
}

function planInsert(
  limits: PlanLimits,
  scope: Scope,
  docs: readonly unknown[],
  single: boolean,
  read: boolean,
): Plan {
  if (docs.length === 0) throw new InvalidQueryError("There is nothing to insert")
  if (docs.length > limits.write.maxInsertMany)
    throw new CanopyError(
      ErrorCode.BulkLimit,
      `An insert may not have more than ${limits.write.maxInsertMany} documents`,
    )
  scope.requireGrant("insert")
  const writable = scope.writable("insert")
  const prepared: Document[] = docs.map((doc) => {
    validateStoredDocument(doc, limits.query)
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
  const run: Run = async (session, defer) => {
    const checked = precheck ? await scope.precheck(prepared, check, read) : undefined
    if (single && first !== undefined)
      await scope.coll.insertOne(first, scope.writeOptions(session))
    else await scope.coll.insertMany(prepared, { ...scope.writeOptions(session), ordered: true })
    const ct = scope.fastTime(session)
    const documents = precheck
      ? checked
      : await scope.verify(session, ids, check, "insert", read, defer)
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
  const group: Grouped | undefined =
    precheck && first !== undefined
      ? {
          model: { name: "insertOne", namespace: scope.namespace, document: first },
          ids,
          precheck: { op: "insert", doc: first, check, scope },
          finish: (_session, _written, checked) => Promise.resolve(inserted(ids, checked)),
        }
      : undefined
  return {
    run,
    fast: single && (check.kind === "all" || precheck),
    ...(group === undefined ? {} : { group }),
    ...(withRecord === undefined ? {} : { withRecord }),
  }
}

function planUpdate(
  limits: PlanLimits,
  scope: Scope,
  selector: { readonly id: unknown } | { readonly filter: unknown },
  rawUpdate: unknown,
  rawWhere: unknown,
  read: boolean,
): Plan {
  scope.requireGrant("update")
  const parsed = parseUpdate(rawUpdate, {
    allowPipeline: scope.service,
    limits: limits.query,
  })
  if (parsed.kind === "replacement")
    throw new InvalidQueryError("An update needs update operators; use replace for whole documents")
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
      defer?: ReadBacks,
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
        defer,
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
    const run: Run = async (session, defer) => {
      const result = await scope.coll.updateOne(filter, update, scope.writeOptions(session))
      const ct = scope.fastTime(session)
      return withCt(await finish(session, result.matchedCount, result.modifiedCount, defer), ct)
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
    const group: Grouped = {
      model: { name: "updateOne", namespace: scope.namespace, filter, update },
      ids: [id],
      finish: (session, written, _checked, defer) =>
        finish(session, written.matched, written.modified, defer),
    }
    return { run, fast: implied, withRecord, ...(implied ? { group } : {}) }
  }
  const run: Run = async (session) => {
    const ids = await scope.findIds(session, target, limits.write.maxBulk + 1)
    if (ids.length > limits.write.maxBulk) throw bulkLimit(limits.write.maxBulk)
    if (ids.length === 0) return empty()
    const result = await scope.coll.updateMany(scope.byIds(ids, target), update, {
      session,
      maxTimeMS: limits.write.maxTimeMS,
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

function planReplace(
  limits: PlanLimits,
  scope: Scope,
  request: Extract<WriteRequest, { readonly op: "replace" }>,
  read: boolean,
): Plan {
  const upsert = request.upsert === true
  scope.requireGrant("update")
  if (upsert) scope.requireGrant("insert")
  if (upsert && request.where !== undefined)
    throw new InvalidQueryError("A replacement cannot combine where with upsert")
  validateStoredDocument(request.doc, limits.query)
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
  const stored = idFirst(replacement)
  const missing = async (session: ClientSession): Promise<Outcome> => {
    if (where.kind !== "all") await scope.assertNoConflict(session, visible)
    return empty()
  }
  /**
   * The outcome of a replacement that matched a document. `checked` holds the documents of a precheck:
   * the check has been evaluated then, and the stored document is the one that was checked.
   */
  const settle = async (
    session: ClientSession,
    written: Written,
    defer: ReadBacks | undefined,
    checked: { readonly documents: (ReturnedDocument | null)[] | undefined } | undefined,
  ): Promise<Outcome> => {
    if (written.matched === 0) return missing(session)
    const modified = written.modified > 0
    const documents =
      checked === undefined
        ? await scope.verify(
            session,
            [id],
            modified ? updateCheck : undefined,
            "update",
            read,
            defer,
          )
        : checked.documents
    return {
      matched: written.matched,
      modified: written.modified,
      deleted: 0,
      insertedIds: [],
      changedIds: modified ? [id] : [],
      ...(documents === undefined ? {} : { documents }),
    }
  }
  const run: Run = async (session, defer) => {
    const result = await scope.coll.replaceOne(scope.filter(target), replacement, {
      ...scope.writeOptions(session),
      upsert: atomicUpsert,
    })
    let ct = scope.fastTime(session)
    if (result.upsertedCount > 0) {
      const documents = await scope.verify(session, [id], undefined, "insert", read, defer)
      return withCt(upserted(id, documents), ct)
    }
    if (result.matchedCount === 0) {
      if (where.kind !== "all") await scope.assertNoConflict(session, visible)
      if (insertCheck === undefined) return withCt(empty(), ct)
      if (insertCheck.kind === "deny") throw violation(scope, "insert")
      await scope.coll.insertOne(replacement, scope.writeOptions(session))
      ct = scope.fastTime(session)
      const documents = await scope.verify(session, [id], insertCheck, "insert", read, defer)
      return withCt(upserted(id, documents), ct)
    }
    const written = { matched: result.matchedCount, modified: result.modifiedCount }
    return withCt(await settle(session, written, defer, undefined), ct)
  }
  const prechecked =
    !upsert &&
    updateCheck.kind === "filter" &&
    !readsClock(updateCheck.filter) &&
    BSON.calculateObjectSize({ stored }) <= PRECHECK_MAX_BYTES
  /**
   * A replacement is stored exactly as sent, with `_id` first, so the check of a single replacement is
   * evaluated by MongoDB on that form of it before anything is written, as for an insert, and the write
   * is then one `replaceOne` with no transaction. The write sends the replacement as the transaction
   * does, because MongoDB counts a replacement as a change by the bytes sent. The check is a filter of constants over the
   * replacement alone, so nothing it reads can change between the check and the write. A check that
   * fails is not an error yet: the target may be missing or invisible (not found), the replacement may be
   * identical to the stored document (nothing to check), or the write may fail first. The write path
   * runs the transaction then, which decides exactly as it always did.
   */
  const direct: Direct | undefined = prechecked
    ? async (session) => {
        const checked = await scope.tryPrecheck(stored, updateCheck, read)
        if (checked === undefined) return undefined
        const result = await scope.coll.replaceOne(scope.filter(target), replacement, {
          ...scope.writeOptions(session),
          upsert: false,
        })
        const ct = scope.fastTime(session)
        const written = { matched: result.matchedCount, modified: result.modifiedCount }
        return withCt(await settle(session, written, undefined, checked), ct)
      }
    : undefined
  const group: Grouped | undefined =
    !upsert && (updateCheck.kind === "all" || prechecked)
      ? {
          model: {
            name: "replaceOne",
            namespace: scope.namespace,
            filter: scope.filter(target),
            replacement,
          },
          ids: [id],
          ...(prechecked
            ? { precheck: { op: "update", doc: stored, check: updateCheck, scope } }
            : {}),
          finish: (session, written, checked, defer) =>
            settle(session, written, defer, prechecked ? { documents: checked } : undefined),
        }
      : undefined
  return {
    run,
    fast: updateCheck.kind === "all" && (insertCheck === undefined || atomicUpsert),
    ...(direct === undefined ? {} : { direct }),
    ...(group === undefined ? {} : { group }),
  }
}

function planDelete(
  limits: PlanLimits,
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
        const result = await scope.coll.deleteOne(scope.filter(target), scope.writeOptions(session))
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
    const ids = await scope.findIds(session, target, limits.write.maxBulk + 1)
    if (ids.length > limits.write.maxBulk) throw bulkLimit(limits.write.maxBulk)
    if (ids.length === 0) return empty()
    const result = await scope.coll.deleteMany(scope.byIds(ids, target), {
      session,
      maxTimeMS: limits.write.maxTimeMS,
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

/** Whether an operation may touch several documents. */
export function isBulkOp(op: WriteRequest["op"]): boolean {
  return op === "insertMany" || op === "updateMany" || op === "deleteMany"
}

/**
 * Whether a `check` filter reads anything but the document it is evaluated on: a system variable other
 * than `$$ROOT`, `$$CURRENT` and `$$REMOVE`, such as `$$NOW`, whose value differs from one command to the
 * next. Such a check cannot be moved before the write without possibly deciding differently.
 */
function readsClock(value: unknown): boolean {
  if (typeof value === "string") return /^\$\$[A-Z]/.test(value) && !DOCUMENT_VARIABLE.test(value)
  if (Array.isArray(value)) return value.some(readsClock)
  if (typeof value === "object" && value !== null) return Object.values(value).some(readsClock)
  return false
}

const DOCUMENT_VARIABLE = /^\$\$(ROOT|CURRENT|REMOVE)(\.|$)/
