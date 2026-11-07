import { CanopyError, ErrorCode, isErrorCode } from "@canopy/protocol"
import type {
  Admin,
  ApiKey,
  AppUser,
  AppUserPatch,
  AppUserSession,
  AuditEntry,
  CollectionStats,
  CollectionSummary,
  CreatedAdmin,
  CreatedKey,
  DoctorReport,
  DocumentsPage,
  EmailKind,
  EmailTemplate,
  EmailTemplateBody,
  EmailTemplateVersion,
  EventTrace,
  FieldInfo,
  HistoryEntry,
  LogsPage,
  Me,
  Providers,
  RealtimeConnection,
  RealtimeEvent,
  RealtimeObserver,
  RealtimeStats,
  RequestSurface,
  Session,
  Settings,
  SetupResult,
  SetupStatus,
  SigningKey,
  SimulatedOperation,
  Simulation,
  StoredCollection,
  ValidationResult,
  ViewAs,
} from "./contract.ts"
import { object, record, type Schema, unknown } from "./schema.ts"
import {
  parseDls,
  wireAdminCreated,
  wireAdmins,
  wireAdminUpdated,
  type wireAdminUser,
  wireApiKey,
  wireApiKeys,
  wireAppUser,
  wireAudit,
  wireAuthSessions,
  wireClaim,
  wireCollectionSchema,
  wireCollectionStats,
  wireCollections,
  wireConnections,
  wireCreatedKey,
  wireDoctor,
  wireDocuments,
  wireHistory,
  wireLogin,
  wireLogs,
  wireMe,
  wireObservers,
  wirePolicies,
  wireProviders,
  wirePublishResult,
  wireRealtimeEvents,
  wireRealtimeStats,
  wireRealtimeToken,
  wireRevoked,
  wireSettings,
  wireSetupStatus,
  wireSigningKeys,
  wireSimulation,
  wireTemplateHistory,
  wireTemplatePreview,
  wireTemplateSaved,
  wireTemplates,
  wireTotpEnrollment,
  wireTrace,
  wireUsersPage,
  wireValidation,
  wireWrite,
} from "./wire.ts"

/** The base path of the admin API. */
export const ADMIN_BASE_PATH = "/admin/v1"
/** The header carrying the double submit CSRF token on mutating requests. */
export const CSRF_HEADER = "x-canopy-csrf"
/** The header carrying the typed confirmation that production data edits require. */
export const CONFIRM_HEADER = "x-canopy-confirm"
const CSRF_COOKIES = ["__Host-canopy_csrf", "canopy_csrf"]

/** Options of {@link AdminApi}. */
export interface AdminApiOptions {
  /** The origin or base URL; defaults to the page origin. */
  readonly baseUrl?: string
  readonly fetch?: typeof fetch
  /** Reads `document.cookie`; replaceable in tests. */
  readonly cookies?: () => string
  /** Called when a request fails with 401, so the app can return to the login screen. */
  readonly onUnauthorized?: () => void
}

/** A policy body as Studio edits it: the stored form without the server managed members. */
export type PolicyDraft = Omit<StoredCollection, "version" | "hash" | "updatedAt" | "updatedBy">

/** Arguments of a document listing. */
export interface DocumentQuery {
  readonly filter?: Readonly<Record<string, unknown>>
  readonly sort?: Readonly<Record<string, 1 | -1>>
  readonly projection?: Readonly<Record<string, 0 | 1>>
  readonly limit?: number
  readonly skip?: number
  readonly as?: ViewAs
}

/** Who performs a write and why: impersonated writes need a reason, production edits a confirmation. */
export interface WriteContext {
  readonly as?: ViewAs
  readonly reason?: string
  readonly confirm?: string
}

/**
 * Arguments of a policy simulation. The server evaluates `filter` against real data; `document` and `update`
 * are kept for the in memory mock and not sent.
 */
export interface SimulationRequest {
  readonly draft: PolicyDraft
  readonly as: ViewAs
  readonly op: SimulatedOperation
  readonly filter?: Readonly<Record<string, unknown>>
  readonly document?: Readonly<Record<string, unknown>>
  readonly update?: Readonly<Record<string, unknown>>
  readonly limit?: number
}

/** The definition body the server takes: the draft without `_id`. */
export function definitionOf(draft: PolicyDraft): Record<string, unknown> {
  const { _id: _ignored, fields, immutable, ...rest } = draft
  return {
    ...rest,
    ...(fields === undefined || fields === null ? {} : { fields }),
    ...(immutable === undefined ? {} : { immutable }),
  }
}

function problemOf(body: unknown): {
  code?: unknown
  detail?: unknown
  title?: unknown
  details?: unknown
} {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {}
}

function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return ErrorCode.InvalidQuery
    case 401:
      return ErrorCode.Unauthorized
    case 403:
      return ErrorCode.Forbidden
    case 404:
      return ErrorCode.NotFound
    case 409:
      return ErrorCode.Conflict
    case 413:
      return ErrorCode.PayloadTooLarge
    case 422:
      return ErrorCode.ValidationFailed
    case 429:
      return ErrorCode.RateLimited
    case 503:
      return ErrorCode.Unavailable
    case 504:
      return ErrorCode.Timeout
    default:
      return ErrorCode.Internal
  }
}

