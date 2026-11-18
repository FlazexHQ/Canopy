import { createRequire } from "node:module"
import { CanopyError, ErrorCode } from "@canopy/protocol"
import { hostTarget } from "./targets.ts"

/** A filter compiled by the Rust matcher. */
export interface BindingFilter {
  handle(): BindingFilterHandle
  matches(document: Uint8Array): boolean
  matchesEjson(document: string): boolean
  matchMany(documents: readonly Uint8Array[]): Uint8Array
  matchConcatenated(documents: Uint8Array): Uint8Array
}

/** A compiled filter as an opaque handle, for the `matchBson` function. */
interface BindingFilterHandle {
  readonly __filter: unique symbol
}

/** A variable that made its policy drop out, as the Rust engine reports it. */
interface BindingVariableIssue {
  readonly kind: "missing" | "shape" | "coercion"
  readonly variable: string
  readonly collection: string
  readonly policy: string
}

/** An evaluation error the Rust engine turned into DENY. */
interface BindingEvaluationError {
  readonly code: string
  readonly name: string
  readonly message: string
  readonly collection: string
  readonly op: string
}

/** One evaluation of the Rust engine. */
export interface BindingEvaluation {
  readonly kind: "all" | "deny" | "filter"
  readonly filter?: string
  readonly issues: readonly BindingVariableIssue[]
  readonly errors: readonly BindingEvaluationError[]
}

/** Field access as the Rust engine reports it. */
export interface BindingAccess {
  readonly kind: "all" | "only" | "omit"
  readonly paths: readonly string[]
}

/** The policy engine of the Rust port. */
export interface BindingPolicyEngine {
  readonly version: string
  hasGrant(collection: string, op: string, request: string): boolean
  using(collection: string, op: string, request: string): BindingEvaluation
  check(collection: string, op: string, request: string): BindingEvaluation
  target(collection: string, op: string, request: string): BindingEvaluation
  effectiveRead(collection: string, filter: string, request: string): BindingEvaluation
  readable(collection: string, request: string): BindingAccess
  writable(collection: string, op: string, request: string): BindingAccess
  contextNames(collections: readonly string[] | null, roles: readonly string[]): string[]
}

/** The parts of a query key, each document as EJSON text. */
export interface BindingQueryKey {
  readonly collection: string
  readonly filter: string
  readonly sort?: string
  readonly limit?: number
  readonly projection?: string
}

/** Everything the Rust port exports. */
export interface Binding {
  engine(): "native" | "wasm"
  ejsonToBson(text: string): Uint8Array
  bsonToEjson(bytes: Uint8Array, canonical: boolean): string
  canonicalQuery(key: BindingQueryKey): string
  queryHash(key: BindingQueryKey): string
  matchBson(filter: BindingFilterHandle, document: Uint8Array): number
  readonly Filter: {
    fromEjson(text: string): BindingFilter
  }
  readonly PolicyEngine: new (
    collections: readonly string[],
    contexts: string,
  ) => BindingPolicyEngine
}

/** Which build of the Rust port to load: the native addon, its WebAssembly fallback, or the first that loads. */
export type BindingKind = "native" | "wasm" | "auto"

const require = createRequire(import.meta.url)

interface DenoPermissions {
  readonly permissions?: { querySync?(descriptor: { name: string }): { state: string } }
}

/**
 * Whether native addons may load. Deno loads them through FFI, and in an interactive terminal it would prompt
 * for that permission, so FFI is used only when it is already granted.
 */
function nativeAllowed(): boolean {
  const deno = (globalThis as { Deno?: DenoPermissions }).Deno
  if (deno === undefined) return true
  try {
    return deno.permissions?.querySync?.({ name: "ffi" }).state === "granted"
  } catch {
    return false
  }
}

function attempt(specifiers: readonly string[], errors: unknown[]): Binding | undefined {
  for (const specifier of specifiers) {
    try {
      return require(specifier) as Binding
    } catch (error: unknown) {
      errors.push(error)
    }
  }
  return undefined
}

const loaded = new Map<BindingKind, Binding>()

/**
 * Loads the Rust port. `native` loads the prebuilt addon of this platform (a local build first, then the
 * `@canopy/native-<target>` package), `wasm` the WebAssembly build, and `auto` the addon when one loads and
 * WebAssembly otherwise. A binding embedded by a single file executable (under
 * `Symbol.for("canopy.native.binding")`) wins. Throws `CANOPY_UNAVAILABLE` when nothing loads.
 */
export function loadBinding(kind: BindingKind = "auto"): Binding {
  const cached = loaded.get(kind)
  if (cached !== undefined) return cached
  const embedded = (globalThis as Record<symbol, unknown>)[Symbol.for("canopy.native.binding")]
  const errors: unknown[] = []
  let binding: Binding | undefined
  if (embedded !== undefined && kind !== "wasm") binding = embedded as Binding
  const target = hostTarget()?.suffix
  if (binding === undefined && kind !== "wasm" && target !== undefined && nativeAllowed()) {
    binding = attempt([`../canopy-native.${target}.node`, `@canopy/native-${target}`], errors)
  }
  if (binding === undefined && kind !== "native") {
    binding = attempt(["../wasi.cjs", "@canopy/native-wasm32-wasi"], errors)
  }
  if (binding === undefined) {
    throw new CanopyError(
      ErrorCode.Unavailable,
      `No build of @canopy/native loads on ${process.platform} ${process.arch} (engine "${kind}")`,
      { cause: errors },
    )
  }
  loaded.set(kind, binding)
  return binding
}
