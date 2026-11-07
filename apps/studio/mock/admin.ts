import { applyUpdate, compileFilter, compileSort } from "@canopy/matcher"
import {
  type CollectionPolicies,
  canAccess,
  createPolicySet,
  fieldAccess,
  fromStored,
  hashCollection,
  lintPolicies,
  PolicyEngine,
  projectReadable,
  type RequestContext,
  toFilter,
  validateCollectionPolicies,
} from "@canopy/policy"
import { evaluateInMemory } from "@canopy/policy/testing"
import {
  CanopyError,
  canonicalString,
  decode,
  ErrorCode,
  encode,
  httpStatusOf,
  isDocument,
  parse,
  stringify,
} from "@canopy/protocol"
import type { AdminRole, EmailKind } from "../src/api/contract.ts"
import { EMAIL_KINDS } from "../src/api/wire.ts"
import { ADMIN_PERMISSIONS, type AdminPermission, can } from "../src/app/permissions.ts"
import { addressAllowed, isAllowRule } from "../src/lib/ip.ts"
import {
  type SeedConnection,
  type SeedLogEntry,
  type SeedSession,
  type SeedUser,
  seedCollections,
  seedConnections,
  seedLogs,
  seedSessions,
  seedUsers,
} from "./seed.ts"

/**
 * Carries the session token in component tests, where the DOM environment drops `Cookie` and `Set-Cookie`
 * like a browser does. Browsers use the cookie.
 */
export const TEST_SESSION_HEADER = "x-canopy-mock-session"

/** The session and CSRF cookies of the server. */
export const SESSION_COOKIE = "__Host-canopy_admin"
export const CSRF_COOKIE = "__Host-canopy_csrf"

/** An admin account of the mock. `totp: true` means an authenticator is enrolled and confirmed. */
export interface MockAdminAccount {
  readonly id: string
  readonly email: string
  readonly role: AdminRole
  readonly password: string
  readonly totp?: boolean
  readonly name?: string
  readonly mustChangePassword?: boolean
}

/** A policy document to publish at start, in stored form. */
export interface StoredPolicyInput {
  readonly _id: string
  readonly exposed: boolean
  readonly realtime: boolean
  readonly policies: readonly {
    readonly name: string
    readonly kind: "permissive" | "restrictive"
    readonly ops: readonly ("read" | "insert" | "update" | "delete")[]
    readonly roles: readonly string[]
    readonly using?: string
    readonly check?: string
  }[]
  readonly fields?: Readonly<Record<string, unknown>> | null
  readonly immutable?: readonly string[]
}

/** Options of {@link createMockAdmin}. */
export interface MockAdminOptions {
  readonly environment?: "development" | "production"
  /** The one time setup token; it must start with `canopy_setup_` like the server's. */
  readonly setupToken?: string
  /** Admin accounts that exist from the start; without an owner, Studio shows the first run claim. */
  readonly admins?: readonly MockAdminAccount[]
  /** Whether built in auth is configured (`/users`, `/auth/keys`, `/auth/templates`). @default true */
  readonly builtinAuth?: boolean
  /** Whether realtime is on (`/realtime/*`). @default true */
  readonly realtime?: boolean
  /**
   * Serves endpoints Studio has screens for but the server does not offer yet (`/logs`,
   * `/auth/providers`, the danger zone). Off by default, so the mock answers 404 like the server.
   */
  readonly extras?: boolean
  /** `false` turns the Data API off, so there is no OpenAPI document. */
  readonly rest?: boolean
  /** Publishes a policy for these collections at start. */
  readonly policies?: readonly StoredPolicyInput[]
  /** Interval of synthetic realtime events in the tail; 0 turns them off. */
  readonly tailIntervalMs?: number
  /** The peer address the mock sees for every request, for the admin allowlist. @default "127.0.0.1" */
  readonly clientIp?: string
  /** The authenticator code the mock accepts. @default "123456" */
  readonly totpCode?: string
  readonly now?: () => number
}

interface AdminState {
  id: string
  email: string
  name: string | undefined
  role: AdminRole
  password: string
  totp: { readonly secret: string; confirmed: boolean } | undefined
  disabled: boolean
  mustChangePassword: boolean
  createdAt: Date
  lastLoginAt: Date | undefined
}

interface SessionState {
  readonly token: string
  readonly csrf: string
  readonly adminId: string
  readonly expiresAt: Date
}

interface StoredDoc {
  readonly _id: string
  readonly version: number
  readonly exposed: boolean
  readonly realtime: boolean
  readonly policies: StoredPolicyInput["policies"]
  readonly fields: Readonly<Record<string, unknown>> | null
  readonly immutable: readonly string[]
  readonly hash: string
  readonly updatedAt: Date
  readonly updatedBy: string
}

interface VersionDoc {
  readonly version: number
  readonly hash: string
  readonly document: StoredDoc
  readonly publishedAt: Date
  readonly publishedBy: string
  readonly comment?: string
  readonly rollbackOf?: number
}

interface ApiKeyState {
  readonly id: string
  readonly kind: "publishable" | "secret"
  readonly name: string
  readonly prefix: string
  readonly key: string | undefined
  readonly createdAt: Date
  readonly createdBy: string
  lastUsedAt: Date | undefined
  revokedAt: Date | undefined
  revokedBy: string | undefined
}

interface AuditState {
  readonly _id: { readonly $oid: string }
  readonly at: Date
  readonly action: string
  readonly actor: {
    readonly type: string
    readonly id: string
    readonly email?: string
    readonly role?: string
  }
  readonly outcome: "ok" | "denied" | "failed"
  readonly target?: Readonly<Record<string, unknown>>
  readonly diff?: unknown
  readonly comment?: string
  readonly details?: Readonly<Record<string, unknown>>
}

type AuditInput = Omit<AuditState, "_id" | "at" | "outcome" | "actor"> & {
  readonly outcome?: AuditState["outcome"]
}

interface SigningKeyState {
  readonly kid: string
  readonly alg: string
  state: "standby" | "active" | "retired" | "revoked"
  readonly createdAt: Date
  readonly expiresAt: Date
  revokedAt: Date | undefined
}

interface TemplateBody {
  readonly subject: string
  readonly text: string
  readonly html?: string
}

interface EventState {
  readonly id: string
  readonly ct: { readonly $timestamp: { readonly t: number; readonly i: number } }
  readonly wallTime: Date
  readonly coll: string
  readonly op: string
  readonly docId: unknown
  readonly fields: readonly string[] | undefined
}

/** The in memory state, exposed for assertions in tests. */
export interface MockState {
  readonly admins: AdminState[]
  readonly sessions: Map<string, SessionState>
  readonly collections: Map<string, Record<string, unknown>[]>
  readonly published: Map<string, StoredDoc>
  readonly history: Map<string, VersionDoc[]>
  readonly apiKeys: ApiKeyState[]
  readonly audit: AuditState[]
  readonly logs: SeedLogEntry[]
  readonly events: EventState[]
  readonly connections: SeedConnection[]
  readonly users: SeedUser[]
  readonly userSessions: SeedSession[]
  readonly signingKeys: SigningKeyState[]
  readonly templates: {
    version: number
    current: Partial<Record<EmailKind, TemplateBody>>
    history: {
      version: number
      kind: EmailKind
      change: "update" | "reset"
      templates: Partial<Record<EmailKind, TemplateBody>>
      updatedAt: Date
      updatedBy: string
      comment?: string
    }[]
  }
  settings: {
    auditRetentionDays: number | null
    requestLogSampleRate: number
    requestLogRetentionDays: number
    adminAllowlist: string[]
  }
  setupToken: string | undefined
  /** Emails "sent" through the log transport, newest last. */
  readonly mail: { readonly to: string; readonly subject: string; readonly text: string }[]
}

/** The mock: a `fetch` style handler for `/admin/v1/*` and `/rest/v1/openapi.json`. */
export interface MockAdmin {
  readonly state: MockState
  fetch(request: Request): Promise<Response>
  /** Stops the synthetic event timer. */
  close(): void
}

const BASE_ROLES = new Set(["anon", "authenticated"])
const MASK = "[masked]"
const MIN_PASSWORD = 12
const TOTP_SECRET = "JBSWY3DPEHPK3PXP"

const fail = (code: ErrorCode, message: string, details?: Record<string, unknown>): never => {
  throw new CanopyError(code, message, details === undefined ? {} : { details })
}

function respond(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(encode(body)), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  })
}

function noContent(headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 204, headers })
}

function problem(error: CanopyError, instance: string): Response {
  const status = httpStatusOf(error.code)
  return new Response(
    JSON.stringify(
      encode({
        type: `urn:canopy:error:${error.code.slice("CANOPY_".length).toLowerCase().replaceAll("_", "-")}`,
        title: error.code,
        status,
        code: error.code,
        detail: error.code === ErrorCode.Internal ? "Internal error" : error.message,
        instance,
        requestId: "req_mock",
        ...(error.details === undefined ? {} : { details: error.details }),
      }),
    ),
    { status, headers: { "content-type": "application/problem+json" } },
  )
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (!isDocument(value)) return fail(ErrorCode.ValidationFailed, `${what} must be an object`)
  return value
}

function ejsonParam(url: URL, name: string): unknown {
  const text = url.searchParams.get(name)
  if (text === null) return undefined
  try {
    return parse(text)
  } catch {
    return fail(ErrorCode.ValidationFailed, `${name} must be EJSON`)
  }
}

function sortOf(text: string | null): Record<string, 1 | -1> | undefined {
  if (text === null || text === "") return undefined
  const sort: Record<string, 1 | -1> = {}
  for (const part of text.split(",")) {
    if (part === "") continue
    if (part.startsWith("-")) sort[part.slice(1)] = -1
    else sort[part] = 1
  }
  return sort
}

function fieldsOf(text: string | null): Record<string, 0 | 1> | undefined {
  if (text === null || text === "") return undefined
  const fields: Record<string, 0 | 1> = {}
  for (const part of text.split(",")) {
    if (part.startsWith("-")) fields[part.slice(1)] = 0
    else if (part !== "") fields[part] = 1
  }
  return fields
}

function project(
  document: Record<string, unknown>,
  fields: Record<string, 0 | 1> | undefined,
): Record<string, unknown> {
  if (fields === undefined) return document
  const include = Object.values(fields).includes(1)
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(document)) {
    const listed = Object.hasOwn(fields, key)
    if (key === "_id" || (include ? listed : !listed)) out[key] = value
  }
  return out
}

function mask(
  original: Record<string, unknown>,
  visible: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(original)) {
    const shown = visible[key]
    if (!Object.hasOwn(visible, key)) out[key] = MASK
    else if (isDocument(value) && isDocument(shown)) out[key] = mask(value, shown)
    else out[key] = shown
  }
  return out
}

