import { CanopyError, ErrorCode, isErrorCode } from "@canopy/protocol"
import {
  type Admin,
  type ApiKey,
  type AppUser,
  apiKeysSchema,
  appUserSchema,
  auditSchema,
  bulkInsertResultSchema,
  type CollectionStats,
  type CollectionSummary,
  type CreatedKey,
  collectionSchema,
  collectionSchemaSchema,
  collectionStatsSchema,
  collectionsSchema,
  connectionsSchema,
  createdKeySchema,
  type DoctorReport,
  type DocumentsPage,
  deleteResultSchema,
  doctorSchema,
  documentResultSchema,
  documentsPageSchema,
  type EmailTemplate,
  type EventTrace,
  type FieldInfo,
  type HistoryEntry,
  historySchema,
  type LogsPage,
  logsSchema,
  type Me,
  meSchema,
  observersSchema,
  type Providers,
  policyDocumentSchema,
  providersSchema,
  publishResultSchema,
  type RealtimeConnection,
  type RealtimeObserver,
  type RealtimeStats,
  realtimeStatsSchema,
  realtimeTokenSchema,
  rotateResultSchema,
  type Session,
  type Settings,
  type SetupStatus,
  type SigningKey,
  type SimulatedOperation,
  type Simulation,
  type StoredCollection,
  sessionSchema,
  settingsSchema,
  setupStatusSchema,
  signingKeysSchema,
  simulationSchema,
  storedCollectionSchema,
  templatesSchema,
  traceSchema,
  usersPageSchema,
  type ValidationResult,
  type ViewAs,
  validationSchema,
} from "./contract.ts"
import { object, type Schema } from "./schema.ts"

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

/** Arguments of a policy simulation. */
export interface SimulationRequest {
  readonly draft: PolicyDraft
  readonly as: ViewAs
  readonly op: SimulatedOperation
  readonly filter?: Readonly<Record<string, unknown>>
  readonly document?: Readonly<Record<string, unknown>>
  readonly update?: Readonly<Record<string, unknown>>
  readonly limit?: number
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

/** The `_id` of a document as it travels in a URL: its canonical EJSON. */
export function encodeId(id: unknown): string {
  return encodeSegment(JSON.stringify(id))
}

const empty = object({})

/**
 * A typed client of the admin API (`/admin/v1`). It sends the admin session cookie, adds the CSRF token to
 * mutating requests, validates every response against the documented contract, and turns Problem Details
 * into {@link CanopyError}s whose `details.status` holds the HTTP status.
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

  /** The CSRF token in use: the last one the server returned, else the double submit cookie. */
  csrfToken(): string | undefined {
    if (this.#csrf !== undefined) return this.#csrf
    for (const part of this.#cookies().split(";")) {
      const [name, ...rest] = part.trim().split("=")
      if (name !== undefined && CSRF_COOKIES.includes(name))
        return decodeURIComponent(rest.join("="))
    }
    return undefined
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
      readonly signal?: AbortSignal
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
      if (response.status === 401) this.#onUnauthorized?.()
      throw new CanopyError(code, message, { details: { ...details, status: response.status } })
    }
    const parsed = schema.parse(body)
    const token = (parsed as { csrfToken?: unknown }).csrfToken
    if (typeof token === "string") this.#csrf = token
    return parsed
  }

  setupStatus(signal?: AbortSignal): Promise<SetupStatus> {
    return this.request("GET", "/setup", setupStatusSchema, { ...(signal ? { signal } : {}) })
  }

  setup(input: {
    readonly token: string
    readonly email: string
    readonly password: string
  }): Promise<Session> {
    return this.request("POST", "/setup", sessionSchema, { body: input })
  }

  login(input: {
    readonly email: string
    readonly password: string
    readonly totp?: string
  }): Promise<Session> {
    return this.request("POST", "/login", sessionSchema, { body: input })
  }

  async logout(): Promise<void> {
    await this.request("POST", "/logout", empty)
    this.#csrf = undefined
  }

