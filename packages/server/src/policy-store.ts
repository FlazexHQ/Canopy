import {
  CONTEXT_DOCUMENT_ID,
  type CollectionPolicies,
  type ContextDefinitions,
  contextsFromStored,
  createPolicySet,
  fromStored,
  type LintEnvironment,
  type LintFinding,
  lintPolicies,
  OPERATIONS,
  type PolicySet,
  readStored,
  type StoredCollectionPolicies,
  toStored,
} from "@canopy/policy"
import {
  CanopyError,
  ConflictError,
  canonicalString,
  ErrorCode,
  ForbiddenError,
  isDocument,
  NotFoundError,
  sha256Hex,
  stringify,
  ValidationError,
} from "@canopy/protocol"
import type { Collection, Db, MongoClient } from "mongodb"
import { ObjectId } from "mongodb"
import type { Actor, AuditLog, RequestOrigin } from "./audit.ts"
import {
  array,
  boolean,
  document,
  type Infer,
  object,
  oneOf,
  optional,
  string,
  unknownValue,
} from "./schema.ts"

/** The JSON form of a collection's policies, as the admin API and the CLI send it. */
export const policyInput = object({
  exposed: boolean(),
  realtime: boolean(),
  policies: array(
    object({
      name: string({ min: 1, max: 200 }),
      kind: oneOf("permissive", "restrictive"),
      ops: array(oneOf(...OPERATIONS), { max: OPERATIONS.length }),
      roles: array(string({ min: 1, max: 200 }), { max: 64 }),
      /** A canonical EJSON string, as stored, or the EJSON value itself. */
      using: optional(unknownValue()),
      check: optional(unknownValue()),
    }),
    { max: 64 },
  ),
  fields: optional(document()),
  immutable: optional(array(string({ min: 1, max: 500 }), { max: 256 })),
})

/** The parsed JSON form of a collection's policies. */
export type PolicyInput = Infer<typeof policyInput>

const COLLECTION_NAME = /^[A-Za-z][\w.-]{0,119}$/

/** Checks a collection name from a URL or a body. Names starting with `_` or `system.` are reserved. */
export function collectionName(value: string): string {
  if (!COLLECTION_NAME.test(value) || value.startsWith("system."))
    throw new ValidationError(`'${value}' is not a valid collection name`)
  return value
}

function clauseText(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === "string") return value
  if (isDocument(value)) return stringify(value)
  throw new ValidationError(`${path} must be an EJSON string or an object`, { details: { path } })
}

/** Converts the JSON form into a definition. Semantic checks happen when the definition is checked. */
export function definitionFromInput(collection: string, input: unknown): CollectionPolicies {
  const parsed = policyInput.parse(input, "definition")
  try {
    return fromStored({
      _id: collection,
      exposed: parsed.exposed,
      realtime: parsed.realtime,
      policies: parsed.policies.map((policy, index) => ({
        name: policy.name,
        kind: policy.kind,
        ops: policy.ops,
        roles: policy.roles,
        using: clauseText(policy.using, `definition.policies[${index}].using`),
        check: clauseText(policy.check, `definition.policies[${index}].check`),
      })),
      ...(parsed.fields === undefined ? {} : { fields: parsed.fields }),
      ...(parsed.immutable === undefined ? {} : { immutable: parsed.immutable }),
    })
  } catch (error: unknown) {
    if (error instanceof CanopyError) throw error
    throw new ValidationError(error instanceof Error ? error.message : "Invalid policies", {
      cause: error,
    })
  }
}

/** One published version in `canopy.policy_history`. */
export interface PolicyHistoryEntry {
  _id: ObjectId
  collection: string
  version: number
  hash: string
  document: StoredPolicyDocument
  publishedAt: Date
  publishedBy: string
  comment?: string
  commitSha?: string
  /** The version this one restored, for rollbacks. */
  rollbackOf?: number
}

/** The stored context lookup declarations, `_id` being `_context`. */
export interface StoredContextLookups {
  readonly _id: typeof CONTEXT_DOCUMENT_ID
  readonly version: number
  readonly lookups: ContextDefinitions
  readonly hash: string
  readonly updatedAt?: Date
  readonly updatedBy?: string
}

/** A document of `canopy.policies`: the policies of one collection, or the context lookups. */
export type StoredPolicyDocument = StoredCollectionPolicies | StoredContextLookups

/**
 * Checks the structure of the `_context` document read from `canopy.policies`. Throws a `TypeError` on a
 * malformed document; the lookups themselves are validated when they are compiled.
 */