/** Whether an error is the admin API answering that an endpoint or resource does not exist. */
export function isNotFound(error: unknown): boolean {
  return error instanceof CanopyError && error.code === ErrorCode.NotFound
}

/** The HTTP status an admin API error was answered with. */
export function statusOf(error: unknown): number | undefined {
  if (!(error instanceof CanopyError)) return undefined
  const status = error.details?.["status"]
  return typeof status === "number" ? status : undefined
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value)
}

/**
 * The `_id` of a document as it travels in a URL: its canonical EJSON, so `"65f1…"` stays a string and
 * `{"$oid":"65f1…"}` an ObjectId. Numbers are wrapped because a bare `5` would be read as the string `5`.
 */
export function encodeId(id: unknown): string {
  const value =
    typeof id === "number"
      ? Number.isInteger(id) && Math.abs(id) < 2 ** 31
        ? { $numberInt: String(id) }
        : { $numberDouble: String(id) }
      : id
  return encodeSegment(JSON.stringify(value))
}

/**
 * The `as` parameter of the admin API: `{ role: "anon" }` for anonymous callers, otherwise the claims
 * (the server adds `authenticated` for them) and any extra roles.
 */
export function wireAs(viewAs: ViewAs): Record<string, unknown> {
  if (viewAs.roles.includes("anon")) return { role: "anon" }
  const roles = viewAs.roles.filter((role) => role !== "authenticated")
  return { ...(roles.length === 0 ? {} : { roles }), claims: { ...viewAs.claims } }
}

/** `sort=-createdAt,title`, the syntax of the Data API. */
export function sortParam(sort: Readonly<Record<string, 1 | -1>>): string {
  return Object.entries(sort)
    .map(([path, direction]) => (direction === -1 ? `-${path}` : path))
    .join(",")
}

/** `fields=title,done` or `fields=-notes`; inclusion wins when both are given, like MongoDB forbids mixing. */
export function fieldsParam(projection: Readonly<Record<string, 0 | 1>>): string {
  const entries = Object.entries(projection)
  const included = entries.filter(([, value]) => value === 1)
  return (included.length > 0 ? included : entries)
    .map(([path, value]) => (value === 1 ? path : `-${path}`))
    .join(",")
}

function adminOf(user: ReturnType<typeof wireAdminUser.parse>): Admin {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    ...(user.name === undefined || user.name === null ? {} : { name: user.name }),
    ...(user.totpEnabled === undefined ? {} : { totp: user.totpEnabled }),
    ...(user.mustChangePassword === undefined
      ? {}
      : { mustChangePassword: user.mustChangePassword }),
    ...(user.disabled === undefined ? {} : { disabled: user.disabled }),
    ...(user.createdAt === undefined ? {} : { createdAt: user.createdAt }),
    ...(user.lastLoginAt === undefined || user.lastLoginAt === null
      ? {}
      : { lastLoginAt: user.lastLoginAt }),
  }
}

const SCALAR_NAMES: Readonly<Record<string, string>> = { bool: "bool" }

function shapeTypes(shape: unknown): string[] {
  if (typeof shape !== "object" || shape === null) return []
  const node = shape as Record<string, unknown>
  switch (node["kind"]) {
    case "scalar":
      return [String(SCALAR_NAMES[String(node["type"])] ?? node["type"])]
    case "object":
      return ["object"]
    case "array":
      return ["array"]
    case "union":
      return [...new Set((Array.isArray(node["of"]) ? node["of"] : []).flatMap(shapeTypes))]
    default:
      return ["any"]
  }
}

/** Flattens a `@canopy/schema` object shape into dotted field paths with their BSON types. */
export function fieldsOfShape(shape: unknown, prefix = ""): FieldInfo[] {
  if (typeof shape !== "object" || shape === null) return []
  const node = shape as Record<string, unknown>
  if (node["kind"] === "union") {
    const out = new Map<string, FieldInfo>()
    for (const member of Array.isArray(node["of"]) ? node["of"] : []) {
      for (const field of fieldsOfShape(member, prefix)) {
        const existing = out.get(field.path)
        out.set(
          field.path,
          existing === undefined
            ? field
            : { path: field.path, types: [...new Set([...existing.types, ...field.types])] },
        )
      }
    }
    return [...out.values()]
  }
  if (node["kind"] !== "object" || typeof node["fields"] !== "object" || node["fields"] === null) {
    return []
  }
  const out: FieldInfo[] = []
  for (const [name, field] of Object.entries(node["fields"] as Record<string, unknown>)) {
    const fieldShape = (field as { shape?: unknown } | null)?.shape
    const path = prefix === "" ? name : `${prefix}.${name}`
    out.push({ path, types: shapeTypes(fieldShape) })
    out.push(...fieldsOfShape(fieldShape, path))
  }
  return out
}

function idText(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "object" && value !== null && "$oid" in value) {
    return String((value as { $oid: unknown }).$oid)
  }
  return JSON.stringify(value)
}

