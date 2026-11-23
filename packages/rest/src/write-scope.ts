import {
  type Compiled,
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
  toCt,
} from "@canopy/protocol"
import { type ParsedFilter, parseFilter, type QueryLimits } from "@canopy/query"
import {
  type AnyClientBulkWriteModel,
  type ClientBulkWriteResult,
  type ClientSession,
  type Collection,
  type Db,
  type Document,
  MongoClientBulkWriteError,
  MongoError,
  MongoServerError,
} from "mongodb"
import { EXACT_BSON, toDriver } from "./driver.ts"
import { Replay } from "./idempotency.ts"
import { validateId } from "./validation.ts"
import { DUPLICATE_KEY, MAJORITY, type ReturnedDocument } from "./write-path.ts"

/** Everything a planned write needs about its collection and caller. */
export class Scope {
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
   * With `defer`, the read back of a single document that needs no check is queued instead, and the
   * returned array is filled when {@link ReadBacks.flush} runs.
   */
  async verify(
    session: ClientSession,
    ids: readonly unknown[],
    check: Compiled | undefined,
    op: "insert" | "update",
    read: boolean,
    defer?: ReadBacks,
  ): Promise<(ReturnedDocument | null)[] | undefined> {
    if (check?.kind === "deny") throw violation(this, op)
    const [only] = ids
    if (ids.length === 1 && (check === undefined || check.kind === "all")) {
      if (!read) return undefined
      if (defer === undefined) return [await this.readOne(session, only)]
      const slot: (ReturnedDocument | null)[] = [null]
      defer.add(this, only, slot)
      return slot
    }
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
    const checked = await this.checkBefore(docs, check, read)
    if (checked.failed.size > 0) throw violation(this, "insert")
    return this.readableOf(docs, checked.found, read)
  }

  /**
   * Evaluates `check` and the read back on a document that a write is about to store as it is, like
   * {@link precheck}, but reports a failing check as `undefined` instead of throwing: whether the failing
   * check is an error or only a missing target depends on the write, which the caller then decides.
   */
  async tryPrecheck(
    doc: Document,
    check: Compiled,
    read: boolean,
  ): Promise<{ readonly documents: (ReturnedDocument | null)[] | undefined } | undefined> {
    if (check.kind === "deny") return undefined
    const checked = await this.checkBefore([doc], check, read)
    if (checked.failed.size > 0) return undefined
    return { documents: this.readableOf([doc], checked.found, read) }
  }

  /**
   * {@link tryPrecheck} for several documents of one operation in one aggregation: the canonical `_id`s of
   * the documents that fail the check, and the readable form of each document (`null` when unreadable;
   * absent when `read` is not set). The documents must have distinct `_id`s.
   */
  async precheckMany(
    docs: readonly Document[],
    check: Compiled,
    read: boolean,
  ): Promise<{
    readonly failed: ReadonlySet<string>
    readonly documents: ReadonlyMap<string, ReturnedDocument | null> | undefined
  }> {
    if (check.kind === "deny")
      return {
        failed: new Set(docs.map((doc) => canonicalString(doc["_id"]))),
        documents: undefined,
      }
    const checked = await this.checkBefore(docs, check, read)
    if (!read) return { failed: checked.failed, documents: undefined }
    const access = this.readable()
    return {
      failed: checked.failed,
      documents: new Map(
        docs.map((doc) => {
          const key = canonicalString(doc["_id"])
          const found = checked.found.get(key)
          return [key, found === undefined ? null : projectReadable(access, found)]
        }),
      ),
    }
  }

  /**
   * Runs the aggregation of {@link precheck}: the failing `_id`s and the readable documents. It runs on the
   * target collection, whose own documents an empty `_id` match leaves out at no cost, and brings the
   * candidates in through `$unionWith` and `$documents`, so MongoDB compares their strings with the
   * collection's default collation, as it does for the stored documents. A `$documents` aggregation on the
   * database would have no collation and could pass a document that fails its check once stored.
   */
  private async checkBefore(
    docs: readonly Document[],
    check: Compiled,
    read: boolean,
  ): Promise<{ failed: Set<string>; found: Map<string, Document> }> {
    const ids = docs.map((doc) => doc["_id"])
    const facet = this.facets(ids, check, read, "ids")
    if (Object.keys(facet).length === 0) return { failed: new Set(), found: new Map() }
    const [out] = await this.coll
      .aggregate(
        [
          { $match: { _id: { $in: [] } } },
          { $unionWith: { pipeline: [{ $documents: { $literal: [...docs] } }] } },
          { $facet: facet },
        ],
        { maxTimeMS: this.maxTimeMS, ...EXACT_BSON },
      )
      .toArray()
    const bad = (out?.["bad"] as Document[] | undefined) ?? []
    const found = (out?.["docs"] as Document[] | undefined) ?? []
    return {
      failed: new Set(bad.map((doc) => canonicalString(doc["_id"]))),
      found: new Map(found.map((doc) => [canonicalString(doc["_id"]), doc])),
    }
  }

