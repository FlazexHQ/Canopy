import { canonicalString, isDocument, parse, sha256Hex } from '@canopy/protocol'
import type {
  CollectionFields,
  CollectionPolicies,
  ContextDefinitions,
  Operation,
  PolicyDefinition,
  PolicyKind,
} from './model.ts'

/** One policy as stored in `canopy.policies`. Clauses are canonical EJSON strings. */
export interface StoredPolicy {
  readonly name: string
  readonly kind: PolicyKind
  readonly ops: readonly Operation[]
  readonly roles: readonly string[]
  readonly using?: string
  readonly check?: string
}

/** The stored document of one collection, `_id` being the collection name. */
export interface StoredCollectionPolicies {
  readonly _id: string
  readonly version: number
  readonly exposed: boolean
  readonly realtime: boolean
  readonly policies: readonly StoredPolicy[]
  readonly fields?: CollectionFields
  readonly immutable?: readonly string[]
  readonly hash: string
  readonly updatedAt?: Date
  readonly updatedBy?: string
}

/** The `_id` of the stored context lookup declarations. */
export const CONTEXT_DOCUMENT_ID = '_context'

function body(def: CollectionPolicies): Record<string, unknown> {
  return {
    _id: def.collection,
    exposed: def.exposed,
    realtime: def.realtime,
    policies: def.policies.map((policy) => ({
      name: policy.name,
      kind: policy.kind,
      ops: [...policy.ops],
      roles: [...policy.roles],
      ...(policy.using === undefined ? {} : { using: canonicalString(policy.using) }),
      ...(policy.check === undefined ? {} : { check: canonicalString(policy.check) }),
    })),
    fields: def.fields ?? null,
    immutable: def.immutable ?? [],
  }
}

/** The SHA-256 of the canonical policy body of a collection, used as its version hash. */
export function hashCollection(def: CollectionPolicies): string {
  return `sha256:${sha256Hex(canonicalString(body(def)))}`
}

/** The bundle version over all collections and context lookups. */
export function hashPolicySet(
  hashes: ReadonlyMap<string, string>,
  contexts: ContextDefinitions,
): string {
  const entries = [...hashes.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `sha256:${sha256Hex(canonicalString({ collections: entries, contexts }))}`
}

/** Converts authoring form to the stored form. */
export function toStored(
  def: CollectionPolicies,
  meta: { readonly version: number; readonly updatedAt?: Date; readonly updatedBy?: string },
): StoredCollectionPolicies {
  const stored = body(def)
  return {
    _id: def.collection,
    version: meta.version,
    exposed: def.exposed,
    realtime: def.realtime,
    policies: stored['policies'] as StoredPolicy[],
    ...(def.fields === undefined ? {} : { fields: def.fields }),
    ...(def.immutable === undefined ? {} : { immutable: def.immutable }),
    hash: hashCollection(def),
    ...(meta.updatedAt === undefined ? {} : { updatedAt: meta.updatedAt }),
    ...(meta.updatedBy === undefined ? {} : { updatedBy: meta.updatedBy }),
  }
}

function clause(text: unknown, name: string, kind: string): Record<string, unknown> | undefined {
  if (text === undefined) return undefined
  if (typeof text !== 'string')
    throw new TypeError(`Policy '${name}' has a ${kind} clause that is not a string`)
  const value = parse(text)
  if (!isDocument(value))
    throw new TypeError(`Policy '${name}' has a ${kind} clause that is not a document`)
  return value
}

/**
 * Converts a stored document back to authoring form. The result still has to pass validation (through
 * `createPolicySet`) before it is used, so a tampered document is rejected rather than trusted.
 */
export function fromStored(stored: unknown): CollectionPolicies {
  if (!isDocument(stored) || typeof stored['_id'] !== 'string')
    throw new TypeError('A stored policy document needs a string _id')
  const policies = stored['policies']
  if (!Array.isArray(policies))
    throw new TypeError(`Policies for '${stored['_id']}' must be an array`)
  return {
    collection: stored['_id'],
    exposed: stored['exposed'] === true,
    realtime: stored['realtime'] === true,
    policies: policies.map((raw): PolicyDefinition => {
      if (!isDocument(raw)) throw new TypeError('A stored policy must be a document')
      const name = String(raw['name'])
      const using = clause(raw['using'], name, 'using')
      const check = clause(raw['check'], name, 'check')
      return {
        name,
        kind: raw['kind'] as PolicyKind,
        ops: (Array.isArray(raw['ops']) ? raw['ops'] : []) as Operation[],
        roles: (Array.isArray(raw['roles']) ? raw['roles'] : []) as string[],
        ...(using === undefined ? {} : { using }),
        ...(check === undefined ? {} : { check }),
      }
    }),
    ...(isDocument(stored['fields']) ? { fields: stored['fields'] as CollectionFields } : {}),
    ...(Array.isArray(stored['immutable']) ? { immutable: stored['immutable'] as string[] } : {}),
  }
}
