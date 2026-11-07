import type { Infer } from "./schema.ts"
import {
  EMAIL_KINDS,
  EMAIL_PLACEHOLDERS,
  OBSERVER_OUTCOMES,
  type wireApiKey,
  type wireConnection,
  type wireCreatedKey,
  type wireObserver,
  type wireProviders,
  type wireRealtimeEvent,
  type wireRealtimeStats,
  type wireStoredCollection,
  type wireTrace,
} from "./wire.ts"

/**
 * The types Studio works with. Responses are validated by the schemas of `wire.ts`; where the server's
 * shape is the one Studio uses, the type is inferred from that schema, otherwise the client converts it.
 */

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

/** A collection with its policy summary. */
export interface CollectionSummary {
  readonly name: string
  /** False for collections that only have policies so far. */
  readonly exists?: boolean
  readonly exposed: boolean
  readonly realtime: boolean
  readonly estimatedCount?: number
  readonly policyVersion?: number | null
  readonly policyCount?: number
  readonly images?: "on" | "off" | "unknown"
}

/** One field of a collection's schema, with the BSON types seen there. */
export interface FieldInfo {
  readonly path: string
  readonly types: string[]
  readonly frequency?: number
}

export interface CollectionStats {
  readonly count: number
  readonly size?: number
  readonly avgDocumentSize?: number
  readonly indexes?: {
    readonly name: string
    readonly keys: Record<string, unknown>
    readonly unique?: boolean
  }[]
}

/** Who a request is evaluated as: roles plus JWT claims. Absent means the `service` role. */
export interface ViewAs {
  readonly roles: readonly string[]
  readonly claims: Readonly<Record<string, unknown>>
  /** A label for the UI and the audit log, for example the user's email. */
  readonly label?: string
}

export interface DocumentsPage {
  readonly documents: Record<string, unknown>[]
  /** Not reported by the server, which pages with `next` instead. */
  readonly total?: number
  readonly hiddenFields?: string[]
  /** Viewers see fields hidden by policy as `"[masked]"`. */
  readonly masked?: boolean
  /** A cursor for the next page; absent on the last page. */
  readonly next?: string
}

/** A collection's policies as stored, with `using` and `check` as canonical EJSON strings. */
export type StoredCollection = Infer<typeof wireStoredCollection>
export type StoredPolicy = StoredCollection["policies"][number]

export interface ValidationResult {
  readonly ok: boolean
  readonly errors: { readonly path?: string; readonly message: string }[]
  readonly lint?: {
    readonly rule: string
    readonly severity: "error" | "warn" | "info"
    readonly policy?: string
    readonly message: string
  }[]
}

/** How one policy took part in a decision. */
export interface ExplainedPolicy {
  readonly name: string
  readonly kind: "permissive" | "restrictive"
  readonly applies: boolean
  readonly reason: string
  readonly resolved?: Record<string, unknown>
}

export const SIMULATED_OPERATIONS = ["read", "insert", "update", "delete"] as const
export type SimulatedOperation = (typeof SIMULATED_OPERATIONS)[number]

export interface Simulation {
  readonly allowed: boolean
  readonly roles?: string[]
  /** The explain trace of the check clause, for insert and update. */
  readonly checkPolicies?: ExplainedPolicy[]
  readonly bypass?: boolean
  readonly count?: number
  readonly documents?: Record<string, unknown>[]
  readonly effectiveFilter: Record<string, unknown> | null
  readonly hiddenFields?: string[]
  readonly policies: ExplainedPolicy[]
  readonly violations?: string[]
}

export interface HistoryEntry {
  readonly version: number
  readonly hash?: string
  readonly updatedAt?: string
  readonly updatedBy?: string
  readonly comment?: string
  readonly policies: StoredCollection
}

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

/** The sign in methods of the server, without secrets. */
export type Providers = Infer<typeof wireProviders>

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

export type ApiKey = Infer<typeof wireApiKey>
export type CreatedKey = Infer<typeof wireCreatedKey>

export type RealtimeStats = Infer<typeof wireRealtimeStats>
export type RealtimeConnection = Infer<typeof wireConnection>
export type RealtimeObserver = Infer<typeof wireObserver>

export const EVENT_OPERATIONS = ["insert", "update", "replace", "delete"] as const
export type RealtimeEvent = Infer<typeof wireRealtimeEvent>

type ParsedTrace = Infer<typeof wireTrace>

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

export const CHECK_STATUSES = ["ok", "info", "warn", "error"] as const
export type CheckStatus = (typeof CHECK_STATUSES)[number]

export interface DoctorCheck {
  readonly id: string
  readonly title: string
  readonly status: CheckStatus
  readonly message: string
  readonly fix?: string
  readonly docs?: string
}

export interface DoctorReport {
  readonly status?: CheckStatus
  readonly checks: DoctorCheck[]
  readonly topology?: string
  readonly serverVersion?: string
}

export const REQUEST_SURFACES = ["rest", "auth", "admin", "realtime"] as const
export type RequestSurface = (typeof REQUEST_SURFACES)[number]

/** One sampled request. Only the path is kept: no query string, headers or bodies. */
export interface LogEntry {
  readonly id: string
  readonly at: string
  readonly surface: RequestSurface
  readonly method: string
  readonly path: string
  readonly status: number
  readonly durationMs: number
  readonly ip?: string
  readonly requestId?: string
}

/** A page of the request log, with the sampling settings in force. */
export interface LogsPage {
  readonly entries: readonly LogEntry[]
  readonly next?: string
  readonly sampleRate: number
  readonly retentionDays: number
}

export interface AuditEntry {
  readonly id: string
  readonly outcome?: "ok" | "denied" | "failed"
  readonly at: string
  readonly actor: string
  readonly action: string
  readonly target?: string
  readonly comment?: string
  readonly diff?: unknown
  readonly impersonating?: string
}

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

export { EMAIL_KINDS, EMAIL_PLACEHOLDERS, OBSERVER_OUTCOMES }