function describeTarget(target: Readonly<Record<string, unknown>> | undefined): string | undefined {
  if (target === undefined) return undefined
  const collection = typeof target["collection"] === "string" ? target["collection"] : undefined
  const ids = target["ids"] ?? target["id"]
  if (collection !== undefined) {
    const list = Array.isArray(ids) ? ids.map(idText) : ids === undefined ? [] : [idText(ids)]
    return list.length === 0 ? collection : `${collection}/${list.join(",")}`
  }
  for (const key of ["keyId", "email", "id", "name"]) {
    if (typeof target[key] === "string") return target[key] as string
  }
  return JSON.stringify(target)
}

const AUDIT_PREFIX_LIMIT = 1000

const empty = object({})

/**
 * A typed client of the admin API (`/admin/v1`). It sends the admin session cookie, adds the CSRF token to
 * mutating requests, validates every response against the server's contract (`wire.ts`) and converts it to
 * Studio's types, and turns Problem Details into {@link CanopyError}s whose `details.status` holds the HTTP
 * status. Endpoints the server does not offer yet answer 404, which screens show as "not available".
 */
export class AdminApi {
  readonly #base: string
  readonly #fetch: typeof fetch
  readonly #cookies: () => string
  readonly #onUnauthorized: (() => void) | undefined
  #csrf: string | undefined

  constructor(options: AdminApiOptions = {}) {
    this.#base = `${(options.baseUrl ?? "").replace(/\/+$/, "")}${ADMIN_BASE_PATH}`
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.#cookies =
      options.cookies ?? (() => (typeof document === "undefined" ? "" : document.cookie))
    this.#onUnauthorized = options.onUnauthorized
  }

  /**
   * The CSRF token in use: the double submit cookie when the page can read it (it follows the latest login
   * in any tab), else the token of the last login.
   */
  csrfToken(): string | undefined {
    for (const part of this.#cookies().split(";")) {
      const [name, ...rest] = part.trim().split("=")
      if (name !== undefined && CSRF_COOKIES.includes(name) && rest.join("=") !== "") {
        return decodeURIComponent(rest.join("="))
      }
    }
    return this.#csrf
  }

  /** The absolute URL of an admin API path, for `EventSource` and downloads. */
  url(path: string): string {
    return `${this.#base}${path}`
  }

