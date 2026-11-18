import type { PolicyDraft } from "../../api/client.ts"
import type { SimulatedOperation, StoredPolicy } from "../../api/contract.ts"

/** The operations a policy can grant, in the order Studio shows them. */
export const ACCESS_OPERATIONS: readonly SimulatedOperation[] = [
  "read",
  "insert",
  "update",
  "delete",
]

/**
 * What one role may do for one operation under a set of policies: every document, only the documents a
 * clause matches, or nothing at all.
 */
export type Reach = "all" | "matching" | "none"

/** One cell of an {@link AccessMap}. */
export interface AccessCell {
  readonly reach: Reach
  /** The permissive policies that grant the operation to the role. */
  readonly grants: readonly string[]
  /** The restrictive policies that narrow it. */
  readonly limits: readonly string[]
}

/** One row of an {@link AccessMap}: the roles a request carries and what each operation reaches. */
export interface AccessRow {
  readonly role: string
  readonly roles: readonly string[]
  readonly cells: Readonly<Record<SimulatedOperation, AccessCell>>
}

/** What each role can do in a collection, derived from its policies. */
export type AccessMap = readonly AccessRow[]

function isEmptyClause(clause: string | undefined): boolean {
  if (clause === undefined) return true
  try {
    const value = JSON.parse(clause) as unknown
    return (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0
    )
  } catch {
    return false
  }
}

/** Whether a policy places no condition on the documents an operation touches. */
function unconditional(policy: StoredPolicy, op: SimulatedOperation): boolean {
  if (op === "read" || op === "delete") return isEmptyClause(policy.using)
  if (op === "insert") return isEmptyClause(policy.check ?? policy.using)
  return isEmptyClause(policy.using) && isEmptyClause(policy.check ?? policy.using)
}

function applies(policy: StoredPolicy, op: SimulatedOperation, roles: readonly string[]): boolean {
  return (
    policy.ops.includes(op) &&
    (policy.roles.includes("public") || policy.roles.some((role) => roles.includes(role)))
  )
}

/** Combines the policies that apply to one request the way the engine does: permissive OR, restrictive AND. */
export function reachOf(
  policies: readonly StoredPolicy[],
  op: SimulatedOperation,
  roles: readonly string[],
): AccessCell {
  const applicable = policies.filter((policy) => applies(policy, op, roles))
  const permissive = applicable.filter((policy) => policy.kind === "permissive")
  const restrictive = applicable.filter(
    (policy) => policy.kind === "restrictive" && !unconditional(policy, op),
  )
  const grants = permissive.map((policy) => policy.name)
  const limits = restrictive.map((policy) => policy.name)
  if (permissive.length === 0) return { reach: "none", grants, limits }
  const open = permissive.some((policy) => unconditional(policy, op))
  return { reach: open && restrictive.length === 0 ? "all" : "matching", grants, limits }
}

/**
 * Builds the access map of a draft: one row for `anon`, one for `authenticated`, and one for each custom
 * role a policy names, which a signed in user carries next to `authenticated`. The `service` role is left
 * out because it bypasses every policy.
 */
export function accessMap(draft: PolicyDraft): AccessMap {
  const custom = [
    ...new Set(
      draft.policies.flatMap((policy) =>
        policy.roles.filter(
          (role) => role !== "public" && role !== "anon" && role !== "authenticated",
        ),
      ),
    ),
  ].sort()
  const rows: { readonly role: string; readonly roles: readonly string[] }[] = [
    { role: "anon", roles: ["anon"] },
    { role: "authenticated", roles: ["authenticated"] },
    ...custom.map((role) => ({ role, roles: ["authenticated", role] })),
  ]
  return rows.map((row) => ({
    ...row,
    cells: Object.fromEntries(
      ACCESS_OPERATIONS.map((op) => [op, reachOf(draft.policies, op, row.roles)]),
    ) as Record<SimulatedOperation, AccessCell>,
  }))
}
