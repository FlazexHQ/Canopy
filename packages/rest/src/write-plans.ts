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

const proto = (): boolean => (globalThis as { __proto?: boolean }).__proto === true

/** PROTOTYPE: whether every conjunct of `c` holds for the literal values of `doc` (scalars, $eq, $in). */
function literallyHolds(c: Compiled, doc: Record<string, unknown>): boolean {
  if (c.kind === "all") return true
  if (c.kind === "deny") return false
  const parts: [string, unknown][] = []
  const walk = (f: Record<string, unknown>): boolean => {
    for (const [k, v] of Object.entries(f)) {
      if (k === "$and" && Array.isArray(v)) {
        for (const x of v)
          if (typeof x !== "object" || x === null || !walk(x as Record<string, unknown>))
            return false
      } else if (k.startsWith("$") || k.includes(".")) return false
      else parts.push([k, v])
    }
    return true
  }
  if (!walk(c.filter)) return false
  const scalar = (x: unknown): boolean => typeof x === "string" || typeof x === "boolean"
  for (const [k, cond] of parts) {
    const have = doc[k]
    if (!scalar(have)) return false
    if (scalar(cond)) {
      if (cond !== have) return false
      continue
    }
    if (typeof cond !== "object" || cond === null) return false
    const ops = Object.entries(cond as Record<string, unknown>)
    if (ops.length !== 1) return false
    const [op, arg] = ops[0] ?? []
    if (op === "$eq" && scalar(arg)) {
      if (arg !== have) return false
      continue
    }
    if (op === "$in" && Array.isArray(arg) && arg.every(scalar)) {
      if (!arg.includes(have)) return false
      continue
    }
    return false
  }
  return true
}

/** PROTOTYPE: check implied for an update whose written check fields are `$set` to literals that satisfy it. */
function literalUpdateImplied(
  check: Compiled,
  target: Compiled,
  update: unknown,
  written: readonly string[],
): boolean {
  if (check.kind === "all") return true
  if (check.kind === "deny" || target.kind !== "filter") return false
  if (typeof update !== "object" || update === null) return false
  const ops = Object.keys(update)
  if (ops.some((op) => op !== "$set" && op !== "$inc")) return false
  const set = ((update as Record<string, unknown>)["$set"] ?? {}) as Record<string, unknown>
  const flat = (f: Record<string, unknown>): Record<string, unknown>[] =>
    Object.entries(f).flatMap(([k, v]) =>
      k === "$and" && Array.isArray(v)
        ? v.flatMap((x) => flat(x as Record<string, unknown>))
        : [{ [k]: v }],
    )
  const required = new Set(flat(target.filter).map((x) => canonicalString(x)))
  const writtenTop = new Set(written.map((w) => w.split(".")[0] ?? w))
  const proves = (filter: Record<string, unknown>): boolean => {
    for (const part of flat(filter)) {
      const [field] = Object.keys(part)
      if (field === undefined) return false
      if (field === "$or") {
        const branches = part["$or"]
        if (
          !Array.isArray(branches) ||
          !branches.some(
            (b) => typeof b === "object" && b !== null && proves(b as Record<string, unknown>),
          )
        ) {
          if (!required.has(canonicalString(part)) || !untouched(part)) return false
        }
        continue
      }
      if (field.startsWith("$") || field.includes(".")) return false
      if (!writtenTop.has(field)) {
        if (!required.has(canonicalString(part))) return false
        continue
      }
      if (!(field in set) || written.some((w) => w !== field && w.startsWith(`${field}.`)))
        return false
      if (!literallyHolds({ kind: "filter", filter: part }, set)) return false
    }
    return true
  }
  const untouched = (part: Record<string, unknown>): boolean =>
    ![...writtenTop].some((w) => JSON.stringify(part).includes(`"${w}"`))
  return proves(check.filter)
}

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
  const usingRead = scope.engine.using(scope.name, "read", scope.ctx)
  const literal =
    single && first !== undefined && literallyHolds(check, docs[0] as Record<string, unknown>)
  const run: Run = async (session) => {
    if (proto() && literal && first !== undefined) {
      await scope.coll.insertOne(first, scope.writeOptions(session))
      const ct = scope.fastTime(session)
      if (!read) return withCt(inserted(ids, undefined), ct)
      if (literallyHolds(usingRead, docs[0] as Record<string, unknown>)) {
        const stored = BSON.deserialize(BSON.serialize(first), EXACT_BSON)
        return withCt(inserted(ids, [projectReadable(scope.readable(), stored)] as never), ct)
      }
      return withCt(inserted(ids, await scope.verify(session, ids, undefined, "insert", read)), ct)
    }
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
    const implied =
      check.kind === "all" ||
      checkImplied(check, target, parsed.writtenPaths) ||
      (proto() && literalUpdateImplied(check, target, rawUpdate, parsed.writtenPaths))
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
    const visibleAfter =
      read &&
      implied &&
      checkImplied(scope.engine.using(scope.name, "read", scope.ctx), target, parsed.writtenPaths)
    const run: Run = async (session) => {
      if (proto() && visibleAfter && !session.inTransaction()) {
        const projection = toProjection(scope.readable())
        const doc = await scope.coll.findOneAndUpdate(filter, update, {
          ...scope.writeOptions(session),
          returnDocument: "after",
          ...(projection === undefined ? {} : { projection }),
          ...EXACT_BSON,
        })
        const ct = scope.fastTime(session)
        if (doc === null) return withCt(await finish(session, 0, 0), ct)
        return withCt(
          {
            matched: 1,
            modified: 1,
            deleted: 0,
            insertedIds: [],
            changedIds: [id],
            documents: [projectReadable(scope.readable(), doc)] as never,
          },
          ct,
        )
      }
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
  const stored = { _id: request.id, ...doc }
  const literal = proto() && !upsert && literallyHolds(updateCheck, stored)
  const usingRead = scope.engine.using(scope.name, "read", scope.ctx)
  if (literal) {
    const fastRun: Run = async (session) => {
      const result = await scope.coll.replaceOne(
        scope.filter(target),
        replacement,
        scope.writeOptions(session),
      )
      const ct = scope.fastTime(session)
      if (result.matchedCount === 0) {
        if (where.kind !== "all") await scope.assertNoConflict(session, visible)
        return withCt(empty(), ct)
      }
      const modified = result.modifiedCount > 0
      let documents: (ReturnedDocument | null)[] | undefined
      if (read)
        documents = literallyHolds(usingRead, stored)
          ? [
              projectReadable(
                scope.readable(),
                BSON.deserialize(BSON.serialize(toDriver(stored)), EXACT_BSON),
              ) as ReturnedDocument,
            ]
          : await scope.verify(session, [id], undefined, "update", read)
      return withCt(
        {
          matched: 1,
          modified: result.modifiedCount,
          deleted: 0,
          insertedIds: [],
          changedIds: modified ? [id] : [],
          ...(documents === undefined ? {} : { documents }),
        },
        ct,
      )
    }
    return { run: fastRun, fast: true }
  }
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