  async request<T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    schema: Schema<T>,
    options: {
      readonly body?: unknown
      readonly signal?: AbortSignal | undefined
      readonly headers?: Readonly<Record<string, string>>
    } = {},
  ): Promise<T> {
    const headers = new Headers({ accept: "application/json", ...options.headers })
    if (options.body !== undefined) headers.set("content-type", "application/json")
    if (method !== "GET") {
      const csrf = this.csrfToken()
      if (csrf !== undefined) headers.set(CSRF_HEADER, csrf)
    }
    const response = await this.#fetch(this.url(path), {
      method,
      headers,
      credentials: "same-origin",
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    const text = await response.text()
    let body: unknown
    try {
      body = text === "" ? {} : JSON.parse(text)
    } catch (error: unknown) {
      if (response.ok) {
        throw new CanopyError(ErrorCode.Internal, "The admin API answered with invalid JSON", {
          details: { status: response.status },
          cause: error,
        })
      }
      body = { detail: text }
    }
    if (!response.ok) {
      const problem = problemOf(body)
      const code = isErrorCode(problem.code) ? problem.code : codeForStatus(response.status)
      const message =
        typeof problem.detail === "string" && problem.detail !== ""
          ? problem.detail
          : typeof problem.title === "string"
            ? problem.title
            : `${method} ${path} failed with status ${response.status}`
      const details =
        typeof problem.details === "object" && problem.details !== null
          ? (problem.details as Record<string, unknown>)
          : {}
      if (response.status === 401 && path !== "/login" && path !== "/setup")
        this.#onUnauthorized?.()
      throw new CanopyError(code, message, { details: { ...details, status: response.status } })
    }
    return schema.parse(body)
  }

  async setupStatus(signal?: AbortSignal): Promise<SetupStatus> {
    const result = await this.request("GET", "/setup", wireSetupStatus, { signal })
    return { required: !result.claimed }
  }

  /**
   * Claims an unclaimed server with the one time setup token. It does not sign in: the owner then logs in
   * with the code of the returned authenticator enrollment.
   */
  async setup(input: {
    readonly token: string
    readonly email: string
    readonly password: string
    readonly name?: string
  }): Promise<SetupResult> {
    const result = await this.request("POST", "/setup", wireClaim, { body: input })
    return { admin: adminOf(result.user), totp: result.totp }
  }

  /**
   * Signs in with a cookie session. A 401 with `details.totpRequired` asks for the authenticator code, and
   * `details.totpEnrollment` carries a new enrollment for accounts that have none yet.
   */
  async login(input: {
    readonly email: string
    readonly password: string
    readonly totp?: string
  }): Promise<Session> {
    const result = await this.request("POST", "/login", wireLogin, { body: input })
    this.#csrf = result.csrfToken
    return {
      admin: adminOf(result.user),
      csrfToken: result.csrfToken,
      ...(result.expiresAt === undefined ? {} : { expiresAt: result.expiresAt }),
    }
  }

  async logout(): Promise<void> {
    await this.request("POST", "/logout", empty)
    this.#csrf = undefined
  }

  async me(signal?: AbortSignal): Promise<Me> {
    const result = await this.request("GET", "/me", wireMe, { signal })
    return {
      admin: adminOf(result.user),
      environment: result.environment,
      ...(result.version === undefined ? {} : { version: result.version }),
      ...(result.expiresAt === undefined ? {} : { expiresAt: result.expiresAt }),
      ...(result.permissions === undefined ? {} : { grants: result.permissions }),
    }
  }

  async changePassword(current: string, next: string): Promise<void> {
    await this.request("POST", "/me/password", empty, { body: { current, next } })
  }

  enrollTotp(): Promise<{ readonly secret: string; readonly uri: string }> {
    return this.request("POST", "/me/totp", wireTotpEnrollment)
  }

  async confirmTotp(code: string): Promise<void> {
    await this.request("POST", "/me/totp/confirm", empty, { body: { code } })
  }

  async admins(signal?: AbortSignal): Promise<readonly Admin[]> {
    const result = await this.request("GET", "/admins", wireAdmins, { signal })
    return result.data.map(adminOf)
  }

  /** Creates an admin with a temporary password, which is returned once. */
  async createAdmin(input: {
    readonly email: string
    readonly role: Admin["role"]
    readonly name?: string
  }): Promise<CreatedAdmin> {
    const result = await this.request("POST", "/admins", wireAdminCreated, { body: input })
    return { admin: adminOf(result.user), password: result.password }
  }

  async updateAdmin(
    id: string,
    patch: { readonly role?: Admin["role"]; readonly disabled?: boolean; readonly name?: string },
  ): Promise<Admin> {
    const result = await this.request("PATCH", `/admins/${encodeSegment(id)}`, wireAdminUpdated, {
      body: patch,
    })
    return adminOf(result.user)
  }

  async resetAdminTotp(id: string): Promise<Admin> {
    const result = await this.request(
      "POST",
      `/admins/${encodeSegment(id)}/reset-totp`,
      wireAdminUpdated,
    )
    return adminOf(result.user)
  }

  async removeAdmin(id: string): Promise<void> {
    await this.request("DELETE", `/admins/${encodeSegment(id)}`, empty)
  }

  async collections(signal?: AbortSignal): Promise<readonly CollectionSummary[]> {
    const result = await this.request("GET", "/collections", wireCollections, { signal })
    return result.data.map((collection) => ({
      name: collection.name,
      exposed: collection.exposed,
      realtime: collection.realtime,
      policyCount: collection.policies,
      policyVersion: collection.version === 0 ? null : collection.version,
      ...(collection.exists === undefined ? {} : { exists: collection.exists }),
    }))
  }

  /**
   * Turns exposure or realtime on or off. Both live in the collection's policy document, so this publishes a
   * new policy version and needs the version it was read at; production needs a comment.
   */
  async updateCollection(
    name: string,
    patch: {
      readonly exposed?: boolean
      readonly realtime?: boolean
      readonly expectedVersion: number
      readonly comment?: string
    },
  ): Promise<{ readonly version: number }> {
    const result = await this.request(
      "PATCH",
      `/collections/${encodeSegment(name)}`,
      wirePublishResult,
      { body: patch },
    )
    return { version: result.stored.version }
  }

  async collectionSchema(name: string, signal?: AbortSignal): Promise<readonly FieldInfo[]> {
    const result = await this.request(
      "GET",
      `/collections/${encodeSegment(name)}/schema`,
      wireCollectionSchema,
      { signal },
    )
    return result.schema === null ? [] : fieldsOfShape(result.schema.shape)
  }

  async collectionStats(name: string, signal?: AbortSignal): Promise<CollectionStats> {
    const result = await this.request(
      "GET",
      `/collections/${encodeSegment(name)}/stats`,
      wireCollectionStats,
      { signal },
    )
    return {
      count: result.documents,
      ...(result.size === undefined ? {} : { size: result.size }),
      ...(result.averageDocumentSize === undefined
        ? {}
        : { avgDocumentSize: result.averageDocumentSize }),
      ...(result.indexes === undefined
        ? {}
        : {
            indexes: result.indexes.map((index) => ({
              name: index.name,
              keys: index.key,
              ...(index.unique === undefined ? {} : { unique: index.unique }),
            })),
          }),
    }
  }

  /**
   * Lists documents as `service`, or through document level security with `as`. The server does not count
   * matches, so `total` is absent and `next` tells whether another page exists.
   */
  async documents(
    collection: string,
    query: DocumentQuery,
    signal?: AbortSignal,
  ): Promise<DocumentsPage> {
    const params = new URLSearchParams()
    if (query.filter !== undefined && Object.keys(query.filter).length > 0) {
      params.set("filter", JSON.stringify(query.filter))
    }
    if (query.sort !== undefined && Object.keys(query.sort).length > 0) {
      params.set("sort", sortParam(query.sort))
    }
    if (query.projection !== undefined && Object.keys(query.projection).length > 0) {
      params.set("fields", fieldsParam(query.projection))
    }
    if (query.limit !== undefined) params.set("limit", String(query.limit))
    if (query.skip !== undefined && query.skip > 0) params.set("skip", String(query.skip))
    if (query.as !== undefined) params.set("as", JSON.stringify(wireAs(query.as)))
    const search = params.toString()
    const result = await this.request(
      "GET",
      `/collections/${encodeSegment(collection)}/documents${search === "" ? "" : `?${search}`}`,
      wireDocuments,
      { signal },
    )
    return {
      documents: result.data,
      ...(result.masked === undefined ? {} : { masked: result.masked }),
      ...(result.page?.next === undefined || result.page.next === null
        ? {}
        : { next: result.page.next }),
    }
  }

  #write(
    method: "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    context: WriteContext,
    body?: unknown,
  ) {
    const params = new URLSearchParams()
    if (context.as !== undefined) params.set("as", JSON.stringify(wireAs(context.as)))
    if (context.reason !== undefined && context.reason !== "") params.set("reason", context.reason)
    const search = params.toString()
    return this.request(method, `${path}${search === "" ? "" : `?${search}`}`, wireWrite, {
      ...(body === undefined ? {} : { body }),
      headers: context.confirm === undefined ? {} : { [CONFIRM_HEADER]: context.confirm },
    })
  }

  async insertDocument(
    collection: string,
    document: Readonly<Record<string, unknown>>,
    context: WriteContext = {},
  ): Promise<Record<string, unknown> | null> {
    const result = await this.#write(
      "POST",
      `/collections/${encodeSegment(collection)}/documents`,
      context,
      document,
    )
    return result.data ?? null
  }

  /** Inserts documents one at a time (each audited), stopping at the first failure. */
  async importDocuments(
    collection: string,
    documents: readonly Readonly<Record<string, unknown>>[],
    context: WriteContext = {},
  ): Promise<number> {
    let inserted = 0
    for (const document of documents) {
      await this.insertDocument(collection, document, context)
      inserted += 1
    }
    return inserted
  }

  /** Replaces a document (`PUT`), or applies update operators (`PATCH`) when `update` is given. */
  async updateDocument(
    collection: string,
    id: unknown,
    change:
      | { readonly replacement: Readonly<Record<string, unknown>> }
      | { readonly update: Readonly<Record<string, unknown>> },
    context: WriteContext = {},
  ): Promise<Record<string, unknown> | null> {
    const path = `/collections/${encodeSegment(collection)}/documents/${encodeId(id)}`
    const result =
      "replacement" in change
        ? await this.#write("PUT", path, context, change.replacement)
        : await this.#write("PATCH", path, context, change.update)
    return result.data ?? null
  }

  async deleteDocument(
    collection: string,
    id: unknown,
    context: WriteContext = {},
  ): Promise<number> {
    const result = await this.#write(
      "DELETE",
      `/collections/${encodeSegment(collection)}/documents/${encodeId(id)}`,
      context,
    )
    return result.deleted ?? 0
  }

  async policies(collection: string, signal?: AbortSignal): Promise<StoredCollection | null> {
    const result = await this.request(
      "GET",
      `/policies/${encodeSegment(collection)}`,
      wirePolicies,
      {
        signal,
      },
    )
    return result.stored
  }

  /**
   * Validates a draft with the server's compiler and linter, which also knows the indexes. A draft the
   * server cannot read at all (422) comes back as one error instead of throwing.
   */
  async validatePolicies(
    collection: string,
    draft: PolicyDraft,
    signal?: AbortSignal,
  ): Promise<ValidationResult> {
    try {
      const result = await this.request(
        "POST",
        `/policies/${encodeSegment(collection)}/validate`,
        wireValidation,
        { body: { definition: definitionOf(draft) }, signal },
      )
      return {
        ok: result.valid,
        errors: result.findings
          .filter((finding) => finding.severity === "error")
          .map((finding) => ({ message: finding.message })),
        lint: result.findings.map((finding) => ({
          rule: finding.rule,
          severity: finding.severity,
          message: finding.message,
          ...(finding.policy === undefined ? {} : { policy: finding.policy }),
        })),
      }
    } catch (error: unknown) {
      if (statusOf(error) !== 422 || !(error instanceof Error)) throw error
      const path = (error as CanopyError).details?.["path"]
      return {
        ok: false,
        errors: [{ message: error.message, ...(typeof path === "string" ? { path } : {}) }],
        lint: [],
      }
    }
  }

  async simulate(
    collection: string,
    input: SimulationRequest,
    signal?: AbortSignal,
  ): Promise<Simulation> {
    const result = await this.request(
      "POST",
      `/policies/${encodeSegment(collection)}/simulate`,
      wireSimulation,
      {
        body: {
          definition: definitionOf(input.draft),
          as: wireAs(input.as),
          op: input.op,
          ...(input.filter === undefined ? {} : { filter: input.filter }),
          ...(input.limit === undefined ? {} : { limit: Math.min(Math.max(input.limit, 1), 100) }),
        },
        signal,
      },
    )
    const read = result.fields?.read
    return {
      allowed: result.allowed,
      ...(result.explain.bypass === undefined ? {} : { bypass: result.explain.bypass }),
      ...(result.roles === undefined ? {} : { roles: result.roles }),
      ...(result.count === undefined ? {} : { count: result.count }),
      ...(result.sample === undefined ? {} : { documents: result.sample }),
      effectiveFilter: result.allowed ? result.effectiveFilter : null,
      hiddenFields: read?.kind === "omit" ? (read.paths ?? []) : [],
      policies: result.explain.policies,
      ...(result.check === undefined ? {} : { checkPolicies: result.check.policies }),
    }
  }

  async publish(
    collection: string,
    input: {
      readonly draft: PolicyDraft
      readonly expectedVersion: number
      readonly comment: string
    },
  ): Promise<{ readonly version: number; readonly hash?: string }> {
    const result = await this.request(
      "POST",
      `/policies/${encodeSegment(collection)}/publish`,
      wirePublishResult,
      {
        body: {
          definition: definitionOf(input.draft),
          expectedVersion: input.expectedVersion,
          ...(input.comment.trim() === "" ? {} : { comment: input.comment.trim() }),
        },
      },
    )
    return {
      version: result.stored.version,
      ...(result.stored.hash === undefined ? {} : { hash: result.stored.hash }),
    }
  }

  async history(collection: string, signal?: AbortSignal): Promise<readonly HistoryEntry[]> {
    const result = await this.request(
      "GET",
      `/policies/${encodeSegment(collection)}/history`,
      wireHistory,
      { signal },
    )
    return result.data.map((entry) => ({
      version: entry.version,
      ...(entry.hash === undefined ? {} : { hash: entry.hash }),
      ...(entry.publishedAt === undefined ? {} : { updatedAt: entry.publishedAt }),
      ...(entry.publishedBy === undefined ? {} : { updatedBy: entry.publishedBy }),
      ...(entry.comment === undefined ? {} : { comment: entry.comment }),
      policies: entry.document,
    }))
  }

  async rollback(
    collection: string,
    input: {
      readonly version: number
      readonly expectedVersion: number
      readonly comment: string
    },
  ): Promise<{ readonly version: number; readonly hash?: string }> {
    const result = await this.request(
      "POST",
      `/policies/${encodeSegment(collection)}/rollback`,
      wirePublishResult,
      {
        body: {
          version: input.version,
          expectedVersion: input.expectedVersion,
          ...(input.comment.trim() === "" ? {} : { comment: input.comment.trim() }),
        },
      },
    )
    return {
      version: result.stored.version,
      ...(result.stored.hash === undefined ? {} : { hash: result.stored.hash }),
    }
  }

  /** App users of built in auth, filtered by email prefix. */
  async users(
    query: { readonly email?: string; readonly limit?: number; readonly offset?: number },
    signal?: AbortSignal,
  ): Promise<{ readonly users: readonly AppUser[]; readonly total: number }> {
    const params = new URLSearchParams()
    if (query.email) params.set("email", query.email)
    if (query.limit !== undefined) params.set("limit", String(query.limit))
    if (query.offset !== undefined && query.offset > 0) params.set("offset", String(query.offset))
    const search = params.toString()
    const result = await this.request(
      "GET",
      `/users${search === "" ? "" : `?${search}`}`,
      wireUsersPage,
      { signal },
    )
    return { users: result.data, total: result.total }
  }

  user(id: string, signal?: AbortSignal): Promise<AppUser> {
    return this.request("GET", `/users/${encodeSegment(id)}`, wireAppUser, { signal })
  }

  /** Creates a user; without a password they sign in with a link, a code or OAuth. */
  createUser(input: AppUserPatch & { readonly email: string }): Promise<AppUser> {
    return this.request("POST", "/users", wireAppUser, { body: input })
  }

  /** Creates the user if needed and emails a sign in link. */
  inviteUser(input: {
    readonly email: string
    readonly redirectTo?: string
    readonly roles?: readonly string[]
    readonly appMetadata?: Readonly<Record<string, unknown>>
  }): Promise<AppUser> {
    return this.request("POST", "/users/invite", wireAppUser, { body: input })
  }

  updateUser(id: string, patch: AppUserPatch): Promise<AppUser> {
    return this.request("PATCH", `/users/${encodeSegment(id)}`, wireAppUser, { body: patch })
  }

  /** Blocks sign in, ends every session and closes the user's realtime connections. */
  banUser(id: string, input: { readonly reason?: string; readonly until?: string } = {}) {
    return this.request("POST", `/users/${encodeSegment(id)}/ban`, wireAppUser, { body: input })
  }

  unbanUser(id: string): Promise<AppUser> {
    return this.request("POST", `/users/${encodeSegment(id)}/unban`, wireAppUser, { body: {} })
  }

  async deleteUser(id: string): Promise<void> {
    await this.request("DELETE", `/users/${encodeSegment(id)}`, empty)
  }

  async userSessions(id: string, signal?: AbortSignal): Promise<readonly AppUserSession[]> {
    const result = await this.request(
      "GET",
      `/users/${encodeSegment(id)}/sessions`,
      wireAuthSessions,
      { signal },
    )
    return result.data.map(({ userId: _userId, ...session }) => session)
  }

  /** Ends one session, or every session of the user without `sessionId`; returns how many ended. */
  async revokeUserSessions(id: string, sessionId?: string): Promise<number> {
    const path =
      sessionId === undefined
        ? `/users/${encodeSegment(id)}/sessions`
        : `/users/${encodeSegment(id)}/sessions/${encodeSegment(sessionId)}`
    const result = await this.request("DELETE", path, wireRevoked)
    return result.revoked
  }

  providers(signal?: AbortSignal): Promise<Providers> {
    return this.request("GET", "/auth/providers", wireProviders, { signal })
  }

  /** Every email kind with the template in force and the version of the set. */
  async templates(
    signal?: AbortSignal,
  ): Promise<{ readonly version: number; readonly templates: readonly EmailTemplate[] }> {
    const result = await this.request("GET", "/auth/templates", wireTemplates, { signal })
    return { version: result.version, templates: result.data }
  }

  /** Renders the template in force, or `draft`, with the server's test data. */
  async previewTemplate(
    kind: EmailKind,
    draft?: EmailTemplateBody,
    signal?: AbortSignal,
  ): Promise<EmailTemplateBody> {
    const result = await this.request(
      "POST",
      `/auth/templates/${encodeSegment(kind)}/preview`,
      wireTemplatePreview,
      { body: draft === undefined ? {} : { template: draft }, signal },
    )
    return result.rendered
  }

  /** Saves an edit; a `409` means someone saved since `expectedVersion`. */
  async saveTemplate(
    kind: EmailKind,
    input: EmailTemplateBody & { readonly expectedVersion: number; readonly comment?: string },
  ): Promise<{ readonly version: number; readonly template: EmailTemplate }> {
    const result = await this.request(
      "PUT",
      `/auth/templates/${encodeSegment(kind)}`,
      wireTemplateSaved,
      { body: input },
    )
    return { version: result.version, template: result.data }
  }

  /** Goes back to the default template of a kind. */
  async resetTemplate(
    kind: EmailKind,
    input: { readonly expectedVersion: number; readonly comment?: string },
  ): Promise<{ readonly version: number; readonly template: EmailTemplate }> {
    const params = new URLSearchParams({ expectedVersion: String(input.expectedVersion) })
    if (input.comment !== undefined && input.comment !== "") params.set("comment", input.comment)
    const result = await this.request(
      "DELETE",
      `/auth/templates/${encodeSegment(kind)}?${params.toString()}`,
      wireTemplateSaved,
    )
    return { version: result.version, template: result.data }
  }

  async templateHistory(signal?: AbortSignal): Promise<readonly EmailTemplateVersion[]> {
    const result = await this.request("GET", "/auth/templates/history", wireTemplateHistory, {
      signal,
    })
    return result.data
  }

  async signingKeys(signal?: AbortSignal): Promise<readonly SigningKey[]> {
    const result = await this.request("GET", "/auth/keys", wireSigningKeys, { signal })
    return result.data
  }

  /** Makes the standby key active now; returns the keys afterwards. */
  async rotateSigningKey(): Promise<readonly SigningKey[]> {
    const result = await this.request("POST", "/auth/keys/rotate", wireSigningKeys, { body: {} })
    return result.data
  }

  /** Revokes a key: tokens it signed stop verifying. */
  async revokeSigningKey(kid: string): Promise<readonly SigningKey[]> {
    const result = await this.request("DELETE", `/auth/keys/${encodeSegment(kid)}`, wireSigningKeys)
    return result.data
  }

  async apiKeys(signal?: AbortSignal): Promise<readonly ApiKey[]> {
    const result = await this.request("GET", "/api-keys", wireApiKeys, { signal })
    return result.data
  }

  createApiKey(input: {
    readonly name: string
    readonly kind: ApiKey["kind"]
  }): Promise<CreatedKey> {
    return this.request("POST", "/api-keys", wireCreatedKey, { body: input })
  }

  async revokeApiKey(id: string): Promise<void> {
    await this.request("DELETE", `/api-keys/${encodeSegment(id)}`, wireApiKey)
  }

  /** The OpenAPI document of the Data API as `role` sees it (`anon`, `authenticated`, `service` or custom). */
  openApi(role: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request("GET", `/openapi?role=${encodeURIComponent(role)}`, record(unknown), {
      signal,
    })
  }

  realtimeStats(signal?: AbortSignal): Promise<RealtimeStats> {
    return this.request("GET", "/realtime/stats", wireRealtimeStats, { signal })
  }

  async realtimeConnections(signal?: AbortSignal): Promise<readonly RealtimeConnection[]> {
    const result = await this.request("GET", "/realtime/connections", wireConnections, { signal })
    return result.data
  }

  async realtimeObservers(signal?: AbortSignal): Promise<readonly RealtimeObserver[]> {
    const result = await this.request("GET", "/realtime/observers", wireObservers, { signal })
    return result.data
  }

  /** The last events the engine routed, newest last, for picking one to trace. */
  async recentEvents(signal?: AbortSignal): Promise<readonly RealtimeEvent[]> {
    const result = await this.request("GET", "/realtime/events", wireRealtimeEvents, { signal })
    return result.data
  }

  async trace(eventId: string, signal?: AbortSignal): Promise<EventTrace> {
    const trace = await this.request(
      "GET",
      `/realtime/trace/${encodeSegment(eventId)}`,
      wireTrace,
      { signal },
    )
    return {
      ...trace,
      candidates: trace.candidates.map(({ dls, ...candidate }, index) => {
        const parsed = parseDls(dls, `candidates[${index}].dls`)
        return parsed === undefined ? candidate : { ...candidate, dls: parsed }
      }),
    }
  }

  /** A short lived token and the publishable key, for following data live through `@canopy/react`. */
  realtimeToken(as?: ViewAs): Promise<{ readonly token: string; readonly publishableKey: string }> {
    return this.request("POST", "/realtime/token", wireRealtimeToken, {
      body: as === undefined ? {} : { as: wireAs(as) },
    })
  }

  async doctor(signal?: AbortSignal): Promise<DoctorReport> {
    const result = await this.request("GET", "/doctor", wireDoctor, { signal })
    const named = (name: string) => result.checks.find((check) => check.name === name)
    const mongodb = named("mongodb")
    const replicaSet = named("replica-set")
    const version =
      mongodb?.status === "ok" ? /MongoDB (\S+)/.exec(mongodb.message)?.[1] : undefined
    return {
      ...(version === undefined ? {} : { serverVersion: version }),
      ...(replicaSet?.status === "ok" ? { topology: replicaSet.message } : {}),
      ...(result.status === undefined
        ? {}
        : { status: result.status === "fail" ? "error" : result.status }),
      checks: result.checks.map((check) => ({
        id: check.name,
        title: check.name,
        status: check.status === "fail" ? "error" : check.status,
        message: check.message,
        ...(check.fix === undefined ? {} : { fix: check.fix }),
        ...(check.docs === undefined ? {} : { docs: check.docs }),
      })),
    }
  }

  /** Sampled requests, newest first, filtered by surface and status (a code or a class such as `4xx`). */
  async logs(
    query: {
      readonly surface?: RequestSurface
      readonly status?: string
      readonly before?: string
      readonly limit?: number
    } = {},
    signal?: AbortSignal,
  ): Promise<LogsPage> {
    const params = new URLSearchParams()
    if (query.surface !== undefined) params.set("surface", query.surface)
    if (query.status !== undefined && query.status !== "") params.set("status", query.status)
    if (query.before !== undefined) params.set("before", query.before)
    if (query.limit !== undefined) params.set("limit", String(query.limit))
    const search = params.toString()
    const result = await this.request(
      "GET",
      `/logs${search === "" ? "" : `?${search}`}`,
      wireLogs,
      {
        signal,
      },
    )
    return {
      entries: result.data.map(({ _id, ...entry }) => ({ id: idText(_id), ...entry })),
      ...(result.next === undefined || result.next === null ? {} : { next: result.next }),
      sampleRate: result.sampleRate,
      retentionDays: result.retentionDays,
    }
  }

  /**
   * Reads the audit log, newest first. The server filters on an exact action; an action ending in a dot
   * (`policy.`) is a prefix, matched here over the latest entries.
   */
  async audit(
    query: { readonly cursor?: string; readonly action?: string; readonly limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<{ readonly entries: readonly AuditEntry[]; readonly nextCursor?: string | null }> {
    const prefix = query.action?.endsWith(".") ? query.action : undefined
    const params = new URLSearchParams()
    if (query.cursor) params.set("before", query.cursor)
    if (query.action && prefix === undefined) params.set("action", query.action)
    params.set("limit", String(prefix === undefined ? (query.limit ?? 100) : AUDIT_PREFIX_LIMIT))
    const result = await this.request("GET", `/audit?${params.toString()}`, wireAudit, { signal })
    const entries = result.data
      .filter((entry) => prefix === undefined || entry.action.startsWith(prefix))
      .map((entry): AuditEntry => {
        const as = entry.details?.["as"]
        const target = describeTarget(entry.target)
        return {
          id: idText(entry._id),
          at: entry.at,
          actor: entry.actor.email ?? entry.actor.id,
          action: entry.action,
          ...(entry.outcome === undefined ? {} : { outcome: entry.outcome }),
          ...(target === undefined ? {} : { target }),
          ...(entry.comment === undefined ? {} : { comment: entry.comment }),
          ...(entry.diff === undefined ? {} : { diff: entry.diff }),
          ...(as === undefined ? {} : { impersonating: JSON.stringify(as) }),
        }
      })
    return {
      entries,
      ...(result.next === undefined || prefix !== undefined ? {} : { nextCursor: result.next }),
    }
  }

  settings(signal?: AbortSignal): Promise<Settings> {
    return this.request("GET", "/settings", wireSettings, { signal })
  }

  updateSettings(patch: Partial<Settings>): Promise<Settings> {
    return this.request("PATCH", "/settings", wireSettings, { body: patch })
  }

  async revokeAllSessions(confirm: string): Promise<void> {
    await this.request("POST", "/settings/revoke-all-sessions", empty, {
      headers: { [CONFIRM_HEADER]: confirm },
    })
  }

  async rotateMasterKey(confirm: string): Promise<void> {
    await this.request("POST", "/settings/rotate-master-key", empty, {
      headers: { [CONFIRM_HEADER]: confirm },
    })
  }
}

export type { Admin, StoredCollection }
