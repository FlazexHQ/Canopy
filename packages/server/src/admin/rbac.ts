import type { Environment } from "@canopy/config"

/** Studio and admin API roles, from most to least privileged. */
export const ADMIN_ROLES = ["owner", "admin", "developer", "viewer"] as const

/** An admin role. */
export type AdminRole = (typeof ADMIN_ROLES)[number]

/** What an admin request may need. */
export type Permission =
  /** `/me`, logout, own password and TOTP. */
  | "session"
  | "collections.read"
  /** Expose and realtime toggles, which publish a new policy version. */
  | "collections.write"
  /** Reading documents as `service` (viewers see fields hidden by DLS masked). */
  | "documents.read"
  | "documents.write"
  /** Reading through the DLS engine as a role, user or claims. */
  | "documents.viewAs"
  /** Writing as an impersonated caller, which also needs a reason. */
  | "documents.writeAs"
  | "policies.read"
  | "policies.simulate"
  | "policies.publish"
  | "keys.read"
  | "keys.publishable"
  | "keys.secret"
  | "realtime.stats"
  /** Connections, observers, the event tail and traces, which show subjects and filters. */
  | "realtime.inspect"
  | "ops.doctor"
  | "ops.audit"
  | "settings.read"
  | "settings.write"
  | "admins.read"
  /** Creating and changing admins below `owner`. */
  | "admins.manage"
  /** Creating, changing and removing owners. */
  | "admins.manageOwners"
  /** App users of built in auth, their sessions and signing keys (read only). */
  | "users.read"
  /** Creating, changing, banning and deleting app users, and ending their sessions. */
  | "users.manage"
  /** Triggers, schedules and dead letters, whose payloads hold documents. */
  | "webhooks.read"
  /** Retrying and deleting dead letters, and running schedules. */
  | "webhooks.manage"

const DEVELOPER: ReadonlySet<Permission> = new Set<Permission>([
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
  "webhooks.read",
])

/** What developers lose when `CANOPY_ENV=production`: publishing and data edits. */
const DEVELOPER_NOT_IN_PRODUCTION: ReadonlySet<Permission> = new Set<Permission>([
  "collections.write",
  "documents.write",
  "documents.writeAs",
  "policies.publish",
])

const VIEWER: ReadonlySet<Permission> = new Set<Permission>([
  "session",
  "collections.read",
  "documents.read",
  "policies.read",
  "realtime.stats",
  "ops.doctor",
])

/**
 * The permission table: `owner` may do everything; `admin` everything except managing owners; `developer`
 * drafts, simulates and tests policies, browses data, uses the realtime inspector and manages publishable
 * keys, and publishes and edits data only outside production; `viewer` reads dashboards and data with
 * DLS hidden fields masked.
 */
export function can(role: AdminRole, permission: Permission, environment: Environment): boolean {
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
    default:
      return false
  }
}

/** Whether `value` is an admin role. */
export function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === "string" && (ADMIN_ROLES as readonly string[]).includes(value)
}