  /** The readable form of each document of `docs` among `found`, `null` where it is not there. */
  private readableOf(
    docs: readonly Document[],
    found: ReadonlyMap<string, Document>,
    read: boolean,
  ): (ReturnedDocument | null)[] | undefined {
    if (!read) return undefined
    const access = this.readable()
    return docs.map((doc) => {
      const stored = found.get(canonicalString(doc["_id"]))
      return stored === undefined ? null : projectReadable(access, stored)
    })
  }

  /**
   * Reads several written documents back through `USING(read)` and the read field rules with one `find`,
   * and fills the slot of each: `null` for a document the `find` did not return. A document is matched to
   * its slot by the bytes of its `_id`. When the `find` returns a document that matches no slot (the
   * stored `_id` is a number of another BSON type than the one written), the slots without a match are
   * read one at a time instead, so a readable document is never reported as unreadable.
   */
  async readMany(session: ClientSession, items: readonly ReadBack[]): Promise<void> {
    const ids = items.map((item) => item.id)
    const readFilter = this.engine.effectiveRead(this.name, { _id: { $in: ids } }, this.ctx)
    if (readFilter.kind === "deny") return
    const access = this.readable()
    const projection = toProjection(access)
    const found = await this.coll
      .find(this.filter(readFilter), {
        ...this.readSession(session),
        ...(projection === undefined ? {} : { projection }),
        batchSize: Math.max(2, ids.length + 1),
        maxTimeMS: this.maxTimeMS,
        ...EXACT_BSON,
      })
      .toArray()
    const byId = new Map(found.map((doc) => [canonicalString(doc["_id"]), doc]))
    const missed: ReadBack[] = []
    for (const item of items) {
      const doc = byId.get(canonicalString(item.id))
      if (doc === undefined) missed.push(item)
      else item.slot[0] = projectReadable(access, doc)
    }
    if (found.length > items.length - missed.length)
      for (const item of missed) item.slot[0] = await this.readOne(session, item.id)
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

  /**
   * The `$facet` of a check and a read back over the documents with these ids. The failing documents are
   * counted, or with `failing: "ids"` listed by `_id`.
   */
  private facets(
    ids: readonly unknown[],
    check: Compiled | undefined,
    read: boolean,
    failing: "count" | "ids" = "count",
  ): Document {
    const facet: Document = {}
    if (check?.kind === "filter" && ids.length > 0)
      facet["bad"] = [
        { $match: { $nor: [toDriver(check.filter)] } },
        failing === "count" ? { $count: "n" } : { $project: { _id: 1 } },
      ]
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

/** A read back that waits for the end of a transaction: the id and the array slot to fill. */
interface ReadBack {
  readonly id: unknown
  readonly slot: (ReturnedDocument | null)[]
}

/**
 * The read backs of an atomic batch, collected while its operations run and read with one command per
 * collection before the commit, instead of one command per written document. Each document is read through
 * the same `USING(read)` and field rules as a read back right after its own write, so a queued read back
 * is only valid for a document no later operation of the batch touches.
 */
export class ReadBacks {
  private readonly groups = new Map<string, { scope: Scope; items: ReadBack[] }>()

  /** How many read backs are queued. */
  get size(): number {
    let total = 0
    for (const { items } of this.groups.values()) total += items.length
    return total
  }

  add(scope: Scope, id: unknown, slot: (ReturnedDocument | null)[]): void {
    const group = this.groups.get(scope.name)
    if (group === undefined) this.groups.set(scope.name, { scope, items: [{ id, slot }] })
    else group.items.push({ id, slot })
  }

  /** Reads everything queued, in the transaction of `session`, and fills the slots. */
  async flush(session: ClientSession): Promise<void> {
    for (const { scope, items } of this.groups.values()) await scope.readMany(session, items)
    this.groups.clear()
  }
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

/** The refusal of a write whose result fails a `check` clause, explained in development. */
export function violation(scope: Scope, op: "insert" | "update"): PolicyViolationError {
  return new PolicyViolationError(
    `The resulting document does not satisfy the ${op} check for collection '${scope.name}'`,
    explained(scope, op, "check"),
  )
}

/** Refuses a write that sets fields the caller may not write. */
export function assertWritable(scope: Scope, access: FieldAccess, paths: readonly string[]): void {
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

/** Refuses a write that changes an immutable field. */
export function assertMutable(scope: Scope, written: readonly string[]): void {
  const frozen = immutableViolations(written, scope.engine.immutable(scope.name))
  if (frozen.length > 0)
    throw new PolicyViolationError(
      `Immutable fields cannot be changed: ${frozen.join(", ")}`,
      scope.explain ? { details: { explain: { rule: "immutable", fields: frozen } } } : undefined,
    )
}
