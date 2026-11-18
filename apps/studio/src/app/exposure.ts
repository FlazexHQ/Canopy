import type { CollectionSummary } from "../api/contract.ts"

/** How the Data API treats a collection. */
export type Exposure = "private" | "closed" | "guarded"

/**
 * What a collection's exposure means for clients of the Data API: not exposed, exposed with no live policy
 * (so every request but the service role's is denied), or exposed and guarded by its live policies.
 */
export function exposureOf(collection: CollectionSummary): Exposure {
  if (!collection.exposed) return "private"
  return (collection.policyCount ?? 0) > 0 ? "guarded" : "closed"
}

/** The badge variant of each {@link Exposure}. */
export const EXPOSURE_BADGE = {
  private: "secondary",
  closed: "warning",
  guarded: "success",
} as const
