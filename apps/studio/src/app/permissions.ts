import type { AdminRole } from "../api/contract.ts"

/** The admin API permission names, as `GET /admin/v1/me` lists them. */
export const ADMIN_PERMISSIONS = [
  "session",
  "collections.read",
  "collections.write",
  "documents.read",
  "documents.write",
  "documents.viewAs",
  "documents.writeAs",
  "policies.read",
  "policies.simulate",
  "policies.publish",
  "keys.read",
  "keys.publishable",
  "keys.secret",
  "realtime.stats",
  "realtime.inspect",
  "ops.doctor",
  "ops.audit",
  "settings.read",
  "settings.write",
  "admins.read",
  "admins.manage",
  "admins.manageOwners",
  "users.read",
  "users.manage",
] as const

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number]

const DEVELOPER: ReadonlySet<AdminPermission> = new Set<AdminPermission>([
  "session",
  "collections.read",
  "collections.write",
  "documents.read",
  "documents.write",
  "documents.viewAs",
  "documents.writeAs",
  "policies.read",
  "policies.simulate",
  "policies.publish",
  "keys.read",
  "keys.publishable",
  "realtime.stats",
  "realtime.inspect",
  "ops.doctor",
  "users.read",
])

const DEVELOPER_NOT_IN_PRODUCTION: ReadonlySet<AdminPermission> = new Set<AdminPermission>([
  "collections.write",
  "documents.write",
  "documents.writeAs",
  "policies.publish",
])

const VIEWER: ReadonlySet<AdminPermission> = new Set<AdminPermission>([
  "session",
  "collections.read",
  "documents.read",
  "policies.read",
  "realtime.stats",
  "ops.doctor",
])

/**
 * The server's permission table: `owner` may do everything, `admin` everything except managing owners,
 * `developer` drafts, simulates, browses data, inspects realtime and manages publishable keys, and
 * publishes and edits data only outside production, and `viewer` reads dashboards and data.
 */
export function can(
  role: AdminRole,
  permission: AdminPermission,
  environment: "development" | "production",
): boolean {
  switch (role) {
    case "owner":
      return true
    case "admin":
      return permission !== "admins.manageOwners"
    case "developer":
      if (environment === "production" && DEVELOPER_NOT_IN_PRODUCTION.has(permission)) return false
      return DEVELOPER.has(permission)
    case "viewer":
      return VIEWER.has(permission)
  }
}

/** What an admin may do in Studio. The server enforces the same rules; Studio only hides what would fail. */
export interface Permissions {
  readonly publishPolicies: boolean
  /** Publishing (and the exposure toggles, which publish too) needs a comment in production. */
  readonly publishNeedsComment: boolean
  readonly draftPolicies: boolean
  /** Turning exposure and realtime on or off, which publishes a policy version. */
  readonly toggleCollections: boolean
  readonly writeData: boolean
  /** Production data edits need the collection name typed as confirmation. */
  readonly confirmDataEdits: boolean
  readonly createKeys: "all" | "publishable" | "none"
  readonly readKeys: boolean
  /** Seeing app users of built in auth and their sessions. */
  readonly readUsers: boolean
  /** Creating, changing, banning and deleting app users, and ending their sessions. */
  readonly manageUsers: boolean
  readonly readSettings: boolean
  readonly manageSettings: boolean
  readonly readAdmins: boolean
  /** Creating and changing admins below `owner`. */
  readonly manageAdmins: boolean
  readonly manageOwners: boolean
  readonly dangerZone: boolean
  readonly inspectRealtime: boolean
  readonly readAudit: boolean
  /** Reading data as a role, user or claims. */
  readonly impersonate: boolean
  /** Writing as an impersonated caller, which also needs a reason. */
  readonly writeAs: boolean
}

/** Studio permissions from the server's permission names. */
export function permissionsFrom(
  granted: Iterable<string>,
  environment: "development" | "production",
): Permissions {
  const set = new Set(granted)
  const has = (permission: AdminPermission) => set.has(permission)
  const production = environment === "production"
  return {
    publishPolicies: has("policies.publish"),
    publishNeedsComment: production,
    draftPolicies: has("policies.simulate"),
    toggleCollections: has("collections.write"),
    writeData: has("documents.write"),
    confirmDataEdits: production,
    createKeys: has("keys.secret") ? "all" : has("keys.publishable") ? "publishable" : "none",
    readKeys: has("keys.read"),
    readUsers: has("users.read"),
    manageUsers: has("users.manage"),
    readSettings: has("settings.read"),
    manageSettings: has("settings.write"),
    readAdmins: has("admins.read"),
    manageAdmins: has("admins.manage"),
    manageOwners: has("admins.manageOwners"),
    dangerZone: has("admins.manageOwners"),
    inspectRealtime: has("realtime.inspect"),
    readAudit: has("ops.audit"),
    impersonate: has("documents.viewAs"),
    writeAs: has("documents.writeAs"),
  }
}

/** The permissions of a role in an environment, computed with the server's table. */
export function permissionsOf(
  role: AdminRole,
  environment: "development" | "production",
): Permissions {
  return permissionsFrom(
    ADMIN_PERMISSIONS.filter((permission) => can(role, permission, environment)),
    environment,
  )
}
