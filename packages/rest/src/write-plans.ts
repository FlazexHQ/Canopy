import { and, checkImplied, projectReadable, toProjection } from "@canopy/policy"
import {
  CanopyError,
  type ClusterTime,
  canonicalString,
  ErrorCode,
  ForbiddenError,
  InvalidQueryError,
} from "@canopy/protocol"
import { parseUpdate, type QueryLimits, validateStoredDocument } from "@canopy/query"
import { BSON, type ClientSession, type Document } from "mongodb"
import { EXACT_BSON, toDriver } from "./driver.ts"
import type { Outcome, RecordModel } from "./idempotency.ts"
import { leafPaths } from "./paths.ts"
import { validateId } from "./validation.ts"
import type { ReturnedDocument, WriteLimits, WriteRequest } from "./write-path.ts"
import { assertMutable, assertWritable, type Scope, violation } from "./write-scope.ts"

/**
 * The largest document checked through `$documents` before a single insert. The check sends it once more,
 * so larger documents stay inside the 16 MiB command limit by checking after the write instead. Inserts
 * of several documents always check after the write, inside their transaction: sending a whole batch twice
 * costs more than reading it back.
 */
const PRECHECK_MAX_BYTES = 8 * 1024 * 1024

/** Runs a planned write in a session and reports what it did. */
export type Run = (session: ClientSession) => Promise<Outcome>

/**
 * A planned write. `run` works inside a transaction or, when `fast` is set, on its own: a fast run is one
 * atomic single document operation whose `check` cannot fail, so there is nothing for a transaction to
 * roll back.
 */
export interface Plan {
  readonly run: Run
  readonly fast: boolean
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
