import {
  array,
  boolean,
  date,
  type Infer,
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
import { EMAIL_KINDS, EMAIL_PLACEHOLDERS } from "./wire.ts"

/** Admin roles, from most to least privileged. */
export const ADMIN_ROLES = ["owner", "admin", "developer", "viewer"] as const
export type AdminRole = (typeof ADMIN_ROLES)[number]

/** A Studio administrator, from `canopy.admin_users`. */
export interface Admin {
  readonly id: string
  readonly email: string
  readonly name?: string
  readonly role: AdminRole
  /** Whether an authenticator app is set up. */
  readonly totp?: boolean
  /** Set for accounts created with a temporary password; every other request is refused until changed. */
  readonly mustChangePassword?: boolean
  readonly disabled?: boolean
  readonly createdAt?: string
  readonly lastLoginAt?: string
}

/** Whether the server still waits for its first owner. */
export interface SetupStatus {
  readonly required: boolean
}

/** An authenticator app enrollment: the base32 secret and the `otpauth:` URI for a QR code. */
export interface TotpEnrollment {
  readonly secret: string
  readonly uri: string
}

/** The owner created by the setup claim and the TOTP enrollment they must confirm at their first login. */
export interface SetupResult {
  readonly admin: Admin
  readonly totp: TotpEnrollment
}

export interface Session {
  readonly admin: Admin
  readonly csrfToken?: string
  readonly expiresAt?: string
}

export interface Me {
  readonly admin: Admin
  readonly csrfToken?: string
  readonly environment?: "development" | "production"
  readonly version?: string
  readonly expiresAt?: string
  /** The admin API permissions of this admin's role in this environment, as the server computes them. */
  readonly grants?: readonly string[]
}

/** A new admin and the temporary password, shown once. */
export interface CreatedAdmin {
  readonly admin: Admin
  readonly password: string
}

export const collectionSchema = object({
  name: string,
  /** False for collections that only have policies so far. */
  exists: optional(boolean),
  exposed: boolean,
  realtime: boolean,
  estimatedCount: optional(number),
  policyVersion: optional(nullable(number)),
  policyCount: optional(number),
  images: optional(literal("on", "off", "unknown")),
})
export type CollectionSummary = Infer<typeof collectionSchema>

export const fieldInfoSchema = object({
  path: string,
  types: array(string),
  frequency: optional(number),
})
export type FieldInfo = Infer<typeof fieldInfoSchema>

export const indexSchema = object({
  name: string,
  keys: record(unknown),
  unique: optional(boolean),
})
export const collectionStatsSchema = object({
  count: number,
  size: optional(number),
  avgDocumentSize: optional(number),
  indexes: optional(array(indexSchema)),
})
export type CollectionStats = Infer<typeof collectionStatsSchema>

/** Who a request is evaluated as: roles plus JWT claims. Absent means the `service` role. */
export interface ViewAs {
  readonly roles: readonly string[]
  readonly claims: Readonly<Record<string, unknown>>
  /** A label for the UI and the audit log, for example the user's email. */
  readonly label?: string
}

export const documentsPageSchema = object({
  documents: array(json),
  /** Not reported by the server, which pages with `next` instead. */
  total: optional(number),
  hiddenFields: optional(array(string)),
  /** Viewers see fields hidden by policy as `"[masked]"`. */
  masked: optional(boolean),
  /** A cursor for the next page; absent on the last page. */
  next: optional(string),
})
export type DocumentsPage = Infer<typeof documentsPageSchema>

/** One policy as stored, with `using` and `check` as canonical EJSON strings. */
export const storedPolicySchema = object({
  name: string,
  kind: literal("permissive", "restrictive"),
  ops: array(literal("read", "insert", "update", "delete")),
  roles: array(string),
  using: optional(string),
  check: optional(string),
})
export type StoredPolicy = Infer<typeof storedPolicySchema>

const fieldRuleSchema = object({ only: optional(array(string)), omit: optional(array(string)) })
const fieldRulesSchema = record(fieldRuleSchema)

export const storedCollectionSchema = object({
  _id: string,
  version: number,
  exposed: boolean,
  realtime: boolean,
  policies: array(storedPolicySchema),
  fields: optional(
    nullable(
      object({
        read: optional(fieldRulesSchema),
        write: optional(fieldRulesSchema),
        update: optional(fieldRulesSchema),
      }),
    ),
  ),
  immutable: optional(array(string)),
  hash: optional(string),
  updatedAt: optional(unknown),
  updatedBy: optional(string),
})
export type StoredCollection = Infer<typeof storedCollectionSchema>

export const validationSchema = object({
  ok: boolean,
  errors: array(object({ path: optional(string), message: string })),
  lint: optional(
    array(
      object({
        rule: string,
        severity: literal("error", "warn", "info"),
        policy: optional(string),
        message: string,
      }),
    ),
  ),
})
export type ValidationResult = Infer<typeof validationSchema>

export const explainedPolicySchema = object({
  name: string,
  kind: literal("permissive", "restrictive"),
  applies: boolean,
  reason: string,
  resolved: optional(json),
})

export const SIMULATED_OPERATIONS = ["read", "insert", "update", "delete"] as const
export type SimulatedOperation = (typeof SIMULATED_OPERATIONS)[number]

export const simulationSchema = object({
  allowed: boolean,
  roles: optional(array(string)),
  /** The explain trace of the check clause, for insert and update. */
  checkPolicies: optional(array(explainedPolicySchema)),
  bypass: optional(boolean),
  count: optional(number),
  documents: optional(array(json)),
  effectiveFilter: nullable(json),
  hiddenFields: optional(array(string)),
  policies: array(explainedPolicySchema),
  violations: optional(array(string)),
})
export type Simulation = Infer<typeof simulationSchema>

export const historyEntrySchema = object({
  version: number,
  hash: optional(string),
  updatedAt: optional(string),
  updatedBy: optional(string),
  comment: optional(string),
  policies: storedCollectionSchema,
})
export type HistoryEntry = Infer<typeof historyEntrySchema>

/** An app user of built in auth. Anonymous users have no email. */
export interface AppUser {
  readonly id: string
  readonly email?: string
  readonly emailVerified: boolean
  readonly name?: string
  readonly isAnonymous: boolean
  readonly roles: readonly string[]
  /** Written only by admins and `service`, so policies may rely on it. */
  readonly appMetadata: Readonly<Record<string, unknown>>
  /** Editable by the user; never use it in policies. */
  readonly userMetadata: Readonly<Record<string, unknown>>
  readonly banned: boolean
  readonly banReason?: string
  readonly banExpires?: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** A session of an app user. The session token is never shown. */
export interface AppUserSession {
  readonly id: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly expiresAt: string
  readonly ipAddress?: string
  readonly userAgent?: string
}

/** The fields an admin may change on an app user. */
export interface AppUserPatch {
  readonly email?: string
  readonly name?: string
  readonly emailVerified?: boolean
  readonly roles?: readonly string[]
  readonly appMetadata?: Readonly<Record<string, unknown>>
  readonly userMetadata?: Readonly<Record<string, unknown>>
  readonly password?: string
}

export const providersSchema = object({
  mode: literal("builtin", "external"),
  providers: array(
    object({
      id: string,
      enabled: boolean,
      clientId: optional(string),
      issuer: optional(string),
      configured: optional(boolean),
    }),
  ),
  external: optional(
    object({
      issuer: optional(string),
      audience: optional(string),
      jwksUrl: optional(string),
      algorithms: optional(array(string)),
    }),
  ),
})
export type Providers = Infer<typeof providersSchema>

/** The emails built in auth sends. */
export type EmailKind = (typeof EMAIL_KINDS)[number]
export type EmailPlaceholder = (typeof EMAIL_PLACEHOLDERS)[number]

/** An editable email template: text with `{{placeholder}}` markers. */
export interface EmailTemplateBody {
  readonly subject: string
  readonly text: string
  readonly html?: string
}

/** The template in force for one kind. */
export interface EmailTemplate extends EmailTemplateBody {
  readonly kind: EmailKind
  /** `default` until edited in Studio. */
  readonly source: "default" | "studio"
  readonly placeholders: readonly EmailPlaceholder[]
  /** Placeholders the body must keep, such as the link. */
  readonly required: readonly EmailPlaceholder[]
}

/** One saved version of the email templates. */
export interface EmailTemplateVersion {
  readonly version: number
  readonly kind?: EmailKind
  readonly change: "update" | "reset"
  readonly templates: Readonly<Partial<Record<EmailKind, EmailTemplateBody>>>
  readonly updatedAt: string
  readonly updatedBy: string
  readonly comment?: string
}

/** A signing key of built in auth. */
export interface SigningKey {
  readonly kid: string
  readonly alg: string
  readonly state: "standby" | "active" | "retired" | "revoked"
  readonly createdAt: string
  readonly expiresAt: string
  readonly revokedAt?: string
}

export const apiKeySchema = object({
  id: string,
  kind: literal("publishable", "secret"),
  name: string,
  prefix: string,
  key: optional(nullable(string)),
  createdAt: optional(date),
  createdBy: optional(string),
  lastUsedAt: optional(nullable(date)),
  revokedAt: optional(nullable(date)),
  revokedBy: optional(nullable(string)),
})
export type ApiKey = Infer<typeof apiKeySchema>
export const createdKeySchema = object({ key: string, info: apiKeySchema })
export type CreatedKey = Infer<typeof createdKeySchema>

export const lagPointSchema = object({ t: number, lagMs: number, eventsPerSecond: number })
export const realtimeStatsSchema = object({
  connections: number,
  sessions: optional(number),
  subscriptions: number,
  observers: record(number),
  subjects: optional(number),
  policyVersion: optional(string),
  streamPosition: optional(unknown),
  collections: optional(array(string)),
  lagMs: optional(number),
  eventsPerSecond: optional(number),
  history: optional(array(lagPointSchema)),
})
export type RealtimeStats = Infer<typeof realtimeStatsSchema>

export const connectionSchema = object({
  sid: string,
  subject: string,
  roles: array(string),
  keyId: optional(nullable(string)),
  connected: boolean,
  transport: optional(string),
  openedAt: date,
  tokenExpiresAt: optional(nullable(date)),
  subscriptions: array(object({ id: string, coll: string, observer: string })),
  documents: number,
  queuedBytes: number,
  lastSeq: number,
})
export type RealtimeConnection = Infer<typeof connectionSchema>
export const connectionsSchema = object({ connections: array(connectionSchema) })

export const observerSchema = object({
  key: string,
  coll: string,
  type: string,
  status: string,
  subscribers: number,
  filter: json,
  sort: optional(nullable(record(number))),
  limit: optional(nullable(number)),
  candidatesPerEvent: optional(number),
  matchCostMicros: optional(number),
})
export type RealtimeObserver = Infer<typeof observerSchema>
export const observersSchema = object({ observers: array(observerSchema) })

export const EVENT_OPERATIONS = ["insert", "update", "replace", "delete"] as const
export const eventSummaryShape = {
  id: string,
  ct: unknown,
  wallTime: optional(nullable(date)),
  coll: string,
  op: string,
  docId: unknown,
  fields: optional(nullable(array(string))),
}
export const realtimeEventSchema = object(eventSummaryShape)
export type RealtimeEvent = Infer<typeof realtimeEventSchema>

export const OBSERVER_OUTCOMES = ["entered", "updated", "left", "unmatched"] as const
export const traceSchema = object({
  ...eventSummaryShape,
  policyVersion: optional(string),
  candidates: array(
    object({
      observer: string,
      type: string,
      outcome: literal(...OBSERVER_OUTCOMES),
      subscribers: array(object({ sid: string, sub: string, subject: string })),
      dls: optional(unknown),
    }),
  ),
})
type ParsedTrace = Infer<typeof traceSchema>

/** One policy in a DLS explanation: whether it matched, and the claim that made it drop out. */
export interface DeniedPolicy {
  readonly name: string
  readonly kind: "permissive" | "restrictive"
  readonly matched: boolean
  readonly issue?: { readonly variable: string; readonly kind: string }
  readonly fields: readonly string[]
}

/**
 * Why DLS kept an event from an observer whose own filter matched it: no read policy for the
 * subscribers' roles, no permissive policy matched, or a restrictive one failed. Viewers get
 * `{ masked: true }` when the policies read fields hidden from them.
 */
export type DlsDenial =
  | {
      readonly reason: "no_grant" | "no_permissive" | "restrictive"
      readonly responsible: readonly string[]
      readonly policies: readonly DeniedPolicy[]
    }
  | { readonly masked: true }

/** The route of one event through the engine. */
export type EventTrace = Omit<ParsedTrace, "candidates"> & {
  readonly candidates: readonly (Omit<ParsedTrace["candidates"][number], "dls"> & {
    readonly dls?: DlsDenial
  })[]
}

const deniedPolicySchema = object({
  name: string,
  kind: literal("permissive", "restrictive"),
  matched: boolean,
  issue: optional(object({ variable: string, kind: string })),
  fields: array(string),
})
const dlsDenialSchema = object({
  reason: literal("no_grant", "no_permissive", "restrictive"),
  responsible: array(string),
  policies: array(deniedPolicySchema),
})

/** Validates the `dls` field of a trace candidate. */
export function parseDls(value: unknown, path: string): DlsDenial | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "object" && (value as { masked?: unknown }).masked === true) {
    return { masked: true }
  }
  return dlsDenialSchema.parse(value, path)
}

