import type { AdminRole } from "../api/contract.ts"

/** What an admin may do in Studio. The server enforces the same rules; Studio only hides what would fail. */
export interface Permissions {
  readonly publishPolicies: boolean
  /** Publishing in production also needs a comment. */
  readonly publishNeedsComment: boolean
  readonly draftPolicies: boolean
  readonly writeData: boolean
  /** Production data edits need the collection name typed as confirmation. */
  readonly confirmDataEdits: boolean
  readonly createKeys: "all" | "publishable" | "none"
  readonly manageUsers: boolean
  readonly manageSettings: boolean
  readonly manageAdmins: boolean
  readonly dangerZone: boolean
  readonly inspectRealtime: boolean
  readonly impersonate: boolean
}

/**
 * The permissions of an admin role in an environment: `owner` may do everything, `admin` everything but
 * managing owners and the danger zone, `developer` works freely outside production but only reads data and
 * cannot publish in it, and `viewer` only reads.
 */
export function permissionsOf(
  role: AdminRole,
  environment: "development" | "production",
): Permissions {
  const production = environment === "production"
  const elevated = role === "owner" || role === "admin"
  const developer = role === "developer"
  return {
    publishPolicies: elevated || (developer && !production),
    publishNeedsComment: production,
    draftPolicies: elevated || developer,
    writeData: elevated || (developer && !production),
    confirmDataEdits: production,
    createKeys: elevated ? "all" : developer ? "publishable" : "none",
    manageUsers: elevated,
    manageSettings: elevated,
    manageAdmins: role === "owner",
    dangerZone: role === "owner",
    inspectRealtime: true,
    impersonate: elevated || developer,
  }
}
