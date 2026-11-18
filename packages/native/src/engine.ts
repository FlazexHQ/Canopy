import { type CompiledFilter, UnsupportedQueryError, UpdateError } from "@canopy/matcher"
import {
  type Compiled,
  type EngineHooks,
  type FieldAccess,
  type Operation,
  PolicyEngine,
  type PolicySet,
  type RequestContext,
  toStored,
} from "@canopy/policy"
import {
  bsonTypeTag,
  CanopyError,
  canonicalString,
  ErrorCode,
  InvalidQueryError,
  isDocument,
  isErrorCode,
  parse,
  toCanonical,
  wrappedNumber,
} from "@canopy/protocol"
import type { QueryKeyParts } from "@canopy/query"
import {
  type Binding,
  type BindingAccess,
  type BindingEvaluation,
  type BindingFilter,
  type BindingKind,
  type BindingPolicyEngine,
  type BindingQueryKey,
  loadBinding,
} from "./binding.ts"

const DENY: Compiled = { kind: "deny" }

/**
 * Turns an error thrown by the Rust port back into the TypeScript error it mirrors. The port throws errors
 * whose `code` is a `CANOPY_*` code and whose message starts with the TypeScript class name and a colon.
 */
export function fromBinding(error: unknown): Error {
  if (!(error instanceof Error)) return new CanopyError(ErrorCode.Internal, String(error))
  const code = (error as { code?: unknown }).code
  const colon = error.message.indexOf(": ")
  const name = colon === -1 ? "" : error.message.slice(0, colon)
  const message = colon === -1 ? error.message : error.message.slice(colon + 2)
  switch (name) {
    case "UnsupportedQueryError":
      return new UnsupportedQueryError(message)
    case "UpdateError":
      return new UpdateError(message)
    case "InvalidQueryError":
      return new InvalidQueryError(message)
    case "TypeError":
      return new TypeError(message)
  }
  if (code === ErrorCode.InvalidQuery) return new InvalidQueryError(message)
  if (typeof code === "string" && isErrorCode(code)) return new CanopyError(code, message)
  return new CanopyError(ErrorCode.Internal, error.message, { cause: error })
}

function call<T>(run: () => T): T {
  try {
    return run()
  } catch (error: unknown) {
    throw fromBinding(error)
  }
}

/** A filter compiled by the Rust matcher. `matches` takes decoded documents; the other tests take BSON. */
export interface NativeCompiledFilter extends CompiledFilter {
  /** Matches one BSON document. Throws when the bytes are malformed or the matcher cannot decide. */
  matchesBson(document: Uint8Array): boolean
  /** One byte per BSON document: 0 no match, 1 match, 2 undecided (treat as a refusal). */
  matchMany(documents: readonly Uint8Array[]): Uint8Array
  /** Like `matchMany` for BSON documents laid end to end in one buffer, as a batch of change events is. */
  matchConcatenated(documents: Uint8Array): Uint8Array
}

function compiledFilter(filter: BindingFilter): NativeCompiledFilter {
  return {
    matches: (doc) => call(() => filter.matchesEjson(exactText(doc))),
    matchesBson: (document) => call(() => filter.matches(document)),
    matchMany: (documents) => call(() => filter.matchMany(documents)),
    matchConcatenated: (documents) => call(() => filter.matchConcatenated(documents)),
  }
}

function doubleText(value: number): string {
  if (Number.isNaN(value)) return "NaN"
  if (value === Number.POSITIVE_INFINITY) return "Infinity"
  if (value === Number.NEGATIVE_INFINITY) return "-Infinity"
  if (Object.is(value, -0)) return "-0.0"
  return Number.isInteger(value) && Math.abs(value) < 1e21 ? `${value}.0` : String(value)
}

function exact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(exact)
  if (isDocument(value)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      const item = value[key]
      if (item !== undefined) out[key] = exact(item)
    }
    return out
  }
  if (bsonTypeTag(value) === "Double")
    return { $numberDouble: doubleText(wrappedNumber(value) ?? 0) }
  return toCanonical(value)
}

