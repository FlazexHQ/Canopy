import { type CoreEngine, ENGINE_KINDS, type EngineKind, selectEngine } from "@canopy/native"
import type { EngineHooks, PolicyEngine, PolicySet } from "@canopy/policy"

function engineFromEnv(): EngineKind {
  const value = process.env["CANOPY_TEST_ENGINE"] ?? "ts"
  const kind = ENGINE_KINDS.find((candidate) => candidate === value)
  if (kind === undefined) {
    throw new Error(`CANOPY_TEST_ENGINE must be one of ${ENGINE_KINDS.join(", ")}, not "${value}"`)
  }
  return kind
}

/**
 * The engine the suites run the core on, from `CANOPY_TEST_ENGINE` (`ts`, the default, `native` or `wasm`), so
 * one suite checks every implementation.
 */
export const TEST_ENGINE: EngineKind = engineFromEnv()

/** The core of {@link TEST_ENGINE}. */
export function testCore(): CoreEngine {
  return selectEngine(TEST_ENGINE)
}

/** Builds the policy engine of a policy set on {@link TEST_ENGINE}. */
export function testPolicyEngine(set: PolicySet, hooks?: EngineHooks): PolicyEngine {
  return testCore().createPolicyEngine(set, hooks)
}
