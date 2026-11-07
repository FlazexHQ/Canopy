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

/** Admin roles, from most to least privileged. */
export const ADMIN_ROLES = ["owner", "admin", "developer", "viewer"] as const
export type AdminRole = (typeof ADMIN_ROLES)[number]

export const adminSchema = object({
  id: string,
  email: string,
  role: literal(...ADMIN_ROLES),
  totp: optional(boolean),
})
export type Admin = Infer<typeof adminSchema>

export const setupStatusSchema = object({ required: boolean })
export type SetupStatus = Infer<typeof setupStatusSchema>

export const sessionSchema = object({
  admin: adminSchema,
  csrfToken: optional(string),
})
export type Session = Infer<typeof sessionSchema>

export const meSchema = object({
  admin: adminSchema,
  csrfToken: optional(string),
  environment: optional(literal("development", "production")),
  version: optional(string),
})
export type Me = Infer<typeof meSchema>

export const collectionSchema = object({
  name: string,
  exposed: boolean,
  realtime: boolean,
  estimatedCount: optional(number),
  policyVersion: optional(nullable(number)),
  policyCount: optional(number),
  images: optional(literal("on", "off", "unknown")),
})
export type CollectionSummary = Infer<typeof collectionSchema>
export const collectionsSchema = object({ collections: array(collectionSchema) })

export const fieldInfoSchema = object({
  path: string,
  types: array(string),
  frequency: optional(number),
})
export type FieldInfo = Infer<typeof fieldInfoSchema>
export const collectionSchemaSchema = object({ fields: array(fieldInfoSchema) })

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
  total: optional(number),
  hiddenFields: optional(array(string)),
})
export type DocumentsPage = Infer<typeof documentsPageSchema>
export const documentResultSchema = object({ document: nullable(json) })
export const bulkInsertResultSchema = object({ inserted: number })
export const deleteResultSchema = object({ deleted: number })

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

export const policyDocumentSchema = object({ published: nullable(storedCollectionSchema) })

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
export type ExplainedPolicy = Infer<typeof explainedPolicySchema>

export const SIMULATED_OPERATIONS = ["read", "insert", "update", "delete"] as const
export type SimulatedOperation = (typeof SIMULATED_OPERATIONS)[number]

export const simulationSchema = object({
  allowed: boolean,
  bypass: optional(boolean),
  count: optional(number),
  documents: optional(array(json)),
  effectiveFilter: nullable(json),
  hiddenFields: optional(array(string)),
  policies: array(explainedPolicySchema),
  violations: optional(array(string)),
})
export type Simulation = Infer<typeof simulationSchema>

export const publishResultSchema = object({ version: number, hash: optional(string) })

export const historyEntrySchema = object({
  version: number,
  hash: optional(string),
  updatedAt: optional(string),
  updatedBy: optional(string),
  comment: optional(string),
  policies: storedCollectionSchema,
})
export type HistoryEntry = Infer<typeof historyEntrySchema>
export const historySchema = object({ versions: array(historyEntrySchema) })

export const appUserSchema = object({
  id: string,
  email: optional(nullable(string)),
  name: optional(nullable(string)),
  createdAt: optional(string),
  lastSignInAt: optional(nullable(string)),
  banned: optional(boolean),
  roles: optional(array(string)),
  appMetadata: optional(json),
  userMetadata: optional(json),
  identities: optional(array(object({ provider: string, subject: optional(string) }))),
  sessions: optional(
    array(object({ id: string, createdAt: optional(string), userAgent: optional(string) })),
  ),
})
export type AppUser = Infer<typeof appUserSchema>
export const usersPageSchema = object({
  users: array(appUserSchema),
  nextCursor: optional(nullable(string)),
})

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

export const templatesSchema = object({
  templates: array(
    object({ id: string, subject: string, body: string, updatedAt: optional(string) }),
  ),
})
export type EmailTemplate = Infer<typeof templatesSchema>["templates"][number]

export const signingKeysSchema = object({
  keys: array(
    object({
      kid: string,
      alg: string,
      status: literal("active", "standby", "retired"),
      createdAt: optional(string),
    }),
  ),
})
export type SigningKey = Infer<typeof signingKeysSchema>["keys"][number]
export const rotateResultSchema = object({ kid: string })

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
export const apiKeysSchema = object({ keys: array(apiKeySchema) })
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
      filteredOut: optional(
        array(
          object({
            sid: string,
            subject: string,
            policy: optional(string),
            reason: optional(string),
          }),
        ),
      ),
    }),
  ),
})
export type EventTrace = Infer<typeof traceSchema>

export const CHECK_STATUSES = ["ok", "info", "warn", "error"] as const
export type CheckStatus = (typeof CHECK_STATUSES)[number]
export const doctorSchema = object({
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

export const logEntrySchema = object({
  at: string,
  requestId: optional(string),
  method: string,
  path: string,
  status: number,
  durationMs: number,
  role: optional(string),
  collection: optional(string),
  operation: optional(string),
  code: optional(string),
  policy: optional(string),
})
export type LogEntry = Infer<typeof logEntrySchema>
export const logsSchema = object({
  entries: array(logEntrySchema),
  nextCursor: optional(nullable(string)),
  summary: optional(object({ requestsPerSecond: number, errorRate: number })),
})
export type LogsPage = Infer<typeof logsSchema>

export const auditEntrySchema = object({
  id: string,
  at: string,
  actor: string,
  action: string,
  target: optional(string),
  comment: optional(string),
  diff: optional(unknown),
  impersonating: optional(string),
})
export type AuditEntry = Infer<typeof auditEntrySchema>
export const auditSchema = object({
  entries: array(auditEntrySchema),
  nextCursor: optional(nullable(string)),
})

export const settingsSchema = object({
  publicUrl: optional(nullable(string)),
  corsOrigins: array(string),
  limits: optional(record(number)),
  realtime: optional(
    object({
      mode: optional(string),
      collections: optional(
        array(object({ name: string, images: literal("on", "off", "unknown") })),
      ),
    }),
  ),
  admins: optional(array(adminSchema)),
})
export type Settings = Infer<typeof settingsSchema>

export const realtimeTokenSchema = object({ token: string, publishableKey: string })
