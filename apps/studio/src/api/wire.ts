import {
  array,
  boolean,
  date,
  json,
  literal,
  nullable,
  number,
  object,
  optional,
  record,
  string,
  unknown,
} from "./schema.ts"

/**
 * Response bodies of the server's admin API (`@canopy/server`, `/admin/v1`), as sent: relaxed EJSON, lists
 * wrapped in `{ data }`. The client converts them to the Studio types of `contract.ts`.
 */

export const ROLES = ["owner", "admin", "developer", "viewer"] as const

export const wireAdminUser = object({
  id: string,
  email: string,
  name: optional(nullable(string)),
  role: literal(...ROLES),
  mustChangePassword: optional(boolean),
  totpEnabled: optional(boolean),
  disabled: optional(boolean),
  createdAt: optional(date),
  lastLoginAt: optional(nullable(date)),
})

export const wireSetupStatus = object({ claimed: boolean })

export const wireTotpEnrollment = object({ secret: string, uri: string })

export const wireClaim = object({ user: wireAdminUser, totp: wireTotpEnrollment })

export const wireLogin = object({
  user: wireAdminUser,
  csrfToken: string,
  expiresAt: optional(date),
  token: optional(string),
})

export const wireMe = object({
  user: wireAdminUser,
  environment: literal("development", "production"),
  expiresAt: optional(date),
  permissions: optional(array(string)),
  version: optional(string),
})

export const wireAdmins = object({ data: array(wireAdminUser) })
export const wireAdminCreated = object({ user: wireAdminUser, password: string })
export const wireAdminUpdated = object({ user: wireAdminUser })

export const wireCollections = object({
  data: array(
    object({
      name: string,
      type: optional(string),
      exists: optional(boolean),
      exposed: boolean,
      realtime: boolean,
      policies: number,
      version: number,
      hash: optional(nullable(string)),
    }),
  ),
})

export const wireFinding = object({
  rule: string,
  severity: literal("error", "warn", "info"),
  collection: optional(string),
  policy: optional(string),
  message: string,
})

const wireStored = object({
  _id: string,
  version: number,
  exposed: boolean,
  realtime: boolean,
  policies: array(
    object({
      name: string,
      kind: literal("permissive", "restrictive"),
      ops: array(literal("read", "insert", "update", "delete")),
      roles: array(string),
      using: optional(string),
      check: optional(string),
    }),
  ),
  fields: optional(nullable(json)),
  immutable: optional(array(string)),
  hash: optional(string),
  updatedAt: optional(date),
  updatedBy: optional(string),
})

export const wirePublishResult = object({
  stored: wireStored,
  findings: optional(array(wireFinding)),
})

/** A shape of the inferred or declared collection schema (`@canopy/schema`). */
export const wireCollectionSchema = object({
  collection: string,
  schema: nullable(object({ name: optional(string), shape: json, source: optional(string) })),
})

export const wireCollectionStats = object({
  collection: string,
  documents: number,
  size: optional(number),
  averageDocumentSize: optional(number),
  storageSize: optional(number),
  totalIndexSize: optional(number),
  indexes: optional(
    array(object({ name: string, key: record(unknown), unique: optional(boolean) })),
  ),
})

export const wireDocuments = object({
  data: array(json),
  page: optional(object({ limit: optional(number), next: optional(nullable(string)) })),
  ct: optional(unknown),
  masked: optional(boolean),
})

export const wireWrite = object({
  data: optional(nullable(json)),
  matched: optional(number),
  modified: optional(number),
  deleted: optional(number),
  insertedIds: optional(array(unknown)),
  ct: optional(unknown),
})

export const wirePolicies = object({
  collection: string,
  stored: nullable(wireStored),
  version: number,
  active: optional(nullable(string)),
  findings: optional(array(wireFinding)),
  writable: optional(boolean),
})

export const wireValidation = object({
  valid: boolean,
  hash: optional(string),
  findings: array(wireFinding),
})

const wireExplained = object({
  name: string,
  kind: literal("permissive", "restrictive"),
  applies: boolean,
  reason: string,
  resolved: optional(json),
})

const wireExplanation = object({
  bypass: optional(boolean),
  exposed: optional(boolean),
  policies: array(wireExplained),
})

const wireFieldAccess = object({
  kind: literal("all", "only", "omit"),
  paths: optional(array(string)),
})

