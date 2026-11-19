import { CanopyError, ErrorCode } from "@canopy/protocol"

/** A filter compiled by the Rust matcher. */
export interface WasmFilter {
  /** The compiled filter as a handle for {@link WasmBinding.matchBson}. */
  handle(): WasmFilterHandle
  /** Matches one BSON document. Throws when the bytes are malformed or the matcher cannot decide. */
  matches(document: Uint8Array): boolean
  /** Matches one document given as EJSON text. */
  matchesEjson(document: string): boolean
  /** One byte per BSON document: 0 no match, 1 match, 2 undecided (treat as a refusal). */
  matchMany(documents: readonly Uint8Array[]): Uint8Array
  /** Like `matchMany` for BSON documents laid end to end in one buffer. */
  matchConcatenated(documents: Uint8Array): Uint8Array
}

/** A compiled filter as an opaque handle, which only {@link WasmBinding.matchBson} reads. */
export type WasmFilterHandle = object

/** One evaluation of the policy engine: the kind of result, the filter as canonical EJSON, what it reported. */
export interface WasmEvaluation {
  /** `all`, `deny` or `filter`. */
  readonly kind: "all" | "deny" | "filter"
  /** The filter as canonical EJSON text, when `kind` is `filter`. */
  readonly filter?: string
  /** The variables that made policies drop out. */
  readonly issues: readonly {
    readonly kind: "missing" | "shape" | "coercion"
    readonly variable: string
    readonly collection: string
    readonly policy: string
  }[]
  /** The errors that forced the result to DENY. */
  readonly errors: readonly {
    readonly code: string
    readonly name: string
    readonly message: string
    readonly collection: string
    readonly op: string
  }[]
}

/** The fields a request may read or write. */
export interface WasmAccess {
  /** `all`, `only` or `omit`. */
  readonly kind: "all" | "only" | "omit"
  /** The paths of `only` or `omit`. */
  readonly paths: readonly string[]
}

/** The policy engine of one validated policy set. Requests are given as EJSON text. */
export interface WasmPolicyEngine {
  /** The bundle version of the loaded policies. */
  readonly version: string
  /** Whether any permissive policy grants `op` to the request's roles. */
  hasGrant(collection: string, op: string, request: string): boolean
  /** `USING(op)` for one request. */
  using(collection: string, op: string, request: string): WasmEvaluation
  /** `CHECK(op)` for one request. */
  check(collection: string, op: string, request: string): WasmEvaluation
  /** `USING(op) AND USING(read)`, the target of an update or delete. */
  target(collection: string, op: string, request: string): WasmEvaluation
  /** The caller's filter, given as EJSON text, AND `USING(read)`. */
  effectiveRead(collection: string, filter: string, request: string): WasmEvaluation
  /** The fields the request may read. */
  readable(collection: string, request: string): WasmAccess
  /** The fields the request may write. */
  writable(collection: string, op: string, request: string): WasmAccess
  /** The context lookups the policies of `collections` (all when `null`) may use for these roles. */
  contextNames(collections: readonly string[] | null, roles: readonly string[]): string[]
}

/** The parts of a query key, each document as EJSON text. */
export interface WasmQueryKey {
  /** The collection. */
  readonly collection: string
  /** The effective filter. */
  readonly filter: string
  /** The sort, if any. */
  readonly sort?: string
  /** The limit, if any. */
  readonly limit?: number
  /** The projection, if any. */
  readonly projection?: string
}

/**
 * Everything the WebAssembly port exports. The names and shapes are those of the Node-API port, so
 * `engineFromBinding` of `@canopy/native` wraps either behind the API of the TypeScript packages. Errors are
 * thrown with a `CANOPY_*` `code` and a message that starts with the TypeScript error class and a colon.
 */
export interface WasmBinding {
  /** Always `wasm`. */
  engine(): "wasm"
  /** Encodes a document given as EJSON text into BSON. */
  ejsonToBson(text: string): Uint8Array
  /** Decodes one BSON document into canonical or relaxed EJSON text. */
  bsonToEjson(bytes: Uint8Array, canonical: boolean): string
  /** The canonical text of a query, byte identical to `canonicalQuery` of `@canopy/query`. */
  canonicalQuery(key: WasmQueryKey): string
  /** The hash of a query, byte identical to `queryHash` of `@canopy/query`. */
  queryHash(key: WasmQueryKey): string
  /** Matches one BSON document against a filter handle: 0 no match, 1 match, 2 undecided. */
  matchBson(filter: WasmFilterHandle, document: Uint8Array): number
  /** Compiles filters. */
  readonly Filter: {
    /** Compiles a filter given as EJSON text. Throws what `compileFilter` would. */
    fromEjson(text: string): WasmFilter
  }
  /** Builds the policy engine of policies in their stored form, as EJSON text. */
  readonly PolicyEngine: new (
    collections: readonly string[],
    contexts: string,
  ) => WasmPolicyEngine
}

/** The compiled WebAssembly module of the port, as a URL for runtimes that read or fetch it. */
export const wasmUrl: URL = new URL("../generated/canopy_wasm_bg.wasm", import.meta.url)

const GLUE: string = "../generated/canopy_wasm.js"

interface Glue {
  initSync(options: { module: WebAssembly.Module | BufferSource }): unknown
}

function isGlue(value: unknown): value is Glue & WasmBinding {
  if (typeof value !== "object" || value === null) return false
  const glue = value as Record<string, unknown>
  return typeof glue["initSync"] === "function" && typeof glue["engine"] === "function"
}

/**
 * Instantiates the WebAssembly port from its compiled module (on Cloudflare Workers, the module imported from
 * `@canopy/wasm/canopy_wasm_bg.wasm`) or its bytes (read from {@link wasmUrl}). One instance serves the whole
 * realm: later calls return it. A Rust panic aborts the instance with a `RuntimeError`, which the
 * `@canopy/native` wrapper turns into a denial; the realm must then be restarted to get a working instance.
 */
export async function instantiate(source: WebAssembly.Module | BufferSource): Promise<WasmBinding> {
  const glue: unknown = await import(/* @vite-ignore */ GLUE)
  if (!isGlue(glue)) {
    throw new CanopyError(ErrorCode.Unavailable, "The WebAssembly build of @canopy/wasm is missing")
  }
  glue.initSync({ module: source })
  return glue
}