function readStoredContexts(value: unknown): StoredContextLookups {
  if (!isDocument(value) || value["_id"] !== CONTEXT_DOCUMENT_ID)
    throw new TypeError(`The context lookups document needs the _id '${CONTEXT_DOCUMENT_ID}'`)
  const { version, hash, updatedAt, updatedBy } = value
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0)
    throw new TypeError("The stored context lookups need a version")
  if (typeof hash !== "string") throw new TypeError("The stored context lookups need a hash")
  if (updatedAt !== undefined && updatedAt !== null && !(updatedAt instanceof Date))
    throw new TypeError("updatedAt of the context lookups must be a date")
  if (updatedBy !== undefined && updatedBy !== null && typeof updatedBy !== "string")
    throw new TypeError("updatedBy of the context lookups must be a string")
  return {
    _id: CONTEXT_DOCUMENT_ID,
    version,
    lookups: contextsFromStored(value["lookups"]),
    hash,
    ...(updatedAt instanceof Date ? { updatedAt } : {}),
    ...(typeof updatedBy === "string" ? { updatedBy } : {}),
  }
}

/** Checks the structure of any document of `canopy.policies`. */
function readPolicyDocument(value: unknown): StoredPolicyDocument {
  return isDocument(value) && value["_id"] === CONTEXT_DOCUMENT_ID
    ? readStoredContexts(value)
    : readStored(value)
}

/** The body of a context lookup publish. */
export const contextsInput = object({ lookups: document() })

/** A publish of the context lookups. */
export interface PublishContextsInput extends Omit<PublishInput, "definition"> {
  readonly lookups: ContextDefinitions
}

/** The result of a context lookup publish. */
export interface PublishContextsResult {
  readonly stored: StoredContextLookups
  readonly findings: readonly LintFinding[]
}

/** The hash of context lookup declarations. */
export function hashContexts(lookups: ContextDefinitions): string {
  return `sha256:${sha256Hex(canonicalString(lookups))}`
}

/** The outcome of checking a definition against the policies in force. */
export interface PolicyCheck {
  /** The full policy set the definition would produce. */
  readonly set: PolicySet
  readonly findings: readonly LintFinding[]
}

/** A publish request. */
export interface PublishInput {
  readonly definition: CollectionPolicies
  /** The version the change was made against; `0` for a collection without policies. */
  readonly expectedVersion: number
  readonly actor: Actor
  readonly comment?: string
  readonly commitSha?: string
  readonly origin?: RequestOrigin
}

/** The result of a publish. */
export interface PublishResult {
  readonly stored: StoredCollectionPolicies
  readonly findings: readonly LintFinding[]
}

/** Options of {@link PolicyStore}. */
export interface PolicyStoreOptions {
  readonly client: MongoClient
  readonly metaDatabase: string
  readonly audit: AuditLog
  /** False when policies come from a directory, which makes them read only at runtime. */
  readonly writable: boolean
  /** Extra knowledge for lint rules, such as the indexes of the collection. */
  readonly lintEnvironment?: (collection: string) => Promise<LintEnvironment>
}

function actorName(actor: Actor): string {
  return actor.type === "admin" ? `admin:${actor.email ?? actor.id}` : `system:${actor.id}`
}

/**
 * The policy lifecycle in the meta database: every publish is validated and linted against the whole set,
 * carries the version it was made against (a concurrent change makes it fail with `409`), is recorded in
 * `canopy.policy_history` and audited in the same transaction. Nodes pick it up through the change stream on
 * `canopy.policies`. A rollback republishes an earlier version as a new one.
 */
export class PolicyStore {
  private readonly client: MongoClient
  private readonly meta: Db
  private readonly audit: AuditLog
  private readonly writable: boolean
  private readonly lintEnvironment: ((collection: string) => Promise<LintEnvironment>) | undefined
  private readonly documents: Collection<StoredPolicyDocument>
  readonly history: Collection<PolicyHistoryEntry>

  constructor(options: PolicyStoreOptions) {
    this.client = options.client
    this.meta = options.client.db(options.metaDatabase)
    this.audit = options.audit
    this.writable = options.writable
    this.lintEnvironment = options.lintEnvironment
    this.documents = this.meta.collection<StoredPolicyDocument>("policies")
    this.history = this.meta.collection<PolicyHistoryEntry>("policy_history")
  }

  /** Whether publishing is possible: policies come from the meta database, not a directory. */
  get isWritable(): boolean {
    return this.writable
  }

  /** The stored policies of a collection. */
  async get(collection: string): Promise<StoredCollectionPolicies | undefined> {
    if (collection === CONTEXT_DOCUMENT_ID) return undefined
    const doc = await this.documents.findOne({ _id: collection })
    return doc === null ? undefined : readStored(doc)
  }

