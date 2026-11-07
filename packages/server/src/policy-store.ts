import {
  CONTEXT_DOCUMENT_ID,
  type CollectionPolicies,
  type ContextDefinitions,
  createPolicySet,
  fromStored,
  type LintEnvironment,
  type LintFinding,
  lintPolicies,
  OPERATIONS,
  type PolicySet,
  type StoredCollectionPolicies,
  toStored,
} from "@canopy/policy"
import {
  CanopyError,
  ConflictError,
  ErrorCode,
  ForbiddenError,
  isDocument,
  NotFoundError,
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
  if (isDocument(value)) return JSON.stringify(value)
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
  document: StoredCollectionPolicies
  publishedAt: Date
  publishedBy: string
  comment?: string
  commitSha?: string
  /** The version this one restored, for rollbacks. */
  rollbackOf?: number
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
  readonly policies: Collection<StoredCollectionPolicies>
  readonly history: Collection<PolicyHistoryEntry>

  constructor(options: PolicyStoreOptions) {
    this.client = options.client
    this.meta = options.client.db(options.metaDatabase)
    this.audit = options.audit
    this.writable = options.writable
    this.lintEnvironment = options.lintEnvironment
    this.policies = this.meta.collection<StoredCollectionPolicies>("policies")
    this.history = this.meta.collection<PolicyHistoryEntry>("policy_history")
  }

  /** Whether publishing is possible: policies come from the meta database, not a directory. */
  get isWritable(): boolean {
    return this.writable
  }

  /** The stored policies of a collection. */
  async get(collection: string): Promise<StoredCollectionPolicies | undefined> {
    return (await this.policies.findOne({ _id: collection })) ?? undefined
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
    for (const doc of await this.policies.find({}).toArray()) {
      if (doc._id === CONTEXT_DOCUMENT_ID) {
        const lookups = (doc as unknown as Record<string, unknown>)["lookups"]
        contexts = (isDocument(lookups) ? lookups : {}) as ContextDefinitions
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

  /** Publishes a new version. Lint errors refuse the publish; warnings are returned. */
  async publish(
    input: PublishInput,
    action = "policy.publish",
    rollbackOf?: number,
  ): Promise<PublishResult> {
    if (!this.writable)
      throw new ForbiddenError(
        "Policies are loaded from a directory and are read only at runtime; change the files instead",
      )
    const collection = collectionName(input.definition.collection)
    const { findings } = await this.check(input.definition)
    const errors = findings.filter((finding) => finding.severity === "error")
    if (errors.length > 0)
      throw new ValidationError(`The policies have ${errors.length} lint error(s)`, {
        details: { findings: errors },
      })
    const by = actorName(input.actor)
    const session = this.client.startSession()
    try {
      const stored = await session.withTransaction(async () => {
        const current = await this.policies.findOne({ _id: collection }, { session })
        const version = current?.version ?? 0
        if (version !== input.expectedVersion)
          throw new ConflictError(
            `The policies of '${collection}' are at version ${version}, not ${input.expectedVersion}; reload, compare and publish again`,
            {
              details: {
                collection,
                currentVersion: version,
                expectedVersion: input.expectedVersion,
              },
            },
          )
        const now = new Date()
        const next = toStored(input.definition, {
          version: version + 1,
          updatedAt: now,
          updatedBy: by,
        })
        if (current !== null) {
          await this.history.updateOne(
            { collection, version: current.version },
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
            collection,
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
        await this.policies.replaceOne({ _id: collection }, next, { upsert: true, session })
        await this.audit.record(
          {
            action,
            actor: input.actor,
            target: { collection, version: next.version },
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
      return { stored, findings }
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
    return this.publish(
      { ...input, definition: fromStored(entry.document) },
      "policy.rollback",
      input.version,
    )
  }
}