export const wireSimulation = object({
  allowed: boolean,
  op: optional(string),
  roles: optional(array(string)),
  effectiveFilter: json,
  explain: wireExplanation,
  check: optional(wireExplanation),
  fields: optional(object({ read: wireFieldAccess, write: optional(wireFieldAccess) })),
  count: optional(number),
  sample: optional(array(json)),
})

export const wireHistory = object({
  data: array(
    object({
      version: number,
      hash: optional(string),
      document: wireStored,
      publishedAt: optional(date),
      publishedBy: optional(string),
      comment: optional(string),
      commitSha: optional(string),
      rollbackOf: optional(number),
    }),
  ),
})

export const wireApiKeys = object({ data: array(json) })

export const wireDoctor = object({
  status: optional(literal("ok", "warn", "fail")),
  environment: optional(string),
  checks: array(
    object({
      name: string,
      status: literal("ok", "warn", "fail"),
      message: string,
      fix: optional(string),
      docs: optional(string),
    }),
  ),
})

export const wireAudit = object({
  data: array(
    object({
      _id: unknown,
      at: date,
      action: string,
      actor: object({
        type: optional(string),
        id: string,
        email: optional(string),
        role: optional(string),
      }),
      outcome: optional(literal("ok", "denied", "failed")),
      target: optional(json),
      diff: optional(unknown),
      comment: optional(string),
      commitSha: optional(string),
      details: optional(json),
    }),
  ),
  next: optional(nullable(string)),
})

export const wireSettings = object({
  auditRetentionDays: nullable(number),
  requestLogSampleRate: number,
  requestLogRetentionDays: number,
  adminAllowlist: array(string),
})

export const wireLogs = object({
  data: array(
    object({
      _id: unknown,
      at: date,
      surface: literal("rest", "auth", "admin", "realtime"),
      method: string,
      path: string,
      status: number,
      durationMs: number,
      ip: optional(string),
      requestId: optional(string),
    }),
  ),
  next: optional(nullable(string)),
  sampleRate: number,
  retentionDays: number,
})

export const wireList = object({ data: array(unknown) })

/** An app user of built in auth (`AuthUser` of `@canopy/auth`). */
export const wireAppUser = object({
  id: string,
  email: optional(string),
  emailVerified: boolean,
  name: optional(string),
  isAnonymous: boolean,
  roles: array(string),
  appMetadata: json,
  userMetadata: json,
  banned: boolean,
  banReason: optional(string),
  banExpires: optional(date),
  createdAt: date,
  updatedAt: date,
})

export const wireUsersPage = object({ data: array(wireAppUser), total: number })

export const wireAuthSessions = object({
  data: array(
    object({
      id: string,
      userId: string,
      createdAt: date,
      updatedAt: date,
      expiresAt: date,
      ipAddress: optional(string),
      userAgent: optional(string),
    }),
  ),
})

export const wireRevoked = object({ revoked: number })

/** Signing keys of built in auth (`SigningKeyInfo`). */
export const wireSigningKeys = object({
  data: array(
    object({
      kid: string,
      alg: string,
      state: literal("standby", "active", "retired", "revoked"),
      createdAt: date,
      expiresAt: date,
      revokedAt: optional(date),
    }),
  ),
})

export const EMAIL_KINDS = [
  "verification",
  "magic_link",
  "otp",
  "reset_password",
  "invite",
  "email_change",
] as const

export const EMAIL_PLACEHOLDERS = ["appName", "email", "url", "otp", "newEmail"] as const

const wireTemplate = object({
  kind: literal(...EMAIL_KINDS),
  subject: string,
  text: string,
  html: optional(string),
  source: literal("default", "studio"),
  placeholders: array(literal(...EMAIL_PLACEHOLDERS)),
  required: array(literal(...EMAIL_PLACEHOLDERS)),
})

export const wireTemplates = object({ version: number, data: array(wireTemplate) })
export const wireTemplateSaved = object({ version: number, data: wireTemplate })
export const wireTemplatePreview = object({
  kind: literal(...EMAIL_KINDS),
  rendered: object({ subject: string, text: string, html: optional(string) }),
})
export const wireTemplateHistory = object({
  data: array(
    object({
      version: number,
      kind: optional(literal(...EMAIL_KINDS)),
      change: literal("update", "reset"),
      templates: record(object({ subject: string, text: string, html: optional(string) })),
      updatedAt: date,
      updatedBy: string,
      comment: optional(string),
    }),
  ),
})