/**
 * The canonical EJSON text of a value that keeps the types the driver decoded: a `Double` stays a double
 * even when its value is whole, which `canonicalString` (built for JavaScript numbers) turns into an int32.
 */
function exactText(value: unknown): string {
  return JSON.stringify(exact(value))
}

function requestText(ctx: RequestContext): string {
  return canonicalString({
    roles: [...ctx.roles],
    claims: ctx.claims,
    ...(ctx.ctx === undefined ? {} : { ctx: ctx.ctx }),
    now: ctx.now,
  })
}

function access(result: BindingAccess): FieldAccess {
  return result.kind === "all" ? { kind: "all" } : { kind: result.kind, paths: [...result.paths] }
}

function compiled(result: BindingEvaluation): Compiled {
  if (result.kind !== "filter") return result.kind === "all" ? { kind: "all" } : DENY
  if (typeof result.filter !== "string") {
    throw new CanopyError(
      ErrorCode.Internal,
      "The Rust policy engine returned a filter without its text",
    )
  }
  return { kind: "filter", filter: parse(result.filter) as Record<string, unknown> }
}

/**
 * The policy engine with every evaluation done by the Rust port. It keeps the public API of
 * {@link PolicyEngine}, so the server packages use it unchanged; the explanation of decisions stays in
 * TypeScript. Construction fails when the Rust engine computes another bundle version than TypeScript, so the
 * two can never run on different policies.
 */
class RustPolicyEngine extends PolicyEngine {
  readonly #native: BindingPolicyEngine
  readonly #engineHooks: EngineHooks

  constructor(set: PolicySet, hooks: EngineHooks, binding: Binding) {
    super(set, hooks)
    this.#engineHooks = hooks
    const collections = [...set.collections.values()].map((def) =>
      canonicalString(toStored(def, { version: 0 })),
    )
    this.#native = call(() => new binding.PolicyEngine(collections, canonicalString(set.contexts)))
    if (this.#native.version !== set.version) {
      throw new CanopyError(
        ErrorCode.Internal,
        `The Rust policy engine computed version ${this.#native.version} for policies of version ${set.version}`,
      )
    }
  }