  me(signal?: AbortSignal): Promise<Me> {
    return this.request("GET", "/me", meSchema, { ...(signal ? { signal } : {}) })
  }

  async collections(signal?: AbortSignal): Promise<readonly CollectionSummary[]> {
    const result = await this.request("GET", "/collections", collectionsSchema, {
      ...(signal ? { signal } : {}),
    })
    return result.collections
  }

  updateCollection(
    name: string,
    patch: { readonly exposed?: boolean; readonly realtime?: boolean },
  ): Promise<CollectionSummary> {
    return this.request("PATCH", `/collections/${encodeSegment(name)}`, collectionSchema, {
      body: patch,
    })
  }

  async collectionSchema(name: string, signal?: AbortSignal): Promise<readonly FieldInfo[]> {
    const result = await this.request(
      "GET",
      `/collections/${encodeSegment(name)}/schema`,
      collectionSchemaSchema,
      { ...(signal ? { signal } : {}) },
    )
    return result.fields
  }

  collectionStats(name: string, signal?: AbortSignal): Promise<CollectionStats> {
    return this.request("GET", `/collections/${encodeSegment(name)}/stats`, collectionStatsSchema, {
      ...(signal ? { signal } : {}),
    })
  }

  documents(
    collection: string,
    query: DocumentQuery,
    signal?: AbortSignal,
  ): Promise<DocumentsPage> {
    const params = new URLSearchParams()
    if (query.filter !== undefined) params.set("filter", JSON.stringify(query.filter))
    if (query.sort !== undefined) params.set("sort", JSON.stringify(query.sort))
    if (query.projection !== undefined) params.set("projection", JSON.stringify(query.projection))
    if (query.limit !== undefined) params.set("limit", String(query.limit))
    if (query.skip !== undefined) params.set("skip", String(query.skip))
    if (query.as !== undefined) params.set("as", JSON.stringify(query.as))
    const search = params.toString()
    return this.request(
      "GET",
      `/collections/${encodeSegment(collection)}/documents${search === "" ? "" : `?${search}`}`,
      documentsPageSchema,
      { ...(signal ? { signal } : {}) },
    )
  }