  /** Every stored definition and the context lookups. */
  async all(): Promise<{
    readonly definitions: Map<string, CollectionPolicies>
    readonly stored: Map<string, StoredCollectionPolicies>
    readonly contexts: ContextDefinitions
  }> {
    const definitions = new Map<string, CollectionPolicies>()
    const stored = new Map<string, StoredCollectionPolicies>()
    let contexts: ContextDefinitions = {}
    for (const raw of await this.documents.find({}).toArray()) {
      const doc = readPolicyDocument(raw)
      if ("lookups" in doc) {
        contexts = doc.lookups
        continue
      }
      stored.set(doc._id, doc)
      definitions.set(doc._id, fromStored(doc))
    }
    return { definitions, stored, contexts }
  }

  /**
   * Validates a definition together with every other stored collection and lints it. Throws
   * `CANOPY_VALIDATION_FAILED` when the resulting set is invalid.
   */
  async check(definition: CollectionPolicies): Promise<PolicyCheck> {
    const { definitions, contexts } = await this.all()
    definitions.set(definition.collection, definition)
    let set: PolicySet
    try {
      set = createPolicySet([...definitions.values()], contexts)
    } catch (error: unknown) {
      throw new ValidationError(error instanceof Error ? error.message : "Invalid policies", {
        details: { collection: definition.collection },
        cause: error,
      })
    }
    const environment =
      this.lintEnvironment === undefined ? {} : await this.lintEnvironment(definition.collection)
    return { set, findings: lintPolicies([definition], contexts, environment) }
  }

  private ensureWritable(): void {
    if (!this.writable)
      throw new ForbiddenError(
        "Policies are loaded from a directory and are read only at runtime; change the files instead",
      )
  }

  /** Publishes a new version. Lint errors refuse the publish; warnings are returned. */
  async publish(
    input: PublishInput,
    action = "policy.publish",
    rollbackOf?: number,
  ): Promise<PublishResult> {
    this.ensureWritable()
    const collection = collectionName(input.definition.collection)
    const { findings } = await this.check(input.definition)
    refuseErrors(findings)
    const stored = await this.commit(
      collection,
      (version, updatedAt, updatedBy) =>
        toStored(input.definition, { version, updatedAt, updatedBy }),
      input,
      action,
      rollbackOf,
    )
    return { stored, findings }
  }

  /**
   * Validates context lookup declarations against every stored collection (a policy may not use a lookup
   * that is not declared) and lints them. Throws `CANOPY_VALIDATION_FAILED` when they are invalid.
   */
  async checkContexts(lookups: ContextDefinitions): Promise<PolicyCheck> {
    const { definitions } = await this.all()
    let set: PolicySet
    try {
      set = createPolicySet([...definitions.values()], lookups)
    } catch (error: unknown) {
      throw new ValidationError(
        error instanceof Error ? error.message : "Invalid context lookups",
        {
          details: { collection: CONTEXT_DOCUMENT_ID },
          cause: error,
        },
      )
    }
    return {
      set,
      findings: lintPolicies([], lookups).filter((finding) => finding.rule.startsWith("ctx-")),
    }
  }

  /** The stored context lookups. */
  async getContexts(): Promise<StoredContextLookups | undefined> {
    const doc = await this.documents.findOne({ _id: CONTEXT_DOCUMENT_ID })
    return doc === null ? undefined : readStoredContexts(doc)
  }

  /** Publishes the context lookups as the next version of `_context`, with history and audit. */
  async publishContexts(
    input: PublishContextsInput,
    action = "context.publish",
    rollbackOf?: number,
  ): Promise<PublishContextsResult> {
    this.ensureWritable()
    const { findings } = await this.checkContexts(input.lookups)
    refuseErrors(findings)
    const stored = await this.commit(
      CONTEXT_DOCUMENT_ID,
      (version, updatedAt, updatedBy): StoredContextLookups => ({
        _id: CONTEXT_DOCUMENT_ID,
        version,
        lookups: input.lookups,
        hash: hashContexts(input.lookups),
        updatedAt,
        updatedBy,
      }),
      input,
      action,
      rollbackOf,
    )
    return { stored, findings }
  }

