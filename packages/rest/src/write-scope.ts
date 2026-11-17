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