  #writeHeaders(context: WriteContext): Record<string, string> {
    return context.confirm === undefined ? {} : { [CONFIRM_HEADER]: context.confirm }
  }

  #writeBody(context: WriteContext): Record<string, unknown> {
    return {
      ...(context.as === undefined ? {} : { as: context.as }),
      ...(context.reason === undefined ? {} : { reason: context.reason }),
    }
  }

  async insertDocument(
    collection: string,
    document: Readonly<Record<string, unknown>>,
    context: WriteContext = {},
  ): Promise<Record<string, unknown> | null> {
    const result = await this.request(
      "POST",
      `/collections/${encodeSegment(collection)}/documents`,
      documentResultSchema,
      { body: { document, ...this.#writeBody(context) }, headers: this.#writeHeaders(context) },
    )
    return result.document
  }

  async importDocuments(
    collection: string,
    documents: readonly Readonly<Record<string, unknown>>[],
    context: WriteContext = {},
  ): Promise<number> {
    const result = await this.request(
      "POST",
      `/collections/${encodeSegment(collection)}/documents`,
      bulkInsertResultSchema,
      { body: { documents, ...this.#writeBody(context) }, headers: this.#writeHeaders(context) },
    )
    return result.inserted
  }

  /** Replaces a document, or applies an update document when `update` is given. */
  async updateDocument(
    collection: string,
    id: unknown,
    change:
      | { readonly replacement: Readonly<Record<string, unknown>> }
      | { readonly update: Readonly<Record<string, unknown>> },
    context: WriteContext = {},
  ): Promise<Record<string, unknown> | null> {
    const result = await this.request(
      "PATCH",
      `/collections/${encodeSegment(collection)}/documents/${encodeId(id)}`,
      documentResultSchema,
      { body: { ...change, ...this.#writeBody(context) }, headers: this.#writeHeaders(context) },
    )
    return result.document
  }

  async deleteDocument(
    collection: string,
    id: unknown,
    context: WriteContext = {},
  ): Promise<number> {
    const params = new URLSearchParams()
    if (context.reason !== undefined) params.set("reason", context.reason)
    if (context.as !== undefined) params.set("as", JSON.stringify(context.as))
    const search = params.toString()
    const result = await this.request(
      "DELETE",
      `/collections/${encodeSegment(collection)}/documents/${encodeId(id)}${search === "" ? "" : `?${search}`}`,
      deleteResultSchema,
      { headers: this.#writeHeaders(context) },
    )
    return result.deleted
  }

  async policies(collection: string, signal?: AbortSignal): Promise<StoredCollection | null> {
    const result = await this.request(
      "GET",
      `/policies/${encodeSegment(collection)}`,
      policyDocumentSchema,
      { ...(signal ? { signal } : {}) },
    )
    return result.published
  }

  validatePolicies(
    collection: string,
    draft: PolicyDraft,
    signal?: AbortSignal,
  ): Promise<ValidationResult> {
    return this.request(
      "POST",
      `/policies/${encodeSegment(collection)}/validate`,
      validationSchema,
      {
        body: { draft },
        ...(signal ? { signal } : {}),
      },
    )
  }

  simulate(
    collection: string,
    input: SimulationRequest,
    signal?: AbortSignal,
  ): Promise<Simulation> {
    return this.request(
      "POST",
      `/policies/${encodeSegment(collection)}/simulate`,
      simulationSchema,
      {
        body: input,
        ...(signal ? { signal } : {}),
      },
    )
  }

  publish(
    collection: string,
    input: {
      readonly draft: PolicyDraft
      readonly expectedVersion: number
      readonly comment: string
    },
  ): Promise<{ readonly version: number; readonly hash?: string }> {
    return this.request(
      "POST",
      `/policies/${encodeSegment(collection)}/publish`,
      publishResultSchema,
      {
        body: input,
      },
    )
  }

  async history(collection: string, signal?: AbortSignal): Promise<readonly HistoryEntry[]> {
    const result = await this.request(
      "GET",
      `/policies/${encodeSegment(collection)}/history`,
      historySchema,
      { ...(signal ? { signal } : {}) },
    )
    return result.versions
  }

  rollback(
    collection: string,
    input: { readonly version: number; readonly expectedVersion: number; readonly comment: string },
  ): Promise<{ readonly version: number; readonly hash?: string }> {
    return this.request(
      "POST",
      `/policies/${encodeSegment(collection)}/rollback`,
      publishResultSchema,
      {
        body: input,
      },
    )
  }

  users(
    query: { readonly search?: string; readonly cursor?: string },
    signal?: AbortSignal,
  ): Promise<{ readonly users: readonly AppUser[]; readonly nextCursor?: string | null }> {
    const params = new URLSearchParams()
    if (query.search) params.set("search", query.search)
    if (query.cursor) params.set("cursor", query.cursor)
    const search = params.toString()
    return this.request("GET", `/users${search === "" ? "" : `?${search}`}`, usersPageSchema, {
      ...(signal ? { signal } : {}),
    })
  }

  user(id: string, signal?: AbortSignal): Promise<AppUser> {
    return this.request("GET", `/users/${encodeSegment(id)}`, appUserSchema, {
      ...(signal ? { signal } : {}),
    })
  }

  updateUser(id: string, patch: { readonly banned?: boolean }): Promise<AppUser> {
    return this.request("PATCH", `/users/${encodeSegment(id)}`, appUserSchema, { body: patch })
  }

  async deleteUser(id: string): Promise<void> {
    await this.request("DELETE", `/users/${encodeSegment(id)}`, empty)
  }

  async revokeUserSessions(id: string): Promise<void> {
    await this.request("POST", `/users/${encodeSegment(id)}/revoke-sessions`, empty)
  }

  providers(signal?: AbortSignal): Promise<Providers> {
    return this.request("GET", "/auth/providers", providersSchema, {
      ...(signal ? { signal } : {}),
    })
  }

  saveProviders(providers: Providers): Promise<Providers> {
    return this.request("PUT", "/auth/providers", providersSchema, { body: providers })
  }

  async templates(signal?: AbortSignal): Promise<readonly EmailTemplate[]> {
    const result = await this.request("GET", "/auth/templates", templatesSchema, {
      ...(signal ? { signal } : {}),
    })
    return result.templates
  }

  async signingKeys(signal?: AbortSignal): Promise<readonly SigningKey[]> {
    const result = await this.request("GET", "/auth/keys", signingKeysSchema, {
      ...(signal ? { signal } : {}),
    })
    return result.keys
  }

  rotateSigningKey(): Promise<{ readonly kid: string }> {
    return this.request("POST", "/auth/keys/rotate", rotateResultSchema)
  }

  async apiKeys(signal?: AbortSignal): Promise<readonly ApiKey[]> {
    const result = await this.request("GET", "/api-keys", apiKeysSchema, {
      ...(signal ? { signal } : {}),
    })
    return result.keys
  }

  createApiKey(input: {
    readonly name: string
    readonly kind: ApiKey["kind"]
  }): Promise<CreatedKey> {
    return this.request("POST", "/api-keys", createdKeySchema, { body: input })
  }

  async revokeApiKey(id: string): Promise<void> {
    await this.request("DELETE", `/api-keys/${encodeSegment(id)}`, empty)
  }

  realtimeStats(signal?: AbortSignal): Promise<RealtimeStats> {
    return this.request("GET", "/realtime/stats", realtimeStatsSchema, {
      ...(signal ? { signal } : {}),
    })
  }

  async realtimeConnections(signal?: AbortSignal): Promise<readonly RealtimeConnection[]> {
    const result = await this.request("GET", "/realtime/connections", connectionsSchema, {
      ...(signal ? { signal } : {}),
    })
    return result.connections
  }

  async realtimeObservers(signal?: AbortSignal): Promise<readonly RealtimeObserver[]> {
    const result = await this.request("GET", "/realtime/observers", observersSchema, {
      ...(signal ? { signal } : {}),
    })
    return result.observers
  }

  trace(eventId: string, signal?: AbortSignal): Promise<EventTrace> {
    return this.request("GET", `/realtime/trace/${encodeSegment(eventId)}`, traceSchema, {
      ...(signal ? { signal } : {}),
    })
  }

  /** A short lived token and the publishable key, for following data live through `@canopy/react`. */
  realtimeToken(as?: ViewAs): Promise<{ readonly token: string; readonly publishableKey: string }> {
    return this.request("POST", "/realtime/token", realtimeTokenSchema, {
      body: as === undefined ? {} : { as },
    })
  }

  doctor(signal?: AbortSignal): Promise<DoctorReport> {
    return this.request("GET", "/doctor", doctorSchema, { ...(signal ? { signal } : {}) })
  }

  logs(query: { readonly cursor?: string } = {}, signal?: AbortSignal): Promise<LogsPage> {
    const search = query.cursor === undefined ? "" : `?cursor=${encodeURIComponent(query.cursor)}`
    return this.request("GET", `/logs${search}`, logsSchema, { ...(signal ? { signal } : {}) })
  }

  audit(query: { readonly cursor?: string; readonly action?: string } = {}, signal?: AbortSignal) {
    const params = new URLSearchParams()
    if (query.cursor) params.set("cursor", query.cursor)
    if (query.action) params.set("action", query.action)
    const search = params.toString()
    return this.request("GET", `/audit${search === "" ? "" : `?${search}`}`, auditSchema, {
      ...(signal ? { signal } : {}),
    })
  }

  settings(signal?: AbortSignal): Promise<Settings> {
    return this.request("GET", "/settings", settingsSchema, { ...(signal ? { signal } : {}) })
  }

  updateSettings(
    patch: Partial<Pick<Settings, "publicUrl" | "corsOrigins" | "limits">>,
  ): Promise<Settings> {
    return this.request("PATCH", "/settings", settingsSchema, { body: patch })
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
export { storedCollectionSchema }