export const CHECK_STATUSES = ["ok", "info", "warn", "error"] as const
export type CheckStatus = (typeof CHECK_STATUSES)[number]
export const doctorSchema = object({
  status: optional(literal(...CHECK_STATUSES)),
  checks: array(
    object({
      id: string,
      title: string,
      status: literal(...CHECK_STATUSES),
      message: string,
      fix: optional(string),
      docs: optional(string),
    }),
  ),
  topology: optional(string),
  serverVersion: optional(string),
})
export type DoctorReport = Infer<typeof doctorSchema>
export type DoctorCheck = DoctorReport["checks"][number]

export const REQUEST_SURFACES = ["rest", "auth", "admin", "realtime"] as const
export type RequestSurface = (typeof REQUEST_SURFACES)[number]

/** One sampled request. Only the path is kept: no query string, headers or bodies. */
export const logEntrySchema = object({
  id: string,
  at: date,
  surface: literal(...REQUEST_SURFACES),
  method: string,
  path: string,
  status: number,
  durationMs: number,
  ip: optional(string),
  requestId: optional(string),
})
export type LogEntry = Infer<typeof logEntrySchema>

/** A page of the request log, with the sampling settings in force. */
export interface LogsPage {
  readonly entries: readonly LogEntry[]
  readonly next?: string
  readonly sampleRate: number
  readonly retentionDays: number
}

export const auditEntrySchema = object({
  id: string,
  outcome: optional(literal("ok", "denied", "failed")),
  at: string,
  actor: string,
  action: string,
  target: optional(string),
  comment: optional(string),
  diff: optional(unknown),
  impersonating: optional(string),
})
export type AuditEntry = Infer<typeof auditEntrySchema>
/** Settings changed at runtime; everything else comes from the config file. */
export interface Settings {
  /** How many days audit entries are kept; `null` keeps them forever. */
  readonly auditRetentionDays: number | null
  /** The share of requests written to the request log, from 0 (off) to 1 (all); 5xx are kept above 0. */
  readonly requestLogSampleRate: number
  /** How many days request log entries are kept, 1 to 90. */
  readonly requestLogRetentionDays: number
  /** Addresses and CIDR ranges that may reach `/admin` and `/studio`; empty allows every address. */
  readonly adminAllowlist: readonly string[]
}

export const realtimeTokenSchema = object({ token: string, publishableKey: string })

export { EMAIL_KINDS, EMAIL_PLACEHOLDERS }