  private async commit<T extends StoredPolicyDocument>(
    id: string,
    build: (version: number, updatedAt: Date, updatedBy: string) => T,
    input: Omit<PublishInput, "definition">,
    action: string,
    rollbackOf: number | undefined,
  ): Promise<T> {
    const by = actorName(input.actor)
    const label = id === CONTEXT_DOCUMENT_ID ? "The context lookups" : `The policies of '${id}'`
    const session = this.client.startSession()
    try {
      return await session.withTransaction(async () => {
        const found = await this.documents.findOne({ _id: id }, { session })
        const current = found === null ? null : readPolicyDocument(found)
        const version = current?.version ?? 0
        if (version !== input.expectedVersion)
          throw new ConflictError(
            `${label} are at version ${version}, not ${input.expectedVersion}; reload, compare and publish again`,
            {
              details: {
                collection: id,
                currentVersion: version,
                expectedVersion: input.expectedVersion,
              },
            },
          )
        const now = new Date()
        const next = build(version + 1, now, by)
        if (current !== null) {
          await this.history.updateOne(
            { collection: id, version: current.version },
            {
              $setOnInsert: {
                _id: new ObjectId(),
                hash: current.hash,
                document: current,
                publishedAt: current.updatedAt ?? now,
                publishedBy: current.updatedBy ?? "unknown",
              },
            },
            { upsert: true, session },
          )
        }
        await this.history.insertOne(
          {
            _id: new ObjectId(),
            collection: id,
            version: next.version,
            hash: next.hash,
            document: next,
            publishedAt: now,
            publishedBy: by,
            ...(input.comment === undefined ? {} : { comment: input.comment }),
            ...(input.commitSha === undefined ? {} : { commitSha: input.commitSha }),
            ...(rollbackOf === undefined ? {} : { rollbackOf }),
          },
          { session },
        )
        await this.documents.replaceOne({ _id: id }, next, { upsert: true, session })
        await this.audit.record(
          {
            action,
            actor: input.actor,
            target: { collection: id, version: next.version },
            diff: { before: current, after: next },
            ...(input.comment === undefined ? {} : { comment: input.comment }),
            ...(input.commitSha === undefined ? {} : { commitSha: input.commitSha }),
            ...(input.origin === undefined ? {} : { origin: input.origin }),
            ...(rollbackOf === undefined ? {} : { details: { rollbackOf } }),
          },
          session,
        )
        return next
      })
    } catch (error: unknown) {
      if (error instanceof CanopyError) throw error
      throw new CanopyError(ErrorCode.Unavailable, "The publish could not be committed; retry", {
        cause: error,
      })
    } finally {
      await session.endSession()
    }
  }

  /** The published versions of a collection, newest first. */
  async versions(
    collection: string,
    options: { readonly limit?: number; readonly before?: number } = {},
  ): Promise<PolicyHistoryEntry[]> {
    return this.history
      .find({
        collection,
        ...(options.before === undefined ? {} : { version: { $lt: options.before } }),
      })
      .sort({ version: -1 })
      .limit(Math.min(Math.max(options.limit ?? 50, 1), 500))
      .toArray()
  }

  /** Republishes an earlier version as the next one. */
  async rollback(
    input: Omit<PublishInput, "definition"> & {
      readonly collection: string
      readonly version: number
    },
  ): Promise<PublishResult> {
    const entry = await this.history.findOne({
      collection: input.collection,
      version: input.version,
    })
    if (entry === null)
      throw new NotFoundError(
        `'${input.collection}' has no version ${input.version} in its history`,
      )
    if (input.collection === CONTEXT_DOCUMENT_ID)
      throw new ValidationError("Roll the context lookups back with rollbackContexts()")
    if ("lookups" in entry.document)
      throw new ValidationError(
        `Version ${input.version} of '${input.collection}' holds context lookups`,
      )
    return this.publish(
      { ...input, definition: fromStored(entry.document) },
      "policy.rollback",
      input.version,
    )
  }

  /** Republishes an earlier version of the context lookups as the next one. */
  async rollbackContexts(
    input: Omit<PublishInput, "definition"> & { readonly version: number },
  ): Promise<PublishContextsResult> {
    const entry = await this.history.findOne({
      collection: CONTEXT_DOCUMENT_ID,
      version: input.version,
    })
    if (entry === null)
      throw new NotFoundError(
        `The context lookups have no version ${input.version} in their history`,
      )
    const lookups =
      "lookups" in entry.document ? contextsFromStored(entry.document.lookups) : undefined
    if (lookups === undefined)
      throw new ValidationError(`Version ${input.version} of the context lookups holds no lookups`)
    return this.publishContexts({ ...input, lookups }, "context.rollback", input.version)
  }
}

function refuseErrors(findings: readonly LintFinding[]): void {
  const errors = findings.filter((finding) => finding.severity === "error")
  if (errors.length > 0)
    throw new ValidationError(`The policies have ${errors.length} lint error(s)`, {
      details: { findings: errors },
    })
}