function shapeOf(value: unknown): Record<string, unknown> {
  if (value === null) return { kind: "scalar", type: "null" }
  if (Array.isArray(value)) {
    return { kind: "array", of: value.length === 0 ? { kind: "any" } : shapeOf(value[0]) }
  }
  if (typeof value === "string") return { kind: "scalar", type: "string" }
  if (typeof value === "boolean") return { kind: "scalar", type: "bool" }
  if (typeof value === "number") {
    return { kind: "scalar", type: Number.isInteger(value) ? "int" : "double" }
  }
  const encoded = encode(value)
  if (isDocument(encoded)) {
    if ("$oid" in encoded) return { kind: "scalar", type: "objectId" }
    if ("$date" in encoded) return { kind: "scalar", type: "date" }
    if ("$numberDecimal" in encoded) return { kind: "scalar", type: "decimal" }
    if ("$numberLong" in encoded) return { kind: "scalar", type: "long" }
  }
  if (isDocument(value)) return inferShape([value])
  return { kind: "any" }
}

/** The inferred shape of `@canopy/schema` for a set of documents. */
function inferShape(documents: readonly Record<string, unknown>[]): Record<string, unknown> {
  const fields: Record<string, { shape: Record<string, unknown>; optional: boolean }> = {}
  for (const document of documents) {
    for (const [key, value] of Object.entries(document)) {
      fields[key] ??= { shape: shapeOf(value), optional: false }
    }
  }
  for (const [key, field] of Object.entries(fields)) {
    field.optional = documents.some((document) => !Object.hasOwn(document, key))
  }
  return { kind: "object", fields }
}

const IGNORE = "If you did not ask for this, you can ignore this email."

/** The default templates of built in auth, as editable text. */
const TEMPLATE_DEFAULTS: Readonly<Record<EmailKind, TemplateBody>> = {
  verification: {
    subject: "Confirm your email for {{appName}}",
    text: `Follow this link to confirm your email address for {{appName}}:\n\n{{url}}\n\n${IGNORE}\n`,
  },
  magic_link: {
    subject: "Your sign in link for {{appName}}",
    text: `Follow this link to sign in to {{appName}}:\n\n{{url}}\n\n${IGNORE}\n`,
  },
  otp: {
    subject: "Your {{appName}} code is {{otp}}",
    text: `Your one time code for {{appName}} is {{otp}}. It expires in a few minutes.\n\n${IGNORE}\n`,
  },
  reset_password: {
    subject: "Reset your password for {{appName}}",
    text: `Follow this link to choose a new password for {{appName}}:\n\n{{url}}\n\n${IGNORE}\n`,
  },
  invite: {
    subject: "You are invited to {{appName}}",
    text: "You have been invited to {{appName}}. Follow this link to accept and sign in:\n\n{{url}}\n",
  },
  email_change: {
    subject: "Confirm your email change for {{appName}}",
    text: `Follow this link to confirm changing your {{appName}} email to {{newEmail}}:\n\n{{url}}\n\n${IGNORE}\n`,
  },
}

const TEMPLATE_AVAILABLE: Readonly<Record<EmailKind, readonly string[]>> = {
  verification: ["appName", "email", "url"],
  magic_link: ["appName", "email", "url"],
  otp: ["appName", "email", "otp"],
  reset_password: ["appName", "email", "url"],
  invite: ["appName", "email", "url"],
  email_change: ["appName", "email", "url", "newEmail"],
}

const TEMPLATE_REQUIRED: Readonly<Record<EmailKind, readonly string[]>> = {
  verification: ["url"],
  magic_link: ["url"],
  otp: ["otp"],
  reset_password: ["url"],
  invite: ["url"],
  email_change: ["url", "newEmail"],
}

/** The server's preview data. */
const PREVIEW: Readonly<Record<string, string>> = {
  appName: "Canopy",
  email: "ada@example.com",
  url: "https://app.example.com/auth/v1/verify?token=preview",
  otp: "482913",
  newEmail: "ada.lovelace@example.com",
}

const MARKER = /\{\{\s*([A-Za-z]+)\s*\}\}/g

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function markers(text: string): string[] {
  return [...text.matchAll(MARKER)].map((match) => match[1] ?? "")
}

/** The server's rules: known placeholders the kind has values for, the required ones, no script. */
function validateTemplate(kind: EmailKind, input: TemplateBody): TemplateBody {
  const problems: string[] = []
  const subject = input.subject.trim()
  if (subject === "") problems.push("the subject is empty")
  if (/[\r\n]/.test(subject)) problems.push("the subject must be a single line")
  if (input.text.trim() === "") problems.push("the text body is empty")
  const html = input.html === undefined || input.html.trim() === "" ? undefined : input.html
  if (
    html !== undefined &&
    (/<\s*script\b/i.test(html) || /\bjavascript:/i.test(html) || /\son[a-z]+\s*=/i.test(html))
  ) {
    problems.push("the HTML body may not contain scripts, javascript: links or event handlers")
  }
  for (const name of new Set([subject, input.text, html ?? ""].flatMap(markers))) {
    if (!Object.hasOwn(PREVIEW, name)) problems.push(`{{${name}}} is not a placeholder`)
    else if (!TEMPLATE_AVAILABLE[kind].includes(name)) {
      problems.push(`{{${name}}} has no value in ${kind} emails`)
    }
  }
  const bodies = new Set([...markers(input.text), ...markers(html ?? "")])
  for (const name of TEMPLATE_REQUIRED[kind]) {
    if (!bodies.has(name)) problems.push(`the body must contain {{${name}}}`)
  }
  if (problems.length > 0) {
    fail(ErrorCode.ValidationFailed, `The ${kind} template is not valid: ${problems.join("; ")}`, {
      kind,
      problems,
    })
  }
  return { subject, text: input.text, ...(html === undefined ? {} : { html }) }
}

function renderTemplate(
  template: TemplateBody,
  values: Readonly<Record<string, string>>,
): TemplateBody {
  const fill = (text: string, html: boolean) =>
    text.replace(MARKER, (_match, name: string) => {
      const value = values[name] ?? ""
      return html ? escapeHtml(value) : value
    })
  return {
    subject: fill(template.subject, false).replace(/[\r\n]+/g, " "),
    text: fill(template.text, false),
    ...(template.html === undefined ? {} : { html: fill(template.html, true) }),
  }
}

interface Context {
  readonly request: Request
  readonly url: URL
  readonly params: Readonly<Record<string, string>>
  readonly admin: AdminState
  readonly session: SessionState
  body(): Promise<unknown>
  audit(entry: AuditInput): void
}

interface PublicContext {
  readonly request: Request
  readonly url: URL
  readonly params: Readonly<Record<string, string>>
  body(): Promise<unknown>
}

interface Route {
  readonly method: string
  readonly path: readonly string[]
  readonly permission: AdminPermission | "session" | "public"
  readonly action: string | undefined
  readonly selfAudited: boolean
  readonly handler: (context: Context) => Promise<Response> | Response
}

/**
 * An in memory implementation of the server's admin API (`@canopy/server`, `/admin/v1`) that speaks its
 * wire format: relaxed EJSON, lists wrapped in `{ data }`, Problem Details errors, the session and CSRF
 * cookies, owner TOTP, the permission table and the audit rules (successful mutations and RBAC denials).
 * Policies, view as and simulations run on the real `@canopy/policy` engine. It backs component tests,
 * `vite --mode mock` and the Playwright suite.
 */