  #report(result: BindingEvaluation): void {
    for (const issue of result.issues) this.#engineHooks.onVariableIssue?.({ ...issue })
    for (const error of result.errors) {
      this.#engineHooks.onEvaluationError?.(
        fromBinding(
          Object.assign(new Error(`${error.name}: ${error.message}`), { code: error.code }),
        ),
        error.collection,
        error.op as Operation,
      )
    }
  }

  #evaluate(
    collection: string,
    op: Operation,
    ctx: RequestContext,
    run: (request: string) => BindingEvaluation,
  ): Compiled {
    let result: BindingEvaluation
    try {
      result = run(requestText(ctx))
    } catch (error: unknown) {
      this.#engineHooks.onEvaluationError?.(fromBinding(error), collection, op)
      return DENY
    }
    this.#report(result)
    try {
      return compiled(result)
    } catch (error: unknown) {
      this.#engineHooks.onEvaluationError?.(fromBinding(error), collection, op)
      return DENY
    }
  }

  override hasGrant(collection: string, op: Operation, ctx: RequestContext): boolean {
    try {
      return this.#native.hasGrant(collection, op, requestText(ctx))
    } catch {
      return false
    }
  }

  override using(collection: string, op: Operation, ctx: RequestContext): Compiled {
    return this.#evaluate(collection, op, ctx, (request) =>
      this.#native.using(collection, op, request),
    )
  }

  override check(collection: string, op: "insert" | "update", ctx: RequestContext): Compiled {
    return this.#evaluate(collection, op, ctx, (request) =>
      this.#native.check(collection, op, request),
    )
  }

  override target(collection: string, op: "update" | "delete", ctx: RequestContext): Compiled {
    const result = call(() => this.#native.target(collection, op, requestText(ctx)))
    this.#report(result)
    return compiled(result)
  }

  override effectiveRead(
    collection: string,
    userFilter: Record<string, unknown>,
    ctx: RequestContext,
  ): Compiled {
    const result = call(() =>
      this.#native.effectiveRead(collection, canonicalString(userFilter), requestText(ctx)),
    )
    this.#report(result)
    return compiled(result)
  }

  override readable(collection: string, ctx: RequestContext): FieldAccess {
    return access(call(() => this.#native.readable(collection, requestText(ctx))))
  }

  override writable(collection: string, op: "insert" | "update", ctx: RequestContext): FieldAccess {
    return access(call(() => this.#native.writable(collection, op, requestText(ctx))))
  }

  override contextNames(
    collections: Iterable<string> | undefined,
    roles: ReadonlySet<string>,
  ): string[] {
    return call(() =>
      this.#native.contextNames(collections === undefined ? null : [...collections], [...roles]),
    )
  }
}

function queryKey(parts: QueryKeyParts): BindingQueryKey {
  const { limit } = parts
  if (
    limit !== undefined &&
    limit !== null &&
    (!Number.isInteger(limit) || Object.is(limit, -0) || limit < 0 || limit > 2_147_483_647)
  ) {
    throw new InvalidQueryError(
      `The limit ${String(limit)} of a query key must be a whole number from 0`,
    )
  }
  return {
    collection: parts.collection,
    filter: canonicalString(parts.filter),
    ...(parts.sort === undefined || parts.sort === null
      ? {}
      : { sort: canonicalString(parts.sort) }),
    ...(parts.limit === undefined || parts.limit === null ? {} : { limit: parts.limit }),
    ...(parts.projection === undefined ? {} : { projection: canonicalString(parts.projection) }),
  }
}

/** The Rust core behind the API of the TypeScript packages it mirrors. */
export interface NativeEngine {
  /** `native` for the Node-API addon, `wasm` for the WebAssembly fallback. */
  readonly kind: "native" | "wasm"
  /** Compiles a MongoDB query filter with the Rust matcher. Throws what `compileFilter` would. */
  compileFilter(filter: unknown): NativeCompiledFilter
  /** Builds a policy engine whose evaluations run in Rust. Throws what `createPolicySet` would. */
  createPolicyEngine(set: PolicySet, hooks?: EngineHooks): PolicyEngine
  /** The canonical text of a query, byte identical to `canonicalQuery`. */
  canonicalQuery(parts: QueryKeyParts): string
  /** The hash of a query, byte identical to `queryHash`. */
  queryHash(parts: QueryKeyParts): string
  /** Encodes a document given as EJSON text into BSON. */
  ejsonToBson(text: string): Uint8Array
  /** Decodes one BSON document into canonical or relaxed EJSON text. */
  bsonToEjson(bytes: Uint8Array, canonical: boolean): string
}

/**
 * Loads the Rust core: the native addon of this platform, its WebAssembly fallback, or (`auto`, the default)
 * the first that loads. Throws `CANOPY_UNAVAILABLE` when none does.
 */
export function loadNativeEngine(kind: BindingKind = "auto"): NativeEngine {
  const binding = loadBinding(kind)
  return {
    kind: binding.engine(),
    compileFilter: (filter) =>
      compiledFilter(call(() => binding.Filter.fromEjson(exactText(filter)))),
    createPolicyEngine: (set, hooks = {}) => new RustPolicyEngine(set, hooks, binding),
    canonicalQuery: (parts) => call(() => binding.canonicalQuery(queryKey(parts))),
    queryHash: (parts) => call(() => binding.queryHash(queryKey(parts))),
    ejsonToBson: (text) => call(() => binding.ejsonToBson(text)),
    bsonToEjson: (bytes, canonical) => call(() => binding.bsonToEjson(bytes, canonical)),
  }
}
