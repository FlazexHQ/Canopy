import type {
  CollectionFields,
  CollectionPolicies,
  ContextDefinitions,
  ContextLookup,
  FilterTemplate,
  Operation,
  PolicyDefinition,
  PolicyKind,
} from "./model.ts"

/** Coercions a JWT claim variable can request. */
export type ClaimCoercion = "objectId" | "string" | "number" | "bool" | "date" | "uuid"

/** A JWT claim variable in stored form. */
export interface AuthVariable {
  readonly $auth: string
  readonly as?: ClaimCoercion
}

/** A context lookup variable in stored form. */
export interface CtxVariable {
  readonly $ctx: string
}

/** A time variable in stored form. */
export interface NowVariable {
  readonly $now: { readonly offset?: string }
}

/** Refers to a claim of the verified JWT, for example `auth('sub')` or `auth('org_ids')`. */
export function auth(path: string, as?: ClaimCoercion): AuthVariable {
  return as === undefined ? { $auth: path } : { $auth: path, as }
}

/** Refers to a declared context lookup, for example `ctx('projectIds')`. */
export function ctx(name: string): CtxVariable {
  return { $ctx: name }
}

/** Refers to the request time, optionally shifted by an ISO 8601 duration such as `'-P7D'`. */
export function now(offset?: string): NowVariable {
  return { $now: offset === undefined ? {} : { offset } }
}

/** A policy under construction. Every method returns a new builder; nothing is mutated. */
export class PolicyBuilder {
  readonly definition: PolicyDefinition

  constructor(definition: PolicyDefinition) {
    this.definition = definition
  }

  /** Sets the `using` clause: which existing documents the operation may touch. */
  where(using: FilterTemplate): PolicyBuilder {
    return new PolicyBuilder({ ...this.definition, using })
  }

  /** Sets the `check` clause: the condition the resulting document must satisfy. */
  check(check: FilterTemplate): PolicyBuilder {
    return new PolicyBuilder({ ...this.definition, check })
  }

  /** Names the policy. Names must be unique within a collection. */
  named(name: string): PolicyBuilder {
    return new PolicyBuilder({ ...this.definition, name })
  }
}

function builders(kind: PolicyKind): {
  read(...roles: string[]): PolicyBuilder
  insert(...roles: string[]): PolicyBuilder
  update(...roles: string[]): PolicyBuilder
  delete(...roles: string[]): PolicyBuilder
  ops(ops: readonly Operation[], ...roles: string[]): PolicyBuilder
} {
  const make = (ops: readonly Operation[], roles: string[]): PolicyBuilder =>
    new PolicyBuilder({ name: "", kind, ops: [...ops], roles })
  return {
    read: (...roles) => make(["read"], roles),
    insert: (...roles) => make(["insert"], roles),
    update: (...roles) => make(["update"], roles),
    delete: (...roles) => make(["delete"], roles),
    ops: (ops, ...roles) => make(ops, roles),
  }
}

/** Builders for permissive policies (OR combined). */
export const allow: ReturnType<typeof builders> = builders("permissive")

/** Builders for restrictive policies (AND combined). */
export const restrict: ReturnType<typeof builders> = builders("restrictive")

/** Options accepted by {@link collection}. */
export interface CollectionOptions {
  readonly exposed?: boolean
  readonly realtime?: boolean
  readonly policies?: readonly (PolicyBuilder | PolicyDefinition)[]
  readonly fields?: CollectionFields
  readonly immutable?: readonly string[]
}

/**
 * Declares the policies of a collection. Unnamed policies get a stable name from their position, so the
 * result round trips losslessly through the stored form.
 */
export function collection(name: string, options: CollectionOptions = {}): CollectionPolicies {
  const policies = (options.policies ?? []).map((item, index) => {
    const definition = item instanceof PolicyBuilder ? item.definition : item
    return definition.name === ""
      ? { ...definition, name: `${definition.kind} ${definition.ops.join("+")} #${index + 1}` }
      : definition
  })
  return {
    collection: name,
    exposed: options.exposed ?? false,
    realtime: options.realtime ?? false,
    policies,
    ...(options.fields === undefined ? {} : { fields: options.fields }),
    ...(options.immutable === undefined ? {} : { immutable: options.immutable }),
  }
}

/** Declares context lookups. */
export function context(lookups: Readonly<Record<string, ContextLookup>>): ContextDefinitions {
  return lookups
}