export function createMockAdmin(options: MockAdminOptions = {}): MockAdmin {
  const now = options.now ?? Date.now
  const date = () => new Date(now())
  const environment = options.environment ?? "development"
  const production = environment === "production"
  const totpCode = options.totpCode ?? "123456"
  const builtinAuth = options.builtinAuth !== false
  const realtimeOn = options.realtime !== false
  const extras = options.extras === true
  const clientIp = options.clientIp ?? "127.0.0.1"

  const state: MockState = {
    admins: (options.admins ?? []).map((admin) => ({
      id: admin.id,
      email: admin.email,
      name: admin.name,
      role: admin.role,
      password: admin.password,
      totp: admin.totp === true ? { secret: TOTP_SECRET, confirmed: true } : undefined,
      disabled: false,
      mustChangePassword: admin.mustChangePassword === true,
      createdAt: new Date(now() - 30 * 86_400_000),
      lastLoginAt: undefined,
    })),
    sessions: new Map(),
    collections: new Map(
      Object.entries(seedCollections()).map(([name, documents]) => [
        name,
        documents.map((document) => decode(document) as Record<string, unknown>),
      ]),
    ),
    published: new Map(),
    history: new Map(),
    apiKeys: [
      {
        id: "key_pk_1",
        kind: "publishable",
        name: "Default publishable key",
        prefix: "8f2KQmTf",
        key: "canopy_pk_8f2KQmTfE1c9xZ0aW3bYdL5nR7sVuH2j",
        createdAt: new Date(now() - 86_400_000 * 9),
        createdBy: "system",
        lastUsedAt: new Date(now() - 60_000),
        revokedAt: undefined,
        revokedBy: undefined,
      },
      {
        id: "key_sk_1",
        kind: "secret",
        name: "Backend",
        prefix: "Zq81Lm2x",
        key: undefined,
        createdAt: new Date(now() - 86_400_000 * 9),
        createdBy: "system",
        lastUsedAt: new Date(now() - 3_600_000),
        revokedAt: undefined,
        revokedBy: undefined,
      },
    ],
    audit: [],
    logs: seedLogs(now()),
    events: [],
    connections: seedConnections(now()),
    users: seedUsers(now()),
    userSessions: seedSessions(now()),
    signingKeys: [
      {
        kid: "k_2026_10",
        alg: "EdDSA",
        state: "active",
        createdAt: new Date(now() - 86_400_000 * 30),
        expiresAt: new Date(now() + 86_400_000 * 60),
        revokedAt: undefined,
      },
      {
        kid: "k_2026_11",
        alg: "EdDSA",
        state: "standby",
        createdAt: new Date(now() - 86_400_000),
        expiresAt: new Date(now() + 86_400_000 * 90),
        revokedAt: undefined,
      },
    ],
    templates: { version: 0, current: {}, history: [] },
    settings: {
      auditRetentionDays: null,
      requestLogSampleRate: 0.01,
      requestLogRetentionDays: 7,
      adminAllowlist: [],
    },
    setupToken: (options.admins ?? []).some((admin) => admin.role === "owner")
      ? undefined
      : (options.setupToken ?? "canopy_setup_0000"),
    mail: [],
  }

  const record = (entry: AuditInput & { readonly actor: AuditState["actor"] }) => {
    state.audit.unshift({ _id: { $oid: randomHex(12) }, at: date(), outcome: "ok", ...entry })
  }

  const engine = (override?: CollectionPolicies): PolicyEngine => {
    const definitions = [...state.published.values()]
      .filter((doc) => override === undefined || doc._id !== override.collection)
      .map((doc) => fromStored(doc))
    if (override !== undefined) definitions.push(override)
    return new PolicyEngine(createPolicySet(definitions))
  }

  const definitionFrom = (collection: string, input: unknown): CollectionPolicies => {
    const body = asObject(input, "definition")
    const policies = Array.isArray(body["policies"]) ? body["policies"] : []
    const clause = (value: unknown) =>
      value === undefined ? undefined : typeof value === "string" ? value : stringify(value)
    try {
      const definition = fromStored({
        _id: collection,
        exposed: body["exposed"] === true,
        realtime: body["realtime"] === true,
        policies: policies.map((raw) => {
          const policy = asObject(raw, "policy")
          return {
            ...policy,
            ...(policy["using"] === undefined ? {} : { using: clause(policy["using"]) }),
            ...(policy["check"] === undefined ? {} : { check: clause(policy["check"]) }),
          }
        }),
        ...(isDocument(body["fields"]) ? { fields: body["fields"] } : {}),
        ...(Array.isArray(body["immutable"]) ? { immutable: body["immutable"] } : {}),
      })
      validateCollectionPolicies(definition)
      return definition
    } catch (error: unknown) {
      if (error instanceof CanopyError && error.code === ErrorCode.ValidationFailed) throw error
      return fail(
        ErrorCode.ValidationFailed,
        error instanceof Error ? error.message : "Invalid policies",
      )
    }
  }

  const storedOf = (definition: CollectionPolicies, version: number, by: string): StoredDoc => ({
    _id: definition.collection,
    version,
    exposed: definition.exposed,
    realtime: definition.realtime,
    policies: definition.policies.map((policy) => ({
      name: policy.name,
      kind: policy.kind,
      ops: [...policy.ops],
      roles: [...policy.roles],
      ...(policy.using === undefined ? {} : { using: canonicalString(policy.using) }),
      ...(policy.check === undefined ? {} : { check: canonicalString(policy.check) }),
    })),
    fields: (definition.fields ?? null) as Record<string, unknown> | null,
    immutable: definition.immutable ?? [],
    hash: hashCollection(definition),
    updatedAt: date(),
    updatedBy: by,
  })

  const publish = (
    definition: CollectionPolicies,
    expectedVersion: number,
    by: string,
    comment?: string,
    rollbackOf?: number,
  ) => {
    const current = state.published.get(definition.collection)?.version ?? 0
    if (current !== expectedVersion) {
      fail(
        ErrorCode.Conflict,
        `The policies of ${definition.collection} are at version ${current}, not ${expectedVersion}`,
        { currentVersion: current },
      )
    }
    const stored = storedOf(definition, current + 1, by)
    state.published.set(definition.collection, stored)
    const history = state.history.get(definition.collection) ?? []
    history.unshift({
      version: stored.version,
      hash: stored.hash,
      document: stored,
      publishedAt: stored.updatedAt,
      publishedBy: by,
      ...(comment === undefined || comment === "" ? {} : { comment }),
      ...(rollbackOf === undefined ? {} : { rollbackOf }),
    })
    state.history.set(definition.collection, history)
    return { stored, findings: lintPolicies([definition]) }
  }

  for (const policy of options.policies ?? []) {
    publish(definitionFrom(policy._id, policy), 0, "system")
  }

  const impersonate = (
    input: unknown,
  ): { context: RequestContext; subject: string; as: unknown } => {
    const as = asObject(input, "as")
    const roles = new Set<string>([
      ...(typeof as["role"] === "string" ? [as["role"]] : []),
      ...(Array.isArray(as["roles"]) ? as["roles"].map(String) : []),
    ])
    let claims: Record<string, unknown> | null = null
    if (as["user"] !== undefined || as["claims"] !== undefined) {
      claims = {
        ...(isDocument(as["claims"]) ? as["claims"] : {}),
        ...(typeof as["user"] === "string" ? { sub: as["user"] } : {}),
      }
      roles.add("authenticated")
    }
    if (roles.size === 0) fail(ErrorCode.ValidationFailed, "as needs a role, a user or claims")
    if (roles.has("service")) {
      fail(
        ErrorCode.ValidationFailed,
        "Impersonating service is not allowed; act as service directly",
      )
    }
    if (roles.has("anon") && roles.size > 1) {
      fail(ErrorCode.ValidationFailed, "anon cannot be combined with other roles")
    }
    const subject = typeof claims?.["sub"] === "string" ? claims["sub"] : [...roles].join(",")
    return { context: { roles, claims, now: date() }, subject, as }
  }

  const tailListeners = new Set<(event: EventState) => void>()
  const emit = (coll: string, op: string, docId: unknown, fields?: readonly string[]) => {
    const event: EventState = {
      id: `evt_${randomHex(8)}`,
      ct: { $timestamp: { t: Math.floor(now() / 1000), i: state.events.length + 1 } },
      wallTime: date(),
      coll,
      op,
      docId,
      fields,
    }
    state.events.push(event)
    if (state.events.length > 500) state.events.shift()
    for (const listener of tailListeners) listener(event)
  }

  const timer =
    (options.tailIntervalMs ?? 0) > 0
      ? setInterval(() => {
          const todos = state.collections.get("todos") ?? []
          const document = todos[Math.floor(Math.random() * Math.max(todos.length, 1))]
          if (document !== undefined) emit("todos", "update", document["_id"], ["done"])
        }, options.tailIntervalMs)
      : undefined

  const publicAdmin = (admin: AdminState) => ({
    id: admin.id,
    email: admin.email,
    ...(admin.name === undefined ? {} : { name: admin.name }),
    role: admin.role,
    mustChangePassword: admin.mustChangePassword,
    totpEnabled: admin.totp?.confirmed === true,
    disabled: admin.disabled,
    createdAt: admin.createdAt,
    ...(admin.lastLoginAt === undefined ? {} : { lastLoginAt: admin.lastLoginAt }),
  })

  const enrollment = (email: string, secret: string) => ({
    secret,
    uri: `otpauth://totp/Canopy:${encodeURIComponent(email)}?secret=${secret}&issuer=Canopy`,
  })

  const cookieOf = (request: Request, name: string): string | undefined => {
    for (const part of (request.headers.get("cookie") ?? "").split(";")) {
      const index = part.indexOf("=")
      if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim()
    }
    return undefined
  }

  const routes: Route[] = []
  const route = (
    method: string,
    path: string,
    permission: Route["permission"],
    handler: Route["handler"],
    action?: string,
    selfAudited = false,
  ) => {
    routes.push({
      method,
      path: path.split("/").filter((part) => part !== ""),
      permission,
      handler,
      action,
      selfAudited,
    })
  }
  const publicRoute = (
    method: string,
    path: string,
    handler: (context: PublicContext) => Promise<Response> | Response,
  ) => route(method, path, "public", handler, undefined, true)

  // Session

  publicRoute("GET", "setup", () =>
    respond({ claimed: state.admins.some((admin) => admin.role === "owner") }),
  )

  publicRoute("POST", "setup", async (context) => {
    const body = asObject(await context.body(), "body")
    const token = String(body["token"] ?? "")
    const valid =
      state.setupToken !== undefined &&
      token === state.setupToken &&
      token.startsWith("canopy_setup_")
    const claimed = state.admins.some((admin) => admin.role === "owner")
    if (!valid || claimed) {
      record({ action: "setup.claim", actor: { type: "system", id: "setup" }, outcome: "failed" })
      if (valid) fail(ErrorCode.Conflict, "This server already has an owner")
      fail(
        ErrorCode.Unauthorized,
        "The setup token is not valid; use the one printed in the server logs",
      )
    }
    const password = String(body["password"] ?? "")
    if (password.length < MIN_PASSWORD) {
      fail(ErrorCode.ValidationFailed, `The password must have at least ${MIN_PASSWORD} characters`)
    }
    const email = String(body["email"] ?? "")
      .trim()
      .toLowerCase()
    const owner: AdminState = {
      id: `adm_${randomHex(8)}`,
      email,
      name: typeof body["name"] === "string" ? body["name"] : undefined,
      role: "owner",
      password,
      totp: { secret: TOTP_SECRET, confirmed: false },
      disabled: false,
      mustChangePassword: false,
      createdAt: date(),
      lastLoginAt: undefined,
    }
    state.admins.push(owner)
    state.setupToken = undefined
    record({
      action: "setup.claim",
      actor: { type: "admin", id: owner.id, email, role: "owner" },
    })
    return respond({ user: publicAdmin(owner), totp: enrollment(email, TOTP_SECRET) }, 201)
  })

  publicRoute("POST", "login", async (context) => {
    const body = asObject(await context.body(), "body")
    const email = String(body["email"] ?? "")
      .trim()
      .toLowerCase()
    const admin = state.admins.find((candidate) => candidate.email === email)
    const failed = (reason: string): never => {
      record({
        action: "session.login",
        actor: { type: "admin", id: admin?.id ?? "unknown", email },
        outcome: "failed",
        details: { reason },
      })
      return fail(ErrorCode.Unauthorized, "Invalid email or password")
    }
    if (admin === undefined || admin.password !== body["password"] || admin.disabled) {
      return failed("password")
    }
    const needsTotp = admin.role === "owner" || admin.totp?.confirmed === true
    if (needsTotp) {
      const pending = admin.totp !== undefined && !admin.totp.confirmed
      if (admin.totp === undefined || (pending && body["totp"] === undefined)) {
        admin.totp ??= { secret: TOTP_SECRET, confirmed: false }
        fail(ErrorCode.Unauthorized, "Set up an authenticator app, then log in with its code", {
          totpRequired: true,
          totpEnrollment: enrollment(email, admin.totp.secret),
        })
      }
      if (body["totp"] === undefined) {
        fail(ErrorCode.Unauthorized, "Enter the code of your authenticator app", {
          totpRequired: true,
        })
      }
      if (body["totp"] !== totpCode) failed("totp")
      if (admin.totp !== undefined) admin.totp.confirmed = true
    }
    const session: SessionState = {
      token: `canopy_admin_${randomHex(16)}`,
      csrf: randomHex(16),
      adminId: admin.id,
      expiresAt: new Date(now() + 12 * 3_600_000),
    }
    state.sessions.set(session.token, session)
    admin.lastLoginAt = date()
    record({
      action: "session.login",
      actor: { type: "admin", id: admin.id, email, role: admin.role },
    })
    const bearer = body["transport"] === "bearer"
    const response = respond(
      {
        user: publicAdmin(admin),
        csrfToken: session.csrf,
        expiresAt: session.expiresAt,
        ...(bearer ? { token: session.token } : {}),
      },
      200,
      { [TEST_SESSION_HEADER]: session.token },
    )
    if (!bearer) {
      response.headers.append(
        "set-cookie",
        `${SESSION_COOKIE}=${session.token}; Path=/; SameSite=Strict; HttpOnly`,
      )
      response.headers.append(
        "set-cookie",
        `${CSRF_COOKIE}=${session.csrf}; Path=/; SameSite=Strict`,
      )
    }
    return response
  })

  route(
    "POST",
    "logout",
    "session",
    (context) => {
      state.sessions.delete(context.session.token)
      const response = noContent({ [TEST_SESSION_HEADER]: "" })
      response.headers.append("set-cookie", `${SESSION_COOKIE}=; Path=/; Max-Age=0`)
      response.headers.append("set-cookie", `${CSRF_COOKIE}=; Path=/; Max-Age=0`)
      return response
    },
    "session.logout",
  )

  route("GET", "me", "session", (context) =>
    respond({
      user: publicAdmin(context.admin),
      environment,
      expiresAt: context.session.expiresAt,
      permissions: ADMIN_PERMISSIONS.filter((permission) =>
        can(context.admin.role, permission, environment),
      ),
    }),
  )

  route(
    "POST",
    "me/password",
    "session",
    async (context) => {
      const body = asObject(await context.body(), "body")
      if (body["current"] !== context.admin.password) {
        fail(ErrorCode.Unauthorized, "The current password is wrong")
      }
      const next = String(body["next"] ?? "")
      if (next.length < MIN_PASSWORD) {
        fail(
          ErrorCode.ValidationFailed,
          `The password must have at least ${MIN_PASSWORD} characters`,
        )
      }
      context.admin.password = next
      context.admin.mustChangePassword = false
      return noContent()
    },
    "admin.password.change",
  )

  route(
    "POST",
    "me/totp",
    "session",
    (context) => {
      context.admin.totp = { secret: "KRSXG5CTMVRXEZLU", confirmed: false }
      return respond(enrollment(context.admin.email, "KRSXG5CTMVRXEZLU"), 201)
    },
    "admin.totp.enroll",
  )

  route(
    "POST",
    "me/totp/confirm",
    "session",
    async (context) => {
      const body = asObject(await context.body(), "body")
      const totp = context.admin.totp
      if (body["code"] !== totpCode || totp === undefined) {
        return fail(ErrorCode.Unauthorized, "The code is wrong")
      }
      totp.confirmed = true
      return noContent()
    },
    "admin.totp.confirm",
  )

  // Admins

  route("GET", "admins", "admins.read", () => respond({ data: state.admins.map(publicAdmin) }))

  route(
    "POST",
    "admins",
    "admins.manage",
    async (context) => {
      const body = asObject(await context.body(), "body")
      const role = String(body["role"] ?? "") as AdminRole
      if (role === "owner" && !can(context.admin.role, "admins.manageOwners", environment)) {
        fail(ErrorCode.Forbidden, "Only owners may create owners")
      }
      const email = String(body["email"] ?? "")
        .trim()
        .toLowerCase()
      if (state.admins.some((admin) => admin.email === email)) {
        fail(ErrorCode.Conflict, "An admin with this email exists")
      }
      const password = randomHex(10)
      const admin: AdminState = {
        id: `adm_${randomHex(8)}`,
        email,
        name: typeof body["name"] === "string" ? body["name"] : undefined,
        role,
        password,
        totp: undefined,
        disabled: false,
        mustChangePassword: true,
        createdAt: date(),
        lastLoginAt: undefined,
      }
      state.admins.push(admin)
      return respond({ user: publicAdmin(admin), password }, 201)
    },
    "admin.create",
  )

  const adminById = (context: Context): AdminState => {
    const admin = state.admins.find((candidate) => candidate.id === context.params["id"])
    if (admin === undefined) return fail(ErrorCode.NotFound, "No such admin")
    if (admin.role === "owner" && !can(context.admin.role, "admins.manageOwners", environment)) {
      fail(ErrorCode.Forbidden, "Only owners may change owners")
    }
    return admin
  }

  route(
    "PATCH",
    "admins/:id",
    "admins.manage",
    async (context) => {
      const admin = adminById(context)
      const body = asObject(await context.body(), "body")
      if (typeof body["role"] === "string") admin.role = body["role"] as AdminRole
      if (typeof body["disabled"] === "boolean") admin.disabled = body["disabled"]
      if (typeof body["name"] === "string") admin.name = body["name"]
      return respond({ user: publicAdmin(admin) })
    },
    "admin.update",
  )

  route(
    "POST",
    "admins/:id/reset-totp",
    "admins.manage",
    (context) => {
      const admin = adminById(context)
      admin.totp = undefined
      return respond({ user: publicAdmin(admin) })
    },
    "admin.totp.reset",
  )

  route(
    "DELETE",
    "admins/:id",
    "admins.manage",
    (context) => {
      const admin = adminById(context)
      if (admin.id === context.admin.id) {
        fail(ErrorCode.ValidationFailed, "You cannot remove yourself")
      }
      state.admins.splice(state.admins.indexOf(admin), 1)
      return noContent()
    },
    "admin.remove",
  )

  // Collections

  const collectionOf = (context: Context): string => {
    const name = context.params["collection"] ?? ""
    if (!/^[A-Za-z_][\w.-]{0,119}$/.test(name) || name.startsWith("system.")) {
      fail(ErrorCode.ValidationFailed, `${name} is not a collection name`)
    }
    return name
  }

  route("GET", "collections", "collections.read", () => {
    const current = engine()
    const names = new Set([...state.collections.keys(), ...state.published.keys()])
    return respond({
      data: [...names].sort().map((name) => {
        const def = current.collection(name)
        const hash = current.set.hashes.get(name)
        return {
          name,
          type: state.collections.has(name) ? "collection" : "missing",
          exists: state.collections.has(name),
          exposed: def?.exposed === true,
          realtime: def?.realtime === true,
          policies: def?.policies.length ?? 0,
          version: state.published.get(name)?.version ?? 0,
          ...(hash === undefined ? {} : { hash }),
        }
      }),
    })
  })

  route(
    "PATCH",
    "collections/:collection",
    "collections.write",
    async (context) => {
      const name = collectionOf(context)
      const body = asObject(await context.body(), "body")
      const comment = typeof body["comment"] === "string" ? body["comment"] : undefined
      if (production && (comment === undefined || comment.trim() === "")) {
        fail(ErrorCode.ValidationFailed, "Publishing in production needs a comment")
      }
      if (typeof body["expectedVersion"] !== "number") {
        fail(ErrorCode.ValidationFailed, "body.expectedVersion must be an integer")
      }
      const current = engine().collection(name) ?? {
        collection: name,
        exposed: false,
        realtime: false,
        policies: [],
      }
      const result = publish(
        {
          ...current,
          ...(typeof body["exposed"] === "boolean" ? { exposed: body["exposed"] } : {}),
          ...(typeof body["realtime"] === "boolean" ? { realtime: body["realtime"] } : {}),
        },
        Number(body["expectedVersion"]),
        context.admin.id,
        comment,
      )
      context.audit({
        action: "collection.update",
        target: { collection: name },
        diff: {
          before: { exposed: current.exposed, realtime: current.realtime },
          after: { exposed: result.stored.exposed, realtime: result.stored.realtime },
        },
        ...(comment === undefined ? {} : { comment }),
      })
      return respond(result)
    },
    "collection.update",
    true,
  )

  route("GET", "collections/:collection/schema", "collections.read", (context) => {
    const name = collectionOf(context)
    const documents = state.collections.get(name)
    return respond({
      collection: name,
      schema:
        documents === undefined || documents.length === 0
          ? null
          : { name, shape: inferShape(documents), source: "inferred" },
    })
  })

  route("GET", "collections/:collection/stats", "collections.read", (context) => {
    const name = collectionOf(context)
    const documents = state.collections.get(name)
    if (documents === undefined) {
      return fail(ErrorCode.NotFound, `The collection ${name} does not exist`)
    }
    const size = documents.reduce((total, document) => total + stringify(document).length, 0)
    return respond({
      collection: name,
      documents: documents.length,
      size,
      averageDocumentSize: documents.length === 0 ? 0 : Math.round(size / documents.length),
      storageSize: size,
      totalIndexSize: 4096,
      indexes: [{ name: "_id_", key: { _id: 1 }, unique: false }],
    })
  })

  // Documents

  route("GET", "collections/:collection/documents", "documents.read", (context) => {
    const name = collectionOf(context)
    const asParam = ejsonParam(context.url, "as")
    const filterParam = ejsonParam(context.url, "filter") ?? {}
    if (!isDocument(filterParam)) return fail(ErrorCode.InvalidQuery, "filter must be a document")
    const sort = sortOf(context.url.searchParams.get("sort"))
    const fields = fieldsOf(context.url.searchParams.get("fields"))
    const limit = Math.min(Number(context.url.searchParams.get("limit") ?? "50") || 50, 1000)
    const skip = Math.min(Number(context.url.searchParams.get("skip") ?? "0") || 0, 10_000)
    const current = engine()
    let effective: Record<string, unknown> = filterParam
    let readable = (document: Record<string, unknown>) => document
    let impersonated: unknown
    if (asParam !== undefined) {
      if (!can(context.admin.role, "documents.viewAs", environment)) {
        fail(ErrorCode.Forbidden, `The ${context.admin.role} role may not do this`)
      }
      const as = impersonate(asParam)
      impersonated = as.as
      effective = toFilter(current.effectiveRead(name, filterParam, as.context))
      const access = current.readable(name, as.context)
      readable = (document) => projectReadable(access, document)
    }
    let matched: Record<string, unknown>[]
    try {
      const compiled = compileFilter(effective)
      matched = (state.collections.get(name) ?? []).filter((document) => compiled.matches(document))
    } catch (error: unknown) {
      return fail(ErrorCode.InvalidQuery, error instanceof Error ? error.message : "Invalid filter")
    }
    if (sort !== undefined) matched = [...matched].sort(compileSort(sort))
    let docs = matched
      .slice(skip, skip + limit)
      .map((document) => project(readable(document), fields))
    let masked = false
    if (asParam === undefined && context.admin.role === "viewer") {
      const access = current.readable(name, {
        roles: new Set(["authenticated"]),
        claims: {},
        now: date(),
      })
      docs = docs.map((document) => mask(document, projectReadable(access, document)))
      masked = true
    }
    if (impersonated !== undefined) {
      context.audit({
        action: "documents.viewAs",
        target: { collection: name },
        details: { as: impersonated, query: Object.fromEntries(context.url.searchParams) },
      })
    }
    return respond({
      data: docs,
      page: { limit, next: skip + limit < matched.length ? `skip:${skip + limit}` : null },
      ct: { $timestamp: { t: Math.floor(now() / 1000), i: 1 } },
      ...(masked ? { masked: true } : {}),
    })
  })

  const idParam = (context: Context): unknown => {
    const segment = context.params["id"] ?? ""
    if (segment.startsWith("{") || segment.startsWith('"')) {
      try {
        return parse(segment)
      } catch {
        return fail(ErrorCode.InvalidQuery, "The id is not valid Extended JSON")
      }
    }
    return /^[0-9a-f]{24}$/i.test(segment) ? decode({ $oid: segment }) : segment
  }

  const sameId = (a: unknown, b: unknown) => canonicalString(a) === canonicalString(b)

  const writeDocument = async (
    context: Context,
    op: "insert" | "update" | "replace" | "delete",
  ): Promise<Response> => {
    const name = collectionOf(context)
    if (production && context.request.headers.get("x-canopy-confirm") !== name) {
      fail(
        ErrorCode.Forbidden,
        `Data edits in production need typed confirmation: send x-canopy-confirm: ${name}`,
        { reason: "confirmation" },
      )
    }
    const body = op === "delete" ? undefined : await context.body()
    const asParam = ejsonParam(context.url, "as")
    let reason: string | undefined
    let as: ReturnType<typeof impersonate> | undefined
    if (asParam !== undefined) {
      if (!can(context.admin.role, "documents.writeAs", environment)) {
        fail(ErrorCode.Forbidden, `The ${context.admin.role} role may not do this`)
      }
      reason = context.url.searchParams.get("reason")?.trim()
      if (reason === undefined || reason === "") {
        fail(ErrorCode.ValidationFailed, "Writing as another caller needs a reason")
      }
      as = impersonate(asParam)
    }
    const documents = state.collections.get(name) ?? []
    state.collections.set(name, documents)
    const allowed = (
      action: "insert" | "update" | "delete",
      doc: Record<string, unknown>,
      update?: Record<string, unknown>,
    ): boolean => {
      if (as === undefined) return true
      const outcome = evaluateInMemory(
        engine(),
        {
          suite: "studio",
          collection: name,
          actor: { label: as.subject, roles: [...as.context.roles], claims: as.context.claims },
          action,
          doc,
          ...(update === undefined ? {} : { update }),
          expected: true,
        },
        date(),
      )
      if (outcome.allowed) return true
      if (outcome.reason.startsWith("no policy") || outcome.reason.includes("not exposed")) {
        fail(ErrorCode.Forbidden, `No policy grants ${action} on ${name}`)
      }
      if (outcome.reason.startsWith("not a target")) return false
      return fail(ErrorCode.PolicyViolation, `The write breaks the policies: ${outcome.reason}`)
    }
    const none = { data: null, matched: 0, modified: 0, deleted: 0, insertedIds: [] }
    let result: Record<string, unknown> = none
    let before: Record<string, unknown> | null = null
    let after: Record<string, unknown> | null = null
    let ids: unknown[] = []
    if (op === "insert") {
      const doc = decode(asObject(body, "The document")) as Record<string, unknown>
      const withId =
        doc["_id"] === undefined ? { _id: decode({ $oid: randomHex(12) }), ...doc } : doc
      allowed("insert", withId)
      if (documents.some((existing) => sameId(existing["_id"], withId["_id"]))) {
        fail(ErrorCode.DuplicateKey, "A document with this _id exists")
      }
      documents.push(withId)
      emit(name, "insert", withId["_id"])
      after = withId
      ids = [withId["_id"]]
      result = { ...none, data: withId, insertedIds: ids }
    } else {
      const id = idParam(context)
      const index = documents.findIndex((existing) => sameId(existing["_id"], id))
      const existing = documents[index]
      if (existing !== undefined && op === "delete") {
        if (allowed("delete", existing)) {
          documents.splice(index, 1)
          emit(name, "delete", existing["_id"])
          before = existing
          ids = [existing["_id"]]
          result = { ...none, matched: 1, deleted: 1 }
        }
      } else if (existing !== undefined) {
        let next: Record<string, unknown>
        let update: Record<string, unknown>
        if (op === "replace") {
          const replacement = decode(asObject(body, "The document")) as Record<string, unknown>
          if (replacement["_id"] !== undefined && !sameId(replacement["_id"], existing["_id"])) {
            fail(ErrorCode.InvalidQuery, "The _id of a document cannot change")
          }
          const { _id: _ignored, ...rest } = replacement
          next = { _id: existing["_id"], ...rest }
          update = { $set: rest }
        } else {
          update = decode(asObject(body, "The update")) as Record<string, unknown>
          try {
            next = applyUpdate(existing, update)
          } catch (error: unknown) {
            return fail(
              ErrorCode.InvalidQuery,
              error instanceof Error ? error.message : "Invalid update",
            )
          }
        }
        if (allowed("update", existing, update)) {
          documents[index] = next
          emit(
            name,
            "update",
            next["_id"],
            Object.keys(next).filter((key) => key !== "_id"),
          )
          before = existing
          after = next
          ids = [next["_id"]]
          result = { ...none, data: next, matched: 1, modified: 1 }
        }
      }
    }
    const action = `documents.${op}`
    context.audit({
      action: as === undefined ? action : `${action}As`,
      target: { collection: name, ids },
      diff: { before, after },
      ...(reason === undefined ? {} : { comment: reason }),
      ...(as === undefined ? {} : { details: { as: as.as } }),
    })
    return respond(
      { ...result, ct: { $timestamp: { t: Math.floor(now() / 1000), i: 2 } } },
      op === "insert" ? 201 : 200,
    )
  }

  for (const [method, path, op] of [
    ["POST", "collections/:collection/documents", "insert"],
    ["PATCH", "collections/:collection/documents/:id", "update"],
    ["PUT", "collections/:collection/documents/:id", "replace"],
    ["DELETE", "collections/:collection/documents/:id", "delete"],
  ] as const) {
    route(
      method,
      path,
      "documents.write",
      (context) => writeDocument(context, op),
      `documents.${op}`,
      true,
    )
  }

  // Policies

  route("GET", "policies/:collection", "policies.read", (context) => {
    const name = collectionOf(context)
    const stored = state.published.get(name)
    const current = engine()
    const active = current.collection(name)
    return respond({
      collection: name,
      stored: stored ?? null,
      version: stored?.version ?? 0,
      active: current.set.hashes.get(name) ?? null,
      findings: active === undefined ? [] : lintPolicies([active]),
      writable: true,
    })
  })

  route("POST", "policies/:collection/validate", "policies.simulate", async (context) => {
    const name = collectionOf(context)
    const body = asObject(await context.body(), "body")
    const definition = definitionFrom(name, body["definition"])
    const findings = lintPolicies([definition])
    return respond({
      valid: findings.every((finding) => finding.severity !== "error"),
      hash: hashCollection(definition),
      findings,
    })
  })

  route("POST", "policies/:collection/simulate", "policies.simulate", async (context) => {
    const name = collectionOf(context)
    const body = asObject(await context.body(), "body")
    const simulated =
      body["definition"] === undefined ? engine() : engine(definitionFrom(name, body["definition"]))
    const as = impersonate(body["as"])
    const op = String(body["op"] ?? "")
    if (op !== "read" && op !== "insert" && op !== "update" && op !== "delete") {
      return fail(ErrorCode.ValidationFailed, "op must be read, insert, update or delete")
    }
    const filter =
      body["filter"] === undefined
        ? {}
        : (decode(asObject(body["filter"], "filter")) as Record<string, unknown>)
    const explain = simulated.explain(name, op, as.context, "using")
    const check =
      op === "insert" || op === "update"
        ? simulated.explain(name, op, as.context, "check")
        : undefined
    const granted = simulated.hasGrant(name, op, as.context)
    const documents = state.collections.get(name) ?? []
    let extra: Record<string, unknown> = {}
    if (op === "read" && granted) {
      const compiled = compileFilter(toFilter(simulated.effectiveRead(name, filter, as.context)))
      const matched = documents.filter((document) => compiled.matches(document))
      const access = simulated.readable(name, as.context)
      const limit = typeof body["limit"] === "number" ? body["limit"] : 20
      extra = {
        count: matched.length,
        sample: matched.slice(0, limit).map((document) => projectReadable(access, document)),
      }
    } else if ((op === "update" || op === "delete") && granted) {
      const compiled = compileFilter({
        $and: [filter, toFilter(simulated.target(name, op, as.context))],
      })
      extra = { count: documents.filter((document) => compiled.matches(document)).length }
    }
    return respond({
      allowed: granted,
      op,
      roles: [...as.context.roles].sort(),
      effectiveFilter: { $and: [filter, toFilter(explain.result)] },
      explain,
      ...(check === undefined ? {} : { check }),
      fields: {
        read: simulated.readable(name, as.context),
        ...(op === "insert" || op === "update"
          ? { write: simulated.writable(name, op, as.context) }
          : {}),
      },
      ...extra,
    })
  })

  route(
    "POST",
    "policies/:collection/publish",
    "policies.publish",
    async (context) => {
      const name = collectionOf(context)
      const body = asObject(await context.body(), "body")
      const comment = typeof body["comment"] === "string" ? body["comment"] : undefined
      if (production && (comment === undefined || comment.trim() === "")) {
        fail(ErrorCode.ValidationFailed, "Publishing in production needs a comment")
      }
      if (typeof body["expectedVersion"] !== "number") {
        fail(ErrorCode.ValidationFailed, "body.expectedVersion must be an integer")
      }
      const result = publish(
        definitionFrom(name, body["definition"]),
        Number(body["expectedVersion"]),
        context.admin.id,
        comment,
      )
      context.audit({
        action: "policy.publish",
        target: { collection: name, version: result.stored.version },
        ...(comment === undefined ? {} : { comment }),
      })
      return respond(result)
    },
    "policy.publish",
    true,
  )

  route("GET", "policies/:collection/history", "policies.read", (context) =>
    respond({ data: state.history.get(collectionOf(context)) ?? [] }),
  )

  route(
    "POST",
    "policies/:collection/rollback",
    "policies.publish",
    async (context) => {
      const name = collectionOf(context)
      const body = asObject(await context.body(), "body")
      const comment = typeof body["comment"] === "string" ? body["comment"] : undefined
      if (production && (comment === undefined || comment.trim() === "")) {
        fail(ErrorCode.ValidationFailed, "Publishing in production needs a comment")
      }
      const target = (state.history.get(name) ?? []).find(
        (entry) => entry.version === body["version"],
      )
      if (target === undefined) {
        return fail(ErrorCode.NotFound, `No version ${String(body["version"])} of ${name}`)
      }
      const result = publish(
        fromStored(target.document),
        Number(body["expectedVersion"]),
        context.admin.id,
        comment,
        target.version,
      )
      context.audit({
        action: "policy.rollback",
        target: { collection: name, version: result.stored.version, to: target.version },
        ...(comment === undefined ? {} : { comment }),
      })
      return respond(result)
    },
    "policy.rollback",
    true,
  )

  // API keys

  const keyView = (key: ApiKeyState) => ({
    ...key,
    key: key.kind === "publishable" ? key.key : undefined,
  })

  route("GET", "openapi", "collections.read", () => {
    if (options.rest === false) fail(ErrorCode.NotFound, "The Data API is turned off")
    return openapi()
  })

  route("GET", "api-keys", "keys.read", () => respond({ data: state.apiKeys.map(keyView) }))

  route(
    "POST",
    "api-keys",
    "keys.publishable",
    async (context) => {
      const body = asObject(await context.body(), "body")
      const kind = body["kind"]
      if (kind !== "publishable" && kind !== "secret") {
        return fail(ErrorCode.ValidationFailed, "body.kind must be publishable or secret")
      }
      if (kind === "secret" && !can(context.admin.role, "keys.secret", environment)) {
        fail(ErrorCode.Forbidden, `The ${context.admin.role} role may not do this`)
      }
      const name = String(body["name"] ?? "").trim()
      if (name === "") fail(ErrorCode.ValidationFailed, "body.name must have at least 1 characters")
      const value = `canopy_${kind === "secret" ? "sk" : "pk"}_${randomHex(16)}`
      const info: ApiKeyState = {
        id: `key_${randomHex(8)}`,
        kind,
        name,
        prefix: value.slice(10, 18),
        key: kind === "publishable" ? value : undefined,
        createdAt: date(),
        createdBy: context.admin.id,
        lastUsedAt: undefined,
        revokedAt: undefined,
        revokedBy: undefined,
      }
      state.apiKeys.push(info)
      context.audit({
        action: "key.create",
        target: { keyId: info.id, kind, name, prefix: info.prefix },
      })
      return respond({ key: value, info: keyView(info) }, 201)
    },
    "key.create",
    true,
  )

  route(
    "DELETE",
    "api-keys/:id",
    "keys.publishable",
    (context) => {
      const key = state.apiKeys.find((candidate) => candidate.id === context.params["id"])
      if (key === undefined) return fail(ErrorCode.NotFound, "No such API key")
      if (key.kind === "secret" && !can(context.admin.role, "keys.secret", environment)) {
        fail(ErrorCode.Forbidden, `The ${context.admin.role} role may not do this`)
      }
      key.revokedAt ??= date()
      key.revokedBy ??= context.admin.id
      context.audit({
        action: "key.revoke",
        target: { keyId: key.id, kind: key.kind, name: key.name, prefix: key.prefix },
      })
      return respond(keyView(key))
    },
    "key.revoke",
    true,
  )

  // App users (built in auth)

  const requireAuth = () => {
    if (!builtinAuth) fail(ErrorCode.NotFound, "Built in auth is not configured")
  }
  const userOf = (context: Context): SeedUser => {
    requireAuth()
    const user = state.users.find((candidate) => candidate.id === context.params["id"])
    return user ?? fail(ErrorCode.NotFound, "No such user")
  }
  const replaceUser = (user: SeedUser, patch: Partial<SeedUser>): SeedUser => {
    const next = { ...user, ...patch, updatedAt: date() }
    state.users[state.users.indexOf(user)] = next
    return next
  }
  const checkRoles = (roles: unknown): readonly string[] | undefined => {
    if (roles === undefined) return undefined
    if (!Array.isArray(roles)) return fail(ErrorCode.ValidationFailed, "roles must be an array")
    for (const role of roles) {
      if (typeof role !== "string" || role === "") {
        fail(ErrorCode.ValidationFailed, "roles must be names")
      }
      if (role === "service" || BASE_ROLES.has(String(role))) {
        fail(ErrorCode.ValidationFailed, `The role ${String(role)} cannot be assigned`)
      }
    }
    return roles.map(String)
  }

  route("GET", "users", "users.read", (context) => {
    requireAuth()
    const email = (context.url.searchParams.get("email") ?? "").toLowerCase()
    const limit = Number(context.url.searchParams.get("limit") ?? "50") || 50
    const offset = Number(context.url.searchParams.get("offset") ?? "0") || 0
    const matched = state.users.filter(
      (user) => email === "" || (user.email ?? "").toLowerCase().startsWith(email),
    )
    return respond({ data: matched.slice(offset, offset + limit), total: matched.length })
  })

  const newUser = (input: Record<string, unknown>): SeedUser => {
    const email = String(input["email"] ?? "")
      .trim()
      .toLowerCase()
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) fail(ErrorCode.ValidationFailed, "Enter a valid email")
    if (state.users.some((user) => user.email === email)) {
      fail(ErrorCode.Conflict, "A user with this email exists")
    }
    const user: SeedUser = {
      id: `u_${randomHex(6)}`,
      email,
      emailVerified: input["emailVerified"] === true,
      name: typeof input["name"] === "string" ? input["name"] : undefined,
      isAnonymous: false,
      roles: checkRoles(input["roles"]) ?? [],
      appMetadata: isDocument(input["appMetadata"]) ? input["appMetadata"] : {},
      userMetadata: isDocument(input["userMetadata"]) ? input["userMetadata"] : {},
      banned: false,
      banReason: undefined,
      banExpires: undefined,
      createdAt: date(),
      updatedAt: date(),
    }
    state.users.push(user)
    return user
  }

  const sendMail = (kind: EmailKind, email: string, url: string) => {
    const template = state.templates.current[kind] ?? TEMPLATE_DEFAULTS[kind]
    const rendered = renderTemplate(template, { ...PREVIEW, email, url })
    state.mail.push({ to: email, subject: rendered.subject, text: rendered.text })
  }

  route(
    "POST",
    "users/invite",
    "users.manage",
    async (context) => {
      requireAuth()
      const body = asObject(await context.body(), "body")
      const email = String(body["email"] ?? "")
        .trim()
        .toLowerCase()
      const user = state.users.find((candidate) => candidate.email === email) ?? newUser(body)
      sendMail("invite", email, "http://localhost:8080/auth/v1/magic-link/verify?token=mock")
      context.audit({ action: "user.invite", target: { userId: user.id } })
      return respond(user, 201)
    },
    "user.invite",
    true,
  )

  route(
    "POST",
    "users",
    "users.manage",
    async (context) => {
      requireAuth()
      const user = newUser(asObject(await context.body(), "body"))
      context.audit({ action: "user.create", target: { userId: user.id } })
      return respond(user, 201)
    },
    "user.create",
    true,
  )

  route("GET", "users/:id", "users.read", (context) => respond(userOf(context)))

  route(
    "PATCH",
    "users/:id",
    "users.manage",
    async (context) => {
      const user = userOf(context)
      const body = asObject(await context.body(), "body")
      const roles = checkRoles(body["roles"])
      const next = replaceUser(user, {
        ...(typeof body["email"] === "string" ? { email: body["email"] } : {}),
        ...(typeof body["name"] === "string" ? { name: body["name"] } : {}),
        ...(typeof body["emailVerified"] === "boolean"
          ? { emailVerified: body["emailVerified"] }
          : {}),
        ...(roles === undefined ? {} : { roles }),
        ...(isDocument(body["appMetadata"]) ? { appMetadata: body["appMetadata"] } : {}),
        ...(isDocument(body["userMetadata"]) ? { userMetadata: body["userMetadata"] } : {}),
      })
      context.audit({
        action: "user.update",
        target: { userId: user.id },
        diff: {
          before: { roles: user.roles, appMetadata: user.appMetadata, email: user.email },
          after: { roles: next.roles, appMetadata: next.appMetadata, email: next.email },
        },
        details: { fields: Object.keys(body) },
      })
      return respond(next)
    },
    "user.update",
    true,
  )

  route(
    "POST",
    "users/:id/ban",
    "users.manage",
    async (context) => {
      const user = userOf(context)
      const body = asObject(await context.body(), "body")
      const until = typeof body["until"] === "string" ? new Date(body["until"]) : undefined
      if (until !== undefined && Number.isNaN(until.getTime())) {
        fail(ErrorCode.ValidationFailed, "until must be an ISO date")
      }
      const banned = replaceUser(user, {
        banned: true,
        banReason: typeof body["reason"] === "string" ? body["reason"] : undefined,
        banExpires: until,
      })
      for (let index = state.userSessions.length - 1; index >= 0; index -= 1) {
        if (state.userSessions[index]?.userId === user.id) state.userSessions.splice(index, 1)
      }
      context.audit({
        action: "user.ban",
        target: { userId: user.id },
        details: { reason: body["reason"] },
      })
      return respond(banned)
    },
    "user.ban",
    true,
  )

  route(
    "POST",
    "users/:id/unban",
    "users.manage",
    (context) => {
      const user = userOf(context)
      const next = replaceUser(user, { banned: false, banReason: undefined, banExpires: undefined })
      context.audit({ action: "user.unban", target: { userId: user.id } })
      return respond(next)
    },
    "user.unban",
    true,
  )

  route(
    "DELETE",
    "users/:id",
    "users.manage",
    (context) => {
      const user = userOf(context)
      state.users.splice(state.users.indexOf(user), 1)
      context.audit({ action: "user.delete", target: { userId: user.id, email: user.email } })
      return noContent()
    },
    "user.delete",
    true,
  )

  route("GET", "users/:id/sessions", "users.read", (context) => {
    const user = userOf(context)
    return respond({ data: state.userSessions.filter((session) => session.userId === user.id) })
  })

  const revokeSessions = (context: Context, sid?: string) => {
    const user = userOf(context)
    let revoked = 0
    for (let index = state.userSessions.length - 1; index >= 0; index -= 1) {
      const session = state.userSessions[index]
      if (session?.userId === user.id && (sid === undefined || session.id === sid)) {
        state.userSessions.splice(index, 1)
        revoked += 1
      }
    }
    context.audit({
      action: "user.sessions.revoke",
      target: { userId: user.id, ...(sid === undefined ? {} : { sessionId: sid }) },
      details: { count: revoked },
    })
    return respond({ revoked })
  }

  route(
    "DELETE",
    "users/:id/sessions",
    "users.manage",
    (context) => revokeSessions(context),
    "user.sessions.revoke",
    true,
  )
  route(
    "DELETE",
    "users/:id/sessions/:sid",
    "users.manage",
    (context) => revokeSessions(context, context.params["sid"]),
    "user.sessions.revoke",
    true,
  )

  route("GET", "auth/keys", "settings.read", () => {
    requireAuth()
    return respond({ data: state.signingKeys })
  })

  route(
    "POST",
    "auth/keys/rotate",
    "settings.write",
    (context) => {
      requireAuth()
      for (const key of state.signingKeys) if (key.state === "active") key.state = "retired"
      const standby = state.signingKeys.find((key) => key.state === "standby")
      if (standby !== undefined) standby.state = "active"
      state.signingKeys.push({
        kid: `k_${randomHex(4)}`,
        alg: "EdDSA",
        state: "standby",
        createdAt: date(),
        expiresAt: new Date(now() + 90 * 86_400_000),
        revokedAt: undefined,
      })
      context.audit({ action: "auth.keys.rotate" })
      return respond({ data: state.signingKeys })
    },
    "auth.keys.rotate",
    true,
  )

  route(
    "DELETE",
    "auth/keys/:kid",
    "settings.write",
    (context) => {
      requireAuth()
      const key = state.signingKeys.find((candidate) => candidate.kid === context.params["kid"])
      if (key === undefined || key.state === "revoked") {
        return fail(ErrorCode.NotFound, "No such signing key")
      }
      key.state = "revoked"
      key.revokedAt = date()
      context.audit({ action: "auth.keys.revoke", target: { kid: key.kid } })
      return respond({ data: state.signingKeys })
    },
    "auth.keys.revoke",
    true,
  )

  // Email templates (built in auth)

  const templateKind = (context: Context): EmailKind => {
    requireAuth()
    const kind = EMAIL_KINDS.find((candidate) => candidate === context.params["kind"])
    return kind ?? fail(ErrorCode.NotFound, `No email template ${context.params["kind"] ?? ""}`)
  }
  const templateView = (kind: EmailKind) => {
    const stored = state.templates.current[kind]
    return {
      kind,
      ...(stored ?? TEMPLATE_DEFAULTS[kind]),
      source: stored === undefined ? "default" : "studio",
      placeholders: TEMPLATE_AVAILABLE[kind],
      required: TEMPLATE_REQUIRED[kind],
    }
  }
  const templateBody = (input: Record<string, unknown>): TemplateBody => {
    const subject = input["subject"]
    const text = input["text"]
    if (typeof subject !== "string") return fail(ErrorCode.ValidationFailed, "subject must be text")
    if (typeof text !== "string") return fail(ErrorCode.ValidationFailed, "text must be text")
    return { subject, text, ...(typeof input["html"] === "string" ? { html: input["html"] } : {}) }
  }
  const saveTemplate = (
    context: Context,
    kind: EmailKind,
    template: TemplateBody | undefined,
    expectedVersion: number,
    comment: string | undefined,
  ) => {
    const valid = template === undefined ? undefined : validateTemplate(kind, template)
    if (expectedVersion !== state.templates.version) {
      fail(
        ErrorCode.Conflict,
        `The email templates changed since you loaded them: version ${state.templates.version} is in force`,
        { currentVersion: state.templates.version },
      )
    }
    const before = state.templates.current[kind]
    const current = { ...state.templates.current }
    if (valid === undefined) delete current[kind]
    else current[kind] = valid
    state.templates.current = current
    state.templates.version += 1
    state.templates.history.unshift({
      version: state.templates.version,
      kind,
      change: valid === undefined ? "reset" : "update",
      templates: current,
      updatedAt: date(),
      updatedBy: context.admin.id,
      ...(comment === undefined || comment === "" ? {} : { comment }),
    })
    context.audit({
      action: valid === undefined ? "auth.templates.reset" : "auth.templates.update",
      target: { template: kind },
      diff: { before: before ?? null, after: valid ?? null },
      details: { version: state.templates.version },
      ...(comment === undefined || comment === "" ? {} : { comment }),
    })
    return respond({ version: state.templates.version, data: templateView(kind) })
  }

  route("GET", "auth/templates", "settings.read", () => {
    requireAuth()
    return respond({ version: state.templates.version, data: EMAIL_KINDS.map(templateView) })
  })

  route("GET", "auth/templates/history", "settings.read", () => {
    requireAuth()
    return respond({ data: state.templates.history })
  })

  route("POST", "auth/templates/:kind/preview", "settings.read", async (context) => {
    const kind = templateKind(context)
    const body = asObject(await context.body(), "body")
    const draft =
      body["template"] === undefined
        ? undefined
        : validateTemplate(kind, templateBody(asObject(body["template"], "template")))
    const template = draft ?? state.templates.current[kind] ?? TEMPLATE_DEFAULTS[kind]
    return respond({ kind, rendered: renderTemplate(template, PREVIEW) })
  })

  route(
    "PUT",
    "auth/templates/:kind",
    "settings.write",
    async (context) => {
      const kind = templateKind(context)
      const body = asObject(await context.body(), "body")
      if (typeof body["expectedVersion"] !== "number") {
        fail(ErrorCode.ValidationFailed, "body.expectedVersion must be an integer")
      }
      return saveTemplate(
        context,
        kind,
        templateBody(body),
        Number(body["expectedVersion"]),
        typeof body["comment"] === "string" ? body["comment"] : undefined,
      )
    },
    "auth.templates.update",
    true,
  )

  route(
    "DELETE",
    "auth/templates/:kind",
    "settings.write",
    (context) => {
      const kind = templateKind(context)
      const expected = Number(context.url.searchParams.get("expectedVersion"))
      if (!Number.isSafeInteger(expected) || expected < 0) {
        fail(ErrorCode.ValidationFailed, "expectedVersion must be a version number")
      }
      return saveTemplate(
        context,
        kind,
        undefined,
        expected,
        context.url.searchParams.get("comment") ?? undefined,
      )
    },
    "auth.templates.reset",
    true,
  )

  // Realtime

  const requireRealtime = () => {
    if (!realtimeOn) fail(ErrorCode.NotFound, "Realtime is turned off")
  }

  const contextOf = (connection: SeedConnection): RequestContext => ({
    roles: new Set(connection.roles),
    claims: connection.claims,
    now: date(),
  })

  const observers = () => {
    const current = engine()
    const seen = new Map<string, { subscribers: number } & Record<string, unknown>>()
    for (const connection of state.connections) {
      for (const subscription of connection.subscriptions) {
        const existing = seen.get(subscription.observer)
        if (existing !== undefined) {
          existing.subscribers += 1
          continue
        }
        seen.set(subscription.observer, {
          key: subscription.observer,
          coll: subscription.coll,
          type: "matcher",
          status: "live",
          subscribers: 1,
          filter: toFilter(current.using(subscription.coll, "read", contextOf(connection))),
          clusterTime: { $timestamp: { t: Math.floor(now() / 1000), i: 1 } },
        })
      }
    }
    return [...seen.values()]
  }

  route("GET", "realtime/stats", "realtime.stats", () => {
    requireRealtime()
    return respond({
      connections: state.connections.filter((connection) => connection.connected).length,
      sessions: state.connections.length,
      subscriptions: state.connections.reduce(
        (total, connection) => total + connection.subscriptions.length,
        0,
      ),
      observers: { matcher: observers().length, polling: 0 },
      subjects: new Set(state.connections.map((connection) => connection.subject)).size,
      policyVersion: engine().version,
      streamPosition: { $timestamp: { t: Math.floor(now() / 1000), i: 1 } },
      collections: [...state.published.values()]
        .filter((doc) => doc.realtime)
        .map((doc) => doc._id),
    })
  })

  route("GET", "realtime/connections", "realtime.inspect", () => {
    requireRealtime()
    return respond({
      data: state.connections.map(({ claims: _claims, ...connection }) => connection),
    })
  })

  route("GET", "realtime/observers", "realtime.inspect", () => {
    requireRealtime()
    return respond({ data: observers() })
  })

  route("GET", "realtime/events", "realtime.inspect", () => {
    requireRealtime()
    return respond({ data: state.events.slice(-100) })
  })

  route("GET", "realtime/trace/:eventId", "realtime.inspect", (context) => {
    requireRealtime()
    const event = state.events.find((candidate) => candidate.id === context.params["eventId"])
    if (event === undefined) {
      return fail(ErrorCode.NotFound, "The event is no longer in the trace buffer")
    }
    const document = (state.collections.get(event.coll) ?? []).find((candidate) =>
      sameId(candidate["_id"], event.docId),
    )
    const current = engine()
    const hiddenFromViewer = fieldAccess(
      current.collection(event.coll)?.fields?.read,
      new Set(["authenticated"]),
    )
    const explainDenial = (context: RequestContext) => {
      if (document === undefined) return undefined
      const definition = current.collection(event.coll)
      const explanation = current.explain(event.coll, "read", context)
      const policies = explanation.policies
        .filter((policy) =>
          definition?.policies.some((p) => p.name === policy.name && p.ops.includes("read")),
        )
        .map((policy) => {
          const source = definition?.policies.find((p) => p.name === policy.name)
          const fields = Object.keys(source?.using ?? {}).filter((key) => !key.startsWith("$"))
          const issue = /^variable (\S+) is (missing or null|invalid \((\w+)\))$/.exec(
            policy.reason,
          )
          const matched = policy.applies && compileFilter(policy.resolved ?? {}).matches(document)
          return {
            name: policy.name,
            kind: policy.kind,
            matched,
            ...(issue === null
              ? {}
              : { issue: { variable: issue[1] ?? "", kind: issue[3] ?? "missing" } }),
            fields,
          }
        })
      const grants = explanation.policies.filter(
        (policy) => policy.kind === "permissive" && !policy.reason.startsWith("not granted"),
      )
      const failingRestrictive = policies.filter(
        (policy) => policy.kind === "restrictive" && !policy.matched,
      )
      const reason =
        grants.length === 0
          ? "no_grant"
          : failingRestrictive.length > 0
            ? "restrictive"
            : "no_permissive"
      return {
        reason,
        responsible:
          reason === "no_permissive"
            ? policies.filter((policy) => policy.kind === "permissive").map((policy) => policy.name)
            : failingRestrictive.map((policy) => policy.name),
        policies,
      }
    }
    const candidates = observers()
      .filter((observer) => observer["coll"] === event.coll)
      .map((observer) => {
        const subscribers: { sid: string; sub: string; subject: string }[] = []
        let denied: RequestContext | undefined
        for (const connection of state.connections) {
          const subscription = connection.subscriptions.find(
            (candidate) => candidate.observer === observer["key"],
          )
          if (subscription === undefined) continue
          const ctx = contextOf(connection)
          const compiled = current.using(event.coll, "read", ctx)
          const visible =
            event.op === "delete" ||
            (document !== undefined &&
              compiled.kind !== "deny" &&
              compileFilter(toFilter(compiled)).matches(document))
          if (visible) {
            subscribers.push({
              sid: connection.sid,
              sub: subscription.id,
              subject: connection.subject,
            })
          } else denied ??= ctx
        }
        const outcome =
          subscribers.length === 0
            ? "unmatched"
            : event.op === "insert"
              ? "entered"
              : event.op === "delete"
                ? "left"
                : "updated"
        const dls =
          subscribers.length === 0 && denied !== undefined ? explainDenial(denied) : undefined
        const masked =
          dls !== undefined &&
          context.admin.role === "viewer" &&
          dls.policies.some((policy) =>
            policy.fields.some((field) => !canAccess(hiddenFromViewer, field)),
          )
        return {
          observer: observer["key"],
          type: observer["type"],
          outcome,
          subscribers,
          ...(dls === undefined ? {} : { dls: masked ? { masked: true } : dls }),
        }
      })
    return respond({ ...event, policyVersion: current.version, candidates })
  })

  route("GET", "realtime/tail", "realtime.inspect", (context) => {
    requireRealtime()
    const encoder = new TextEncoder()
    let stop = () => {}
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(": canopy realtime tail\n\n"))
        const listener = (event: EventState) => {
          try {
            controller.enqueue(
              encoder.encode(
                `id: ${event.id}\nevent: change\ndata: ${JSON.stringify(encode(event))}\n\n`,
              ),
            )
          } catch {
            stop()
          }
        }
        tailListeners.add(listener)
        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": ping\n\n"))
          } catch {
            stop()
          }
        }, 15_000)
        stop = () => {
          tailListeners.delete(listener)
          clearInterval(heartbeat)
        }
        context.request.signal.addEventListener("abort", () => {
          stop()
          try {
            controller.close()
          } catch {
            // The client already went away.
          }
        })
      },
      cancel() {
        stop()
      },
    })
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    })
  })

  // Operations

  route("GET", "doctor", "ops.doctor", () => {
    const checks: { name: string; status: "ok" | "warn" | "fail"; message: string }[] = [
      { name: "mongodb", status: "ok", message: "MongoDB 8.0.4" },
      { name: "replica-set", status: "ok", message: "Replica set rs0" },
      { name: "meta-migrations", status: "ok", message: "The meta database is up to date" },
      { name: "master-key", status: "ok", message: "Stored secrets are encrypted" },
      {
        name: "admin-listener",
        status: production ? "warn" : "ok",
        message:
          "/admin is served on the public listener; set CANOPY_ADMIN_LISTEN to keep it private",
      },
      {
        name: "policies",
        status: "ok",
        message: `Bundle ${engine().version}, ${state.published.size} collection(s)`,
      },
      ...(realtimeOn
        ? [
            {
              name: "realtime",
              status: "ok" as const,
              message: `${state.connections.filter((connection) => connection.connected).length} connection(s)`,
            },
          ]
        : []),
    ]
    const status = checks.some((check) => check.status === "fail")
      ? "fail"
      : checks.some((check) => check.status === "warn")
        ? "warn"
        : "ok"
    return respond({ status, environment, checks })
  })

  route("GET", "audit", "ops.audit", (context) => {
    const action = context.url.searchParams.get("action")
    const before = context.url.searchParams.get("before")
    const limit = Math.min(
      Math.max(Number(context.url.searchParams.get("limit") ?? "100") || 100, 1),
      1000,
    )
    let entries =
      action === null ? state.audit : state.audit.filter((entry) => entry.action === action)
    if (before !== null) {
      const index = entries.findIndex((entry) => entry._id.$oid === before)
      entries = index < 0 ? entries : entries.slice(index + 1)
    }
    const page = entries.slice(0, limit)
    return respond({ data: page, next: page.at(-1)?._id.$oid ?? null })
  })

  route("GET", "logs", "ops.audit", (context) => {
    const search = context.url.searchParams
    const surface = search.get("surface")
    if (surface !== null && !["rest", "auth", "admin", "realtime"].includes(surface)) {
      fail(ErrorCode.ValidationFailed, "surface must be one of rest, auth, admin, realtime")
    }
    const status = search.get("status")
    if (status !== null && !/^[1-5](xx|\d\d)$/.test(status)) {
      fail(ErrorCode.ValidationFailed, "status must be a code such as 404 or a class such as 5xx")
    }
    const before = search.get("before")
    const limit = Math.min(Math.max(Number(search.get("limit") ?? "100") || 100, 1), 1000)
    let entries = state.logs.filter(
      (entry) =>
        (surface === null || entry.surface === surface) &&
        (status === null ||
          (status.endsWith("xx")
            ? Math.floor(entry.status / 100) === Number(status[0])
            : entry.status === Number(status))),
    )
    if (before !== null) {
      const index = entries.findIndex((entry) => entry._id.$oid === before)
      entries = index < 0 ? entries : entries.slice(index + 1)
    }
    const page = entries.slice(0, limit)
    return respond({
      data: page,
      next: page.at(-1)?._id.$oid ?? null,
      sampleRate: state.settings.requestLogSampleRate,
      retentionDays: state.settings.requestLogRetentionDays,
    })
  })

  route("GET", "settings", "settings.read", () => respond(state.settings))

  route(
    "PATCH",
    "settings",
    "settings.write",
    async (context) => {
      const body = asObject(await context.body(), "body")
      const before = { ...state.settings }
      const days = body["auditRetentionDays"]
      if (days !== undefined) {
        if (
          days !== null &&
          (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 36_500)
        ) {
          fail(
            ErrorCode.ValidationFailed,
            "body.auditRetentionDays must be an integer from 1 to 36500",
          )
        }
      }
      const rate = body["requestLogSampleRate"]
      if (rate !== undefined && (typeof rate !== "number" || rate < 0 || rate > 1)) {
        fail(ErrorCode.ValidationFailed, "body.requestLogSampleRate must be a number from 0 to 1")
      }
      const retention = body["requestLogRetentionDays"]
      if (
        retention !== undefined &&
        (typeof retention !== "number" ||
          !Number.isInteger(retention) ||
          retention < 1 ||
          retention > 90)
      ) {
        fail(
          ErrorCode.ValidationFailed,
          "body.requestLogRetentionDays must be an integer from 1 to 90",
        )
      }
      const allowlist = body["adminAllowlist"]
      if (allowlist !== undefined) {
        if (!Array.isArray(allowlist) || allowlist.some((rule) => typeof rule !== "string")) {
          fail(ErrorCode.ValidationFailed, "body.adminAllowlist must be a list of addresses")
        }
        const rules = allowlist as string[]
        for (const rule of rules) {
          if (!isAllowRule(rule)) {
            fail(ErrorCode.ValidationFailed, `${rule} is not an IP address or CIDR range`, {
              path: "adminAllowlist",
            })
          }
        }
        if (rules.length > 0 && !rules.some((rule) => addressAllowed(clientIp, [rule]))) {
          fail(
            ErrorCode.ValidationFailed,
            `The allowlist does not include your address (${clientIp}), so saving it would lock you out`,
            { path: "adminAllowlist", reason: "lockout" },
          )
        }
      }
      if (days !== undefined) state.settings.auditRetentionDays = days as number | null
      if (typeof rate === "number") state.settings.requestLogSampleRate = rate
      if (typeof retention === "number") state.settings.requestLogRetentionDays = retention
      if (Array.isArray(allowlist)) state.settings.adminAllowlist = allowlist.map(String)
      context.audit({ action: "settings.update", diff: { before, after: { ...state.settings } } })
      return respond(state.settings)
    },
    "settings.update",
    true,
  )

  if (extras) {
    route("GET", "auth/providers", "settings.read", () =>
      respond({
        mode: "builtin",
        providers: [
          { id: "email", enabled: true, configured: true },
          {
            id: "google",
            enabled: true,
            clientId: "1234.apps.googleusercontent.com",
            configured: true,
          },
          { id: "github", enabled: false, configured: false },
        ],
      }),
    )
    for (const [path, phrase, action] of [
      ["settings/revoke-all-sessions", "revoke all sessions", "danger.revoke_all_sessions"],
      ["settings/rotate-master-key", "rotate master key", "danger.rotate_master_key"],
    ] as const) {
      route(
        "POST",
        path,
        "admins.manageOwners",
        (context) => {
          if (context.request.headers.get("x-canopy-confirm") !== phrase) {
            fail(ErrorCode.ValidationFailed, `Confirm with the phrase ${phrase}`)
          }
          return noContent()
        },
        action,
      )
    }
  }

  const sessionOf = (request: Request): SessionState | undefined => {
    const bearer = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1]
    const token =
      bearer ??
      cookieOf(request, SESSION_COOKIE) ??
      request.headers.get(TEST_SESSION_HEADER) ??
      undefined
    const session = token === undefined || token === "" ? undefined : state.sessions.get(token)
    if (session === undefined || session.expiresAt.getTime() <= now()) return undefined
    return session
  }

  const serve = async (request: Request, url: URL): Promise<Response> => {
    const segments = url.pathname
      .slice("/admin/v1".length)
      .split("/")
      .filter((part) => part !== "")
      .map(decodeURIComponent)
    let allowedMethods = 0
    let found: { route: Route; params: Record<string, string> } | undefined
    for (const candidate of routes) {
      if (candidate.path.length !== segments.length) continue
      const params: Record<string, string> = {}
      const ok = candidate.path.every((part, index) => {
        const segment = segments[index] ?? ""
        if (!part.startsWith(":")) return part === segment
        params[part.slice(1)] = segment
        return true
      })
      if (!ok) continue
      allowedMethods += 1
      if (candidate.method === request.method) found ??= { route: candidate, params }
    }
    if (found === undefined) {
      if (allowedMethods > 0) {
        return fail(ErrorCode.InvalidQuery, `${request.method} is not allowed here`)
      }
      return fail(ErrorCode.NotFound, `No admin endpoint ${request.method} ${url.pathname}`)
    }
    const current = found.route
    const mutating = request.method !== "GET" && request.method !== "HEAD"
    let text: string | undefined
    const body = async (): Promise<unknown> => {
      text ??= await request.text()
      if (text === "") return {}
      try {
        return JSON.parse(text) as unknown
      } catch {
        return fail(ErrorCode.ValidationFailed, "The body is not valid JSON")
      }
    }
    if (current.permission === "public") {
      return current.handler({ request, url, params: found.params, body } as Context)
    }
    const session = sessionOf(request)
    const admin =
      session === undefined
        ? undefined
        : state.admins.find((candidate) => candidate.id === session.adminId)
    if (session === undefined || admin === undefined || admin.disabled) {
      return fail(ErrorCode.Unauthorized, "Log in to continue")
    }
    const bearer = request.headers.get("authorization") !== null
    if (mutating && !bearer && request.headers.get("x-canopy-csrf") !== session.csrf) {
      fail(ErrorCode.Forbidden, "The CSRF token is missing or wrong", { reason: "csrf" })
    }
    const actor = { type: "admin", id: admin.id, email: admin.email, role: admin.role }
    let audited = false
    const context: Context = {
      request,
      url,
      params: found.params,
      admin,
      session,
      body,
      audit(entry) {
        audited = true
        record({ ...entry, actor })
      },
    }
    if (
      admin.mustChangePassword &&
      !["me", "me/password", "logout"].includes(current.path.join("/"))
    ) {
      fail(ErrorCode.Forbidden, "Change your password first", {
        reason: "password_change_required",
      })
    }
    const deny = (message: string) =>
      record({
        action: current.action ?? `${request.method} ${url.pathname}`,
        actor,
        outcome: "denied",
        target: found.params,
        details: { message },
      })
    if (current.permission !== "session" && !can(admin.role, current.permission, environment)) {
      if (mutating) deny(`The ${admin.role} role may not do this`)
      fail(ErrorCode.Forbidden, `The ${admin.role} role may not do this`)
    }
    try {
      const response = await current.handler(context)
      if (
        mutating &&
        current.action !== undefined &&
        !audited &&
        !current.selfAudited &&
        response.status < 400
      ) {
        record({ action: current.action, actor, target: found.params })
      }
      return response
    } catch (error: unknown) {
      if (
        mutating &&
        !audited &&
        error instanceof CanopyError &&
        error.code === ErrorCode.Forbidden
      ) {
        deny(error.message)
      }
      throw error
    }
  }

  const openapi = (): Response => {
    const paths: Record<string, unknown> = {}
    for (const doc of state.published.values()) {
      if (!doc.exposed) continue
      paths[`/rest/v1/${doc._id}`] = {
        get: {
          summary: `List ${doc._id}`,
          tags: [doc._id],
          responses: { "200": { description: "Documents" } },
        },
        post: {
          summary: `Insert into ${doc._id}`,
          tags: [doc._id],
          responses: { "201": { description: "Inserted" } },
        },
      }
    }
    return respond({
      openapi: "3.1.0",
      info: { title: "Canopy Data API", version: "0.0.0" },
      paths,
    })
  }

  return {
    state,
    async fetch(request) {
      const url = new URL(request.url)
      try {
        if (url.pathname === "/rest/v1/openapi.json") return openapi()
        if (url.pathname !== "/admin/v1" && !url.pathname.startsWith("/admin/v1/")) {
          return fail(ErrorCode.NotFound, "Not found")
        }
        return await serve(request, url)
      } catch (error: unknown) {
        if (error instanceof CanopyError) return problem(error, url.pathname)
        const message = error instanceof Error ? error.message : String(error)
        return problem(new CanopyError(ErrorCode.Internal, message), url.pathname)
      }
    },
    close() {
      if (timer !== undefined) clearInterval(timer)
    },
  }
}

export type { AdminRole }
