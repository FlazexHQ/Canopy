import { type CompiledFilter, compileFilter } from "@canopy/matcher"
import { type EngineHooks, PolicyEngine, type PolicySet } from "@canopy/policy"
import { canonicalQuery, type QueryKeyParts, queryHash } from "@canopy/query"
import { loadNativeEngine } from "./engine.ts"

/**
 * Which implementation of the core the server packages run: `ts` (the TypeScript packages), `native` (the
 * Rust core as a Node-API addon) or `wasm` (the Rust core as WebAssembly).
 */
export type EngineKind = "ts" | "native" | "wasm"

/** The engine kinds, in the order they are documented. */
export const ENGINE_KINDS: readonly EngineKind[] = ["ts", "native", "wasm"]

/** The parts of the core whose implementation an engine chooses. Both implementations give equal results. */
export interface CoreEngine {
  /** The implementation behind this engine. */
  readonly kind: EngineKind
  /** Compiles a MongoDB query filter into a document test, as `compileFilter` of `@canopy/matcher`. */
  compileFilter(filter: unknown): CompiledFilter
  /** Builds the policy engine of a validated policy set. */
  createPolicyEngine(set: PolicySet, hooks?: EngineHooks): PolicyEngine
  /** The canonical text of a query, as `canonicalQuery` of `@canopy/query`. */
  canonicalQuery(parts: QueryKeyParts): string
  /** The hash of a query, as `queryHash` of `@canopy/query`. */
  queryHash(parts: QueryKeyParts): string
}

const TS_ENGINE: CoreEngine = {
  kind: "ts",
  compileFilter,
  createPolicyEngine: (set, hooks) => new PolicyEngine(set, hooks),
  canonicalQuery,
  queryHash,
}

/**
 * Returns the core of an engine kind. `ts` never loads Rust; `native` and `wasm` load the matching build and
 * throw `CANOPY_UNAVAILABLE` when it cannot load, rather than silently running another implementation.
 */
export function selectEngine(kind: EngineKind = "ts"): CoreEngine {
  if (kind === "ts") return TS_ENGINE
  const native = loadNativeEngine(kind)
  return {
    kind,
    compileFilter: native.compileFilter,
    createPolicyEngine: native.createPolicyEngine,
    canonicalQuery: native.canonicalQuery,
    queryHash: native.queryHash,
  }
}
