import { createPolicySet, fromStored, PolicyEngine } from "@canopy/policy"
import type { StoredCollection, ViewAs } from "../../api/contract.ts"

/**
 * The top level fields the read field rules hide from an identity, computed with the same engine as the
 * server from the published policies. The server only leaves such fields out, so Studio derives the list
 * to show them as masked columns. `known` are the collection's fields, needed for `only` rules.
 */
export function hiddenFieldsFor(
  stored: StoredCollection | null,
  viewAs: ViewAs,
  known: readonly string[],
): string[] {
  if (stored === null) return []
  let engine: PolicyEngine
  try {
    engine = new PolicyEngine(createPolicySet([fromStored(stored)]))
  } catch {
    return []
  }
  const access = engine.readable(stored._id, {
    roles: new Set(viewAs.roles),
    claims: viewAs.roles.includes("anon") ? null : viewAs.claims,
    now: new Date(),
  })
  const top = (paths: readonly string[]) => [
    ...new Set(paths.map((path) => path.split(".")[0] ?? path)),
  ]
  switch (access.kind) {
    case "all":
      return []
    case "omit":
      return top(access.paths).filter((path) => path !== "_id")
    case "only": {
      const allowed = new Set(top(access.paths))
      return top(known).filter((path) => path !== "_id" && !allowed.has(path))
    }
  }
}
