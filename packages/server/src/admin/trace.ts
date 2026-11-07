import { canAccess, fieldAccess, type PolicyEngine, Role } from "@canopy/policy"
import type { EventTrace, ObserverOutcome } from "@canopy/realtime"

/** A candidate of a trace whose DLS outcome reads fields the caller may not see. */
export type MaskedOutcome = Omit<ObserverOutcome, "dls"> & {
  readonly dls?: ObserverOutcome["dls"] | { readonly masked: true }
}

/** An event trace as the admin API returns it. */
export interface AdminEventTrace extends Omit<EventTrace, "candidates"> {
  readonly candidates: readonly MaskedOutcome[]
}

/**
 * Hides the DLS explanation of each candidate whose policies read a field hidden from `authenticated`, for
 * admin roles that see such fields masked. Whether a policy over a hidden field matched tells something
 * about the field's value, so the whole explanation becomes `{ masked: true }`.
 */
export function maskTrace(trace: EventTrace, engine: PolicyEngine): AdminEventTrace {
  const access = fieldAccess(
    engine.collection(trace.coll)?.fields?.read,
    new Set([Role.Authenticated]),
  )
  return {
    ...trace,
    candidates: trace.candidates.map((candidate) => {
      const dls = candidate.dls
      if (dls === undefined) return candidate
      const hidden = dls.policies.some((policy) =>
        policy.fields.some((field) => !canAccess(access, field)),
      )
      return hidden ? { ...candidate, dls: { masked: true } } : candidate
    }),
  }
}
