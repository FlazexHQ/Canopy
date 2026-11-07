import { applyUpdate, compileFilter, compileSort } from "@canopy/matcher"
import {
  type CollectionPolicies,
  canAccess,
  createPolicySet,
  documentPaths,
  fromStored,
  hashCollection,
  PolicyEngine,
  type RequestContext,
  toFilter,
  validateCollectionPolicies,
} from "@canopy/policy"
import { as as actor, evaluateInMemory } from "@canopy/policy/testing"
import { canonicalString, decode, ErrorCode, httpStatusOf, toCanonical } from "@canopy/protocol"
import type {
  Admin,
  AdminRole,
  ApiKey,
  AppUser,
  AuditEntry,
  LogEntry,
  RealtimeConnection,
  RealtimeEvent,
  RealtimeObserver,
  StoredCollection,
  StoredPolicy,
  ViewAs,
} from "../src/api/contract.ts"
import { permissionsOf } from "../src/app/permissions.ts"
import { seedCollections, seedConnections, seedLogs, seedUsers } from "./seed.ts"

/** Options of {@link createMockAdmin}. */
export interface MockAdminOptions {
  readonly environment?: "development" | "production"
  readonly setupToken?: string
  /** Admin accounts that exist from the start; without any, Studio shows the first run claim. */
  readonly admins?: readonly (Admin & { readonly password: string })[]
  /** Whether the app user endpoints (`/users`, `/auth/*`) exist. */
  readonly appUsers?: boolean
  /** Publishes a policy for these collections at start. */
  readonly policies?: readonly StoredPolicyInput[]
  /** Interval of synthetic realtime events in the tail; 0 turns them off. */
  readonly tailIntervalMs?: number
  /** The TOTP code accepted for admins with `totp: true`. */
  readonly totpCode?: string
  readonly now?: () => number
}

/** A policy document to publish at start. */
export type StoredPolicyInput = Omit<StoredCollection, "version" | "hash">

interface Session {
  readonly id: string
  readonly csrf: string
  readonly adminId: string
}

interface CollectionState {
  exposed: boolean
  realtime: boolean
  documents: Record<string, unknown>[]
  images: "on" | "off" | "unknown"
}

interface HistoryState {
  readonly version: number
  readonly hash: string
  readonly updatedAt: string
  readonly updatedBy: string
  readonly comment?: string
  readonly policies: StoredCollection
}

/** The in memory state, exposed for assertions in tests. */
export interface MockState {
  readonly admins: (Admin & { password: string })[]
  readonly sessions: Map<string, Session>
  readonly collections: Map<string, CollectionState>
  readonly published: Map<string, StoredCollection>
  readonly history: Map<string, HistoryState[]>
  readonly apiKeys: ApiKey[]
  readonly audit: AuditEntry[]
  readonly logs: LogEntry[]
  readonly events: RealtimeEvent[]
  readonly connections: (RealtimeConnection & { claims: Record<string, unknown> | null })[]
  readonly users: AppUser[]
  settings: { publicUrl: string | null; corsOrigins: string[]; limits: Record<string, number> }
  setupToken: string
}

/** The mock: a `fetch` style handler for `/admin/v1/*` and `/rest/v1/openapi.json`. */
export interface MockAdmin {
  readonly state: MockState
  fetch(request: Request): Promise<Response>
  /** Stops the synthetic event timer. */
  close(): void
}

class HttpError extends Error {
  readonly status: number
  readonly code: string
  readonly details: Record<string, unknown> | undefined
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.status = httpStatusOf(code)
    this.code = code
    this.details = details
  }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })

function problem(error: HttpError): Response {
  return new Response(
    JSON.stringify({
      type: `urn:canopy:error:${error.code.slice(7).toLowerCase().replaceAll("_", "-")}`,
      title: error.code,
      status: error.status,
      code: error.code,
      detail: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    }),
    { status: error.status, headers: { "content-type": "application/problem+json" } },
  )
}

function randomId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return `${prefix}${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

function objectIdHex(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(ErrorCode.InvalidQuery, `${what} must be an object`)
  }
  return value as Record<string, unknown>
}

function parseJsonParam(value: string | null, what: string): Record<string, unknown> | undefined {
  if (value === null || value === "") return undefined
  try {
    return asObject(JSON.parse(value), what)
  } catch (error: unknown) {
    if (error instanceof HttpError) throw error
    throw new HttpError(ErrorCode.InvalidQuery, `${what} is not valid JSON`)
  }
}

function contextOf(viewAs: ViewAs, now: Date): RequestContext {
  return {
    roles: new Set(viewAs.roles),
    claims: viewAs.roles.includes("anon") ? null : viewAs.claims,
    now,
  }
}

function viewAsOf(value: unknown): ViewAs | undefined {
  if (value === undefined || value === null) return undefined
  const input = asObject(value, "as")
  const roles = Array.isArray(input["roles"]) ? input["roles"].map(String) : []
  if (roles.length === 0) throw new HttpError(ErrorCode.InvalidQuery, "as.roles must not be empty")
  if (roles.includes("service")) {
    throw new HttpError(ErrorCode.InvalidQuery, "Viewing as service is the default; omit as")
  }
  const claims = input["claims"] === undefined ? {} : asObject(input["claims"], "as.claims")
  return {
    roles,
    claims,
    ...(typeof input["label"] === "string" ? { label: input["label"] } : {}),
  }
}

const PASSWORD_MIN = 12

/**
 * Carries the session id in component tests, where the DOM environment drops `Cookie` and `Set-Cookie`
 * like a browser does. Browsers use the cookie.
 */
export const TEST_SESSION_HEADER = "x-canopy-mock-session"

/**
 * An in memory implementation of the admin API contract that Studio is built against. It evaluates policies
 * with the real `@canopy/policy` engine and `@canopy/matcher`, enforces the CSRF token and the admin role
 * rules, and writes an audit entry for every mutation and impersonation. It backs component tests,
 * `vite --mode mock` and the Playwright suite until the server's admin API covers every endpoint.
 */
export function createMockAdmin(options: MockAdminOptions = {}): MockAdmin {
  const now = options.now ?? Date.now
  const environment = options.environment ?? "development"
  const state: MockState = {
    admins: (options.admins ?? []).map((admin) => ({ ...admin })),
    sessions: new Map(),
    collections: new Map(
      Object.entries(seedCollections()).map(([name, documents]) => [
        name,
        {
          exposed: false,
          realtime: false,
          images: name === "todos" ? "on" : "off",
          documents: documents.map((document) => decode(document) as Record<string, unknown>),
        },
      ]),
    ),
    published: new Map(),
    history: new Map(),
    apiKeys: [
      {
        id: "key_pk_1",
        kind: "publishable",
        name: "Default publishable key",
        prefix: "canopy_pk_8f2KQ",
        key: "canopy_pk_8f2KQmTfE1c9xZ0aW3bYdL5nR7sVuH2j",
        createdAt: new Date(now() - 86_400_000 * 9).toISOString(),
        createdBy: "system",
        lastUsedAt: new Date(now() - 60_000).toISOString(),
        revokedAt: null,
      },
      {
        id: "key_sk_1",
        kind: "secret",
        name: "Backend",
        prefix: "canopy_sk_Zq81",
        createdAt: new Date(now() - 86_400_000 * 9).toISOString(),
        createdBy: "system",
        lastUsedAt: new Date(now() - 3_600_000).toISOString(),
        revokedAt: null,
      },
    ],
    audit: [],
    logs: seedLogs(now()),
    events: [],
    connections: seedConnections(now()),
    users: seedUsers(now()),
    settings: {
      publicUrl: "http://localhost:8080",
      corsOrigins: ["http://localhost:5173"],
      limits: { maxBodyBytes: 1_048_576, defaultLimit: 50, maxLimit: 1000 },
    },
    setupToken: options.setupToken ?? "canopy-setup-0000",
  }

  const publish = (
    input: Omit<StoredCollection, "version" | "hash" | "updatedAt" | "updatedBy">,
    by: string,
    comment?: string,
  ): StoredCollection => {
    const authoring = fromStored(input)
    validateCollectionPolicies(authoring)
    const previous = state.published.get(input._id)
    const version = (previous?.version ?? 0) + 1
    const stored: StoredCollection = {
      ...input,
      version,
      hash: hashCollection(authoring),
      updatedAt: new Date(now()).toISOString(),
      updatedBy: by,
    }
    state.published.set(input._id, stored)
    const history = state.history.get(input._id) ?? []
    history.unshift({
      version,
      hash: stored.hash ?? "",
      updatedAt: new Date(now()).toISOString(),
      updatedBy: by,
      ...(comment === undefined || comment === "" ? {} : { comment }),
      policies: stored,
    })
    state.history.set(input._id, history)
    const collection = state.collections.get(input._id)
    if (collection !== undefined) {
      collection.exposed = input.exposed
      collection.realtime = input.realtime
    }
    return stored
  }

  for (const policy of options.policies ?? []) publish(policy, "system")

  const audit = (entry: Omit<AuditEntry, "id" | "at">): void => {
    state.audit.unshift({ id: randomId("audit_"), at: new Date(now()).toISOString(), ...entry })
  }

  const engineFor = (collection: string, draft?: StoredCollection | StoredPolicyInput) => {
    const source = draft ?? state.published.get(collection)
    const definitions: CollectionPolicies[] = source === undefined ? [] : [fromStored(source)]
    return new PolicyEngine(createPolicySet(definitions))
  }

  const tailListeners = new Set<(event: RealtimeEvent) => void>()
  const emit = (collection: string, op: string, documentId: unknown, fields?: string[]): void => {
    const event: RealtimeEvent = {
      id: randomId("evt_"),
      ct: { $timestamp: { t: Math.floor(now() / 1000), i: state.events.length + 1 } },
      wallTime: new Date(now()).toISOString(),
      coll: collection,
      op,
      docId: toCanonical(documentId),
      ...(fields === undefined ? {} : { fields }),
    }
    state.events.unshift(event)
    state.events.length = Math.min(state.events.length, 500)
    for (const listener of tailListeners) listener(event)
  }

  const timer =
    (options.tailIntervalMs ?? 0) > 0
      ? setInterval(() => {
          const todos = state.collections.get("todos")
          const document =
            todos?.documents[Math.floor(Math.random() * (todos.documents.length || 1))]
          if (document !== undefined) emit("todos", "update", document["_id"], ["done"])
        }, options.tailIntervalMs)
      : undefined

  const sessionOf = (request: Request): { session: Session; admin: Admin } => {
    const cookie = request.headers.get("cookie") ?? ""
    const sid =
      /(?:^|;\s*)canopy_admin=([^;]+)/.exec(cookie)?.[1] ??
      request.headers.get(TEST_SESSION_HEADER) ??
      undefined
    const session = sid === undefined ? undefined : state.sessions.get(sid)
    const admin =
      session === undefined ? undefined : state.admins.find((a) => a.id === session.adminId)
    if (session === undefined || admin === undefined) {
      throw new HttpError(ErrorCode.Unauthorized, "Sign in to continue")
    }
    if (request.method !== "GET" && request.headers.get("x-canopy-csrf") !== session.csrf) {
      throw new HttpError(ErrorCode.Forbidden, "The CSRF token is missing or wrong")
    }
    const { password: _password, ...publicAdmin } = admin
    return { session, admin: publicAdmin }
  }

  const startSession = (admin: Admin): Response => {
    const session = { id: randomId("sess_"), csrf: randomId("csrf_"), adminId: admin.id }
    state.sessions.set(session.id, session)
    return json(
      200,
      { admin, csrfToken: session.csrf },
      {
        "set-cookie": `canopy_admin=${session.id}; Path=/; HttpOnly; SameSite=Strict`,
        [TEST_SESSION_HEADER]: session.id,
      },
    )
  }

  const publicAdmin = (admin: Admin & { password: string }): Admin => {
    const { password: _password, ...rest } = admin
    return rest
  }

  const requireAllowed = (allowed: boolean, what: string): void => {
    if (!allowed) throw new HttpError(ErrorCode.Forbidden, `Your admin role may not ${what}`)
  }

  const confirmDataEdit = (request: Request, collection: string): void => {
    if (environment !== "production") return
    if (request.headers.get("x-canopy-confirm") !== collection) {
      throw new HttpError(
        ErrorCode.InvalidQuery,
        `Data edits in production need the collection name ${collection} as confirmation`,
        { confirmRequired: collection },
      )
    }
  }

  const collectionState = (name: string): CollectionState => {
    const collection = state.collections.get(name)
    if (collection === undefined) throw new HttpError(ErrorCode.NotFound, `No collection ${name}`)
    return collection
  }

  const summary = (name: string, collection: CollectionState) => {
    const published = state.published.get(name)
    return {
      name,
      exposed: collection.exposed,
      realtime: collection.realtime,
      estimatedCount: collection.documents.length,
      policyVersion: published?.version ?? null,
      policyCount: published?.policies.length ?? 0,
      images: collection.images,
    }
  }

  const findById = (collection: CollectionState, encoded: string): number => {
    let id: unknown
    try {
      id = decode(JSON.parse(decodeURIComponent(encoded)))
    } catch {
      throw new HttpError(ErrorCode.InvalidQuery, "The document id is not valid EJSON")
    }
    const key = canonicalString(id)
    return collection.documents.findIndex((document) => canonicalString(document["_id"]) === key)
  }

  const fieldsOfSchema = (documents: readonly Record<string, unknown>[]) => {
    const fields = new Map<string, { types: Set<string>; count: number }>()
    const visit = (value: unknown, prefix: string) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return
      const canonical = toCanonical(value) as Record<string, unknown>
      for (const [key, inner] of Object.entries(canonical)) {
        const path = prefix === "" ? key : `${prefix}.${key}`
        const entry = fields.get(path) ?? { types: new Set<string>(), count: 0 }
        entry.count += 1
        entry.types.add(typeName(inner))
        fields.set(path, entry)
        if (typeName(inner) === "object") visit(inner, path)
      }
    }
    for (const document of documents) visit(document, "")
    return [...fields.entries()].map(([path, info]) => ({
      path,
      types: [...info.types],
      frequency: documents.length === 0 ? 0 : info.count / documents.length,
    }))
  }

  const route = async (request: Request, url: URL): Promise<Response> => {
    const path = url.pathname.slice("/admin/v1".length) || "/"
    const parts = path.split("/").filter((part) => part !== "")
    const method = request.method
    const body = async (): Promise<Record<string, unknown>> => {
      const text = await request.text()
      if (text === "") return {}
      try {
        return asObject(JSON.parse(text), "The body")
      } catch (error: unknown) {
        if (error instanceof HttpError) throw error
        throw new HttpError(ErrorCode.InvalidQuery, "The body is not valid JSON")
      }
    }

    if (path === "/setup" && method === "GET")
      return json(200, { required: state.admins.length === 0 })
    if (path === "/setup" && method === "POST") {
      if (state.admins.length > 0)
        throw new HttpError(ErrorCode.Conflict, "Studio is already set up")
      const input = await body()
      if (input["token"] !== state.setupToken) {
        throw new HttpError(ErrorCode.Unauthorized, "The setup token is wrong")
      }
      const email = String(input["email"] ?? "").trim()
      const password = String(input["password"] ?? "")
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) {
        throw new HttpError(ErrorCode.ValidationFailed, "Enter a valid email address")
      }
      if (password.length < PASSWORD_MIN) {
        throw new HttpError(
          ErrorCode.ValidationFailed,
          `The password needs at least ${PASSWORD_MIN} characters`,
        )
      }
      const owner = { id: randomId("adm_"), email, role: "owner" as const, totp: false, password }
      state.admins.push(owner)
      audit({ actor: `admin:${email}`, action: "admin.setup", target: email })
      return startSession(publicAdmin(owner))
    }
    if (path === "/login" && method === "POST") {
      const input = await body()
      const admin = state.admins.find(
        (candidate) =>
          candidate.email === input["email"] && candidate.password === input["password"],
      )
      if (admin === undefined)
        throw new HttpError(ErrorCode.Unauthorized, "Wrong email or password")
      if (admin.totp === true) {
        if (input["totp"] === undefined || input["totp"] === "") {
          throw new HttpError(
            ErrorCode.Unauthorized,
            "Enter the code from your authenticator app",
            {
              totpRequired: true,
            },
          )
        }
        if (input["totp"] !== (options.totpCode ?? "123456")) {
          throw new HttpError(ErrorCode.Unauthorized, "The authenticator code is wrong", {
            totpRequired: true,
          })
        }
      }
      audit({ actor: `admin:${admin.email}`, action: "admin.login" })
      return startSession(publicAdmin(admin))
    }

    const { session, admin } = sessionOf(request)
    const can = permissionsOf(admin.role, environment)

    if (path === "/logout" && method === "POST") {
      state.sessions.delete(session.id)
      return json(
        200,
        {},
        { "set-cookie": "canopy_admin=; Path=/; Max-Age=0", [TEST_SESSION_HEADER]: "" },
      )
    }
    if (path === "/me" && method === "GET") {
      return json(200, { admin, csrfToken: session.csrf, environment, version: "0.4.0-mock" })
    }

    const [head, second, third, fourth] = parts
    if (head === "collections") {
      if (second === undefined && method === "GET") {
        return json(200, {
          collections: [...state.collections.entries()].map(([name, collection]) =>
            summary(name, collection),
          ),
        })
      }
      if (second === undefined) throw new HttpError(ErrorCode.NotFound, "Not found")
      const name = decodeURIComponent(second)
      const collection = collectionState(name)
      if (third === undefined && method === "PATCH") {
        requireAllowed(can.publishPolicies, "change collection exposure")
        const input = await body()
        if (typeof input["exposed"] === "boolean") collection.exposed = input["exposed"]
        if (typeof input["realtime"] === "boolean") collection.realtime = input["realtime"]
        audit({
          actor: `admin:${admin.email}`,
          action: "collection.update",
          target: name,
          diff: input,
        })
        return json(200, summary(name, collection))
      }
      if (third === "schema" && method === "GET") {
        return json(200, { fields: fieldsOfSchema(collection.documents) })
      }
      if (third === "stats" && method === "GET") {
        const size = collection.documents.reduce(
          (total, document) => total + canonicalString(document).length,
          0,
        )
        return json(200, {
          count: collection.documents.length,
          size,
          avgDocumentSize:
            collection.documents.length === 0 ? 0 : Math.round(size / collection.documents.length),
          indexes: [{ name: "_id_", keys: { _id: 1 }, unique: true }],
        })
      }
      if (third === "documents") {
        return documents(request, url, name, collection, admin, can, fourth, body)
      }
    }

    if (head === "policies" && second !== undefined) {
      const name = decodeURIComponent(second)
      if (third === undefined && method === "GET") {
        return json(200, { published: state.published.get(name) ?? null })
      }
      if (third === "validate" && method === "POST") {
        const input = await body()
        const draft = asObject(input["draft"], "draft")
        try {
          validateCollectionPolicies(fromStored({ ...draft, _id: name }))
          return json(200, { ok: true, errors: [] })
        } catch (error: unknown) {
          return json(200, { ok: false, errors: [{ message: (error as Error).message }] })
        }
      }
      if (third === "simulate" && method === "POST") {
        requireAllowed(can.draftPolicies, "simulate policies")
        return simulate(name, await body())
      }
      if (third === "publish" && method === "POST") {
        requireAllowed(can.publishPolicies, "publish policies")
        const input = await body()
        const draft = asObject(input["draft"], "draft") as unknown as StoredPolicyInput
        const comment = typeof input["comment"] === "string" ? input["comment"].trim() : ""
        if (can.publishNeedsComment && comment === "") {
          throw new HttpError(
            ErrorCode.ValidationFailed,
            "Publishing in production needs a comment",
          )
        }
        const current = state.published.get(name)?.version ?? 0
        if (input["expectedVersion"] !== current) {
          throw new HttpError(
            ErrorCode.Conflict,
            `The policies changed since you loaded them: version ${current} is published`,
            { currentVersion: current },
          )
        }
        let stored: StoredCollection
        try {
          stored = publish({ ...draft, _id: name }, `admin:${admin.email}`, comment)
        } catch (error: unknown) {
          throw new HttpError(ErrorCode.ValidationFailed, (error as Error).message)
        }
        audit({
          actor: `admin:${admin.email}`,
          action: "policy.publish",
          target: name,
          ...(comment === "" ? {} : { comment }),
          diff: { version: stored.version },
        })
        return json(200, { version: stored.version, hash: stored.hash })
      }
      if (third === "history" && method === "GET") {
        return json(200, { versions: state.history.get(name) ?? [] })
      }
      if (third === "rollback" && method === "POST") {
        requireAllowed(can.publishPolicies, "roll back policies")
        const input = await body()
        const current = state.published.get(name)?.version ?? 0
        if (input["expectedVersion"] !== current) {
          throw new HttpError(ErrorCode.Conflict, `Version ${current} is published now`, {
            currentVersion: current,
          })
        }
        const target = (state.history.get(name) ?? []).find(
          (entry) => entry.version === input["version"],
        )
        if (target === undefined) throw new HttpError(ErrorCode.NotFound, "No such version")
        const comment =
          typeof input["comment"] === "string" && input["comment"] !== ""
            ? input["comment"]
            : `Roll back to version ${target.version}`
        const { version: _v, hash: _h, updatedAt: _u, updatedBy: _b, ...body2 } = target.policies
        const stored = publish(body2, `admin:${admin.email}`, comment)
        audit({
          actor: `admin:${admin.email}`,
          action: "policy.rollback",
          target: name,
          comment,
          diff: { from: current, to: target.version, version: stored.version },
        })
        return json(200, { version: stored.version, hash: stored.hash })
      }
    }

    if (head === "users" || head === "auth") {
      if (options.appUsers === false) throw new HttpError(ErrorCode.NotFound, "Not found")
      return auth(request, url, parts, admin, can, body)
    }

    if (head === "api-keys") {
      if (second === undefined && method === "GET") {
        return json(200, {
          keys: state.apiKeys.map((key) => (key.kind === "secret" ? { ...key, key: null } : key)),
        })
      }
      if (second === undefined && method === "POST") {
        const input = await body()
        const kind = input["kind"] === "secret" ? "secret" : "publishable"
        requireAllowed(
          can.createKeys === "all" || (can.createKeys === "publishable" && kind === "publishable"),
          `create ${kind} keys`,
        )
        const name = String(input["name"] ?? "").trim()
        if (name === "") throw new HttpError(ErrorCode.ValidationFailed, "A key needs a name")
        const secret = `canopy_${kind === "secret" ? "sk" : "pk"}_${randomId("").slice(0, 32)}`
        const info: ApiKey = {
          id: randomId("key_"),
          kind,
          name,
          prefix: secret.slice(0, 15),
          ...(kind === "publishable" ? { key: secret } : {}),
          createdAt: new Date(now()).toISOString(),
          createdBy: `admin:${admin.email}`,
          lastUsedAt: null,
          revokedAt: null,
        }
        state.apiKeys.push(info)
        audit({ actor: `admin:${admin.email}`, action: "api_key.create", target: info.id })
        return json(201, { key: secret, info })
      }
      if (second !== undefined && method === "DELETE") {
        const key = state.apiKeys.find((candidate) => candidate.id === decodeURIComponent(second))
        if (key === undefined) throw new HttpError(ErrorCode.NotFound, "No such key")
        requireAllowed(
          can.createKeys === "all" ||
            (can.createKeys === "publishable" && key.kind === "publishable"),
          "revoke this key",
        )
        const index = state.apiKeys.indexOf(key)
        state.apiKeys[index] = {
          ...key,
          revokedAt: new Date(now()).toISOString(),
          revokedBy: `admin:${admin.email}`,
        }
        audit({ actor: `admin:${admin.email}`, action: "api_key.revoke", target: key.id })
        return json(200, {})
      }
    }

    if (head === "realtime") return realtime(request, parts)

    if (path === "/doctor" && method === "GET") {
      const unpolicied = [...state.collections.entries()].filter(
        ([name, collection]) =>
          collection.exposed &&
          !(state.published.get(name)?.policies ?? []).some((policy: StoredPolicy) =>
            policy.ops.includes("read"),
          ),
      )
      return json(200, {
        topology: "replica set (rs0, 1 member)",
        serverVersion: "8.0.4",
        checks: [
          {
            id: "topology",
            title: "Replica set",
            status: "ok",
            message: "Replica set rs0 with 1 member",
          },
          {
            id: "version",
            title: "MongoDB version",
            status: "ok",
            message: "MongoDB 8.0.4, feature compatibility 8.0",
          },
          {
            id: "privileges",
            title: "Privileges",
            status: "ok",
            message: "find and changeStream on the app database; readWrite on canopy",
          },
          {
            id: "oplog",
            title: "Oplog window",
            status: "warn",
            message: "The oplog covers 6 hours of writes",
            fix: "Grow the oplog to cover at least 24 hours: db.adminCommand({ replSetResizeOplog: 1, size: 4096 })",
            docs: "https://canopy.dev/docs/operations/oplog",
          },
          {
            id: "same-deployment",
            title: "Meta and app database",
            status: "ok",
            message: "Both live on the same deployment",
          },
          {
            id: "images",
            title: "Pre and post images",
            status: "info",
            message: "Enabled on todos; off on other realtime collections",
            fix: "canopy realtime enable-images <collection>",
          },
          unpolicied.length === 0
            ? {
                id: "read-policies",
                title: "Read policies",
                status: "ok",
                message: "Every exposed collection has a read policy",
              }
            : {
                id: "read-policies",
                title: "Read policies",
                status: "warn",
                message: `Exposed without a read policy: ${unpolicied.map(([name]) => name).join(", ")}`,
                fix: "Add a read policy in Policies, or stop exposing the collection",
              },
          {
            id: "master-key",
            title: "Master key",
            status: environment === "production" ? "ok" : "info",
            message: "CANOPY_MASTER_KEY is set and strong",
          },
          { id: "clock", title: "Clock skew", status: "ok", message: "12 ms against MongoDB" },
          {
            id: "cors",
            title: "CORS origins",
            status: state.settings.corsOrigins.length === 0 ? "warn" : "ok",
            message:
              state.settings.corsOrigins.length === 0
                ? "No CORS origins are configured, so browsers cannot call the API"
                : `${state.settings.corsOrigins.length} origins configured`,
            ...(state.settings.corsOrigins.length === 0
              ? { fix: "Add your app's origin in Settings" }
              : {}),
          },
        ],
      })
    }
    if (path === "/logs" && method === "GET") {
      const errors = state.logs.filter((entry) => entry.status >= 400).length
      return json(200, {
        entries: state.logs,
        nextCursor: null,
        summary: {
          requestsPerSecond: 42.5,
          errorRate: state.logs.length === 0 ? 0 : errors / state.logs.length,
        },
      })
    }
    if (path === "/audit" && method === "GET") {
      const action = url.searchParams.get("action")
      return json(200, {
        entries:
          action === null || action === ""
            ? state.audit
            : state.audit.filter((entry) => entry.action.startsWith(action)),
        nextCursor: null,
      })
    }
    if (path === "/settings") {
      if (method === "GET") {
        return json(200, settingsBody())
      }
      if (method === "PATCH") {
        requireAllowed(can.manageSettings, "change settings")
        const input = await body()
        if (input["publicUrl"] !== undefined) {
          state.settings.publicUrl = input["publicUrl"] === null ? null : String(input["publicUrl"])
        }
        if (Array.isArray(input["corsOrigins"])) {
          const origins = input["corsOrigins"].map(String)
          for (const origin of origins) {
            if (!/^https?:\/\/[^/\s]+$/.test(origin)) {
              throw new HttpError(ErrorCode.ValidationFailed, `${origin} is not an origin`)
            }
          }
          state.settings.corsOrigins = origins
        }
        if (typeof input["limits"] === "object" && input["limits"] !== null) {
          state.settings.limits = {
            ...state.settings.limits,
            ...(input["limits"] as Record<string, number>),
          }
        }
        audit({ actor: `admin:${admin.email}`, action: "settings.update", diff: input })
        return json(200, settingsBody())
      }
    }
    if (path === "/settings/revoke-all-sessions" && method === "POST") {
      requireAllowed(can.dangerZone, "use the danger zone")
      if (request.headers.get("x-canopy-confirm") !== "revoke all sessions") {
        throw new HttpError(ErrorCode.InvalidQuery, "Confirm with the phrase revoke all sessions")
      }
      audit({ actor: `admin:${admin.email}`, action: "danger.revoke_all_sessions" })
      return json(200, {})
    }
    if (path === "/settings/rotate-master-key" && method === "POST") {
      requireAllowed(can.dangerZone, "use the danger zone")
      if (request.headers.get("x-canopy-confirm") !== "rotate master key") {
        throw new HttpError(ErrorCode.InvalidQuery, "Confirm with the phrase rotate master key")
      }
      audit({ actor: `admin:${admin.email}`, action: "danger.rotate_master_key" })
      return json(200, {})
    }
    throw new HttpError(ErrorCode.NotFound, `No admin endpoint ${method} ${path}`)
  }

  const settingsBody = () => ({
    ...state.settings,
    realtime: {
      mode: "change stream, one per deployment",
      collections: [...state.collections.entries()]
        .filter(([, collection]) => collection.realtime)
        .map(([name, collection]) => ({ name, images: collection.images })),
    },
    admins: state.admins.map(publicAdmin),
  })

  const documents = async (
    request: Request,
    url: URL,
    name: string,
    collection: CollectionState,
    admin: Admin,
    can: ReturnType<typeof permissionsOf>,
    idSegment: string | undefined,
    body: () => Promise<Record<string, unknown>>,
  ): Promise<Response> => {
    const method = request.method
    const at = new Date(now())
    if (method === "GET" && idSegment === undefined) {
      const filter = parseJsonParam(url.searchParams.get("filter"), "filter") ?? {}
      const sort = parseJsonParam(url.searchParams.get("sort"), "sort")
      const viewAs = viewAsOf(parseJsonParam(url.searchParams.get("as"), "as"))
      const limit = Math.min(Number(url.searchParams.get("limit") ?? "50") || 50, 1000)
      const skip = Number(url.searchParams.get("skip") ?? "0") || 0
      let effective: Record<string, unknown> = filter
      let hidden: string[] = []
      let project = (document: Record<string, unknown>) => document
      if (viewAs !== undefined) {
        requireAllowed(can.impersonate, "view data as another identity")
        const engine = engineFor(name)
        const ctx = contextOf(viewAs, at)
        if (!engine.isExposed(name)) {
          return json(200, { documents: [], total: 0, hiddenFields: [] })
        }
        effective = toFilter(engine.effectiveRead(name, filter, ctx))
        const readable = engine.readable(name, ctx)
        project = (document) => {
          const out: Record<string, unknown> = {}
          for (const [key, value] of Object.entries(document))
            if (canAccess(readable, key)) out[key] = value
          return out
        }
        hidden = [
          ...new Set(collection.documents.flatMap((document) => documentPaths(document))),
        ].filter((path) => !canAccess(readable, path))
        audit({
          actor: `admin:${admin.email}`,
          action: "impersonation.view",
          target: name,
          impersonating: viewAs.label ?? JSON.stringify(viewAs.claims),
        })
      }
      let test: (document: Record<string, unknown>) => boolean
      try {
        const compiled = compileFilter(decode(effective))
        test = (document) => compiled.matches(document)
      } catch (error: unknown) {
        throw new HttpError(ErrorCode.InvalidQuery, (error as Error).message)
      }
      let matched = collection.documents.filter(test)
      if (sort !== undefined && Object.keys(sort).length > 0) {
        const comparator = compileSort(sort)
        matched = [...matched].sort(comparator)
      }
      return json(200, {
        documents: matched
          .slice(skip, skip + limit)
          .map((document) => toCanonical(project(document))),
        total: matched.length,
        hiddenFields: hidden,
      })
    }
    requireAllowed(can.writeData, "edit data")
    confirmDataEdit(request, name)
    const writeAs = async () => {
      const input = method === "DELETE" ? {} : await body()
      const rawAs =
        method === "DELETE" ? parseJsonParam(url.searchParams.get("as"), "as") : input["as"]
      const viewAs = viewAsOf(rawAs)
      const reason =
        method === "DELETE"
          ? (url.searchParams.get("reason") ?? "")
          : typeof input["reason"] === "string"
            ? input["reason"]
            : ""
      if (viewAs !== undefined && reason.trim() === "") {
        throw new HttpError(ErrorCode.InvalidQuery, "Writing as another identity needs a reason")
      }
      return { input, viewAs, reason }
    }
    if (method === "POST" && idSegment === undefined) {
      const { input, viewAs, reason } = await writeAs()
      if (Array.isArray(input["documents"])) {
        const added = input["documents"].map((raw) => {
          const document = decode(asObject(raw, "Each document")) as Record<string, unknown>
          return document["_id"] === undefined
            ? { _id: decode({ $oid: objectIdHex() }), ...document }
            : document
        })
        collection.documents.push(...added)
        for (const document of added) emit(name, "insert", document["_id"])
        audit({
          actor: `admin:${admin.email}`,
          action: "document.import",
          target: name,
          diff: { inserted: added.length },
        })
        return json(200, { inserted: added.length })
      }
      const raw = asObject(input["document"], "document")
      const document = decode(raw) as Record<string, unknown>
      const withId =
        document["_id"] === undefined
          ? { _id: decode({ $oid: objectIdHex() }), ...document }
          : document
      if (viewAs !== undefined) {
        const outcome = evaluateInMemory(engineFor(name), {
          suite: "studio",
          collection: name,
          actor: { label: viewAs.label ?? "user", roles: viewAs.roles, claims: viewAs.claims },
          action: "insert",
          doc: withId,
          expected: true,
        })
        if (!outcome.allowed)
          throw new HttpError(ErrorCode.PolicyViolation, `Denied: ${outcome.reason}`)
      }
      const key = canonicalString(withId["_id"])
      if (collection.documents.some((existing) => canonicalString(existing["_id"]) === key)) {
        throw new HttpError(ErrorCode.DuplicateKey, "A document with this _id exists")
      }
      collection.documents.push(withId)
      emit(name, "insert", withId["_id"])
      audit({
        actor: `admin:${admin.email}`,
        action: "document.insert",
        target: `${name}/${canonicalString(withId["_id"])}`,
        ...(reason === "" ? {} : { comment: reason }),
        ...(viewAs === undefined
          ? {}
          : { impersonating: viewAs.label ?? JSON.stringify(viewAs.claims) }),
        diff: { after: toCanonical(withId) },
      })
      return json(201, { document: toCanonical(withId) })
    }
    if (idSegment === undefined) throw new HttpError(ErrorCode.NotFound, "Not found")
    const index = findById(collection, idSegment)
    if (index < 0) throw new HttpError(ErrorCode.NotFound, "No document with this _id")
    const existing = collection.documents[index] as Record<string, unknown>
    if (method === "PATCH") {
      const { input, viewAs, reason } = await writeAs()
      let next: Record<string, unknown>
      if (input["replacement"] !== undefined) {
        const replacement = decode(asObject(input["replacement"], "replacement")) as Record<
          string,
          unknown
        >
        if (
          replacement["_id"] !== undefined &&
          canonicalString(replacement["_id"]) !== canonicalString(existing["_id"])
        ) {
          throw new HttpError(ErrorCode.InvalidQuery, "The _id of a document cannot change")
        }
        next = { _id: existing["_id"], ...replacement }
      } else {
        const update = decode(asObject(input["update"], "update")) as Record<string, unknown>
        try {
          next = applyUpdate(existing, update)
        } catch (error: unknown) {
          throw new HttpError(ErrorCode.InvalidQuery, (error as Error).message)
        }
      }
      if (viewAs !== undefined) {
        const engine = engineFor(name)
        const outcome = evaluateInMemory(engine, {
          suite: "studio",
          collection: name,
          actor: { label: viewAs.label ?? "user", roles: viewAs.roles, claims: viewAs.claims },
          action: "update",
          doc: existing,
          update:
            input["update"] !== undefined
              ? (decode(input["update"]) as Record<string, unknown>)
              : { $set: Object.fromEntries(Object.entries(next).filter(([key]) => key !== "_id")) },
          expected: true,
        })
        if (!outcome.allowed)
          throw new HttpError(ErrorCode.PolicyViolation, `Denied: ${outcome.reason}`)
      }
      collection.documents[index] = next
      emit(
        name,
        "update",
        next["_id"],
        Object.keys(next).filter((key) => key !== "_id"),
      )
      audit({
        actor: `admin:${admin.email}`,
        action: "document.update",
        target: `${name}/${canonicalString(existing["_id"])}`,
        ...(reason === "" ? {} : { comment: reason }),
        ...(viewAs === undefined
          ? {}
          : { impersonating: viewAs.label ?? JSON.stringify(viewAs.claims) }),
        diff: { before: toCanonical(existing), after: toCanonical(next) },
      })
      return json(200, { document: toCanonical(next) })
    }
    if (method === "DELETE") {
      const { viewAs, reason } = await writeAs()
      if (viewAs !== undefined) {
        const outcome = evaluateInMemory(engineFor(name), {
          suite: "studio",
          collection: name,
          actor: { label: viewAs.label ?? "user", roles: viewAs.roles, claims: viewAs.claims },
          action: "delete",
          doc: existing,
          expected: true,
        })
        if (!outcome.allowed) return json(200, { deleted: 0 })
      }
      collection.documents.splice(index, 1)
      emit(name, "delete", existing["_id"])
      audit({
        actor: `admin:${admin.email}`,
        action: "document.delete",
        target: `${name}/${canonicalString(existing["_id"])}`,
        ...(reason === "" ? {} : { comment: reason }),
        diff: { before: toCanonical(existing) },
      })
      return json(200, { deleted: 1 })
    }
    throw new HttpError(ErrorCode.NotFound, "Not found")
  }

  const simulate = (name: string, input: Record<string, unknown>): Response => {
    const draft = {
      ...asObject(input["draft"], "draft"),
      _id: name,
    } as unknown as StoredPolicyInput
    let engine: PolicyEngine
    try {
      engine = engineFor(name, draft)
    } catch (error: unknown) {
      throw new HttpError(ErrorCode.ValidationFailed, (error as Error).message)
    }
    const viewAs = viewAsOf(input["as"]) ?? { roles: ["anon"], claims: {} }
    const op = String(input["op"] ?? "read") as "read" | "insert" | "update" | "delete"
    const ctx = contextOf(viewAs, new Date(now()))
    const collection = state.collections.get(name)
    const clause = op === "insert" ? "check" : "using"
    const explanation = engine.explain(name, op, ctx, clause)
    const readable = engine.readable(name, ctx)
    const hiddenFields = [
      ...new Set((collection?.documents ?? []).flatMap((document) => documentPaths(document))),
    ].filter((path) => !canAccess(readable, path))
    const policies = explanation.policies.map((policy) => ({
      ...policy,
      ...(policy.resolved === undefined ? {} : { resolved: toCanonical(policy.resolved) }),
    }))
    if (op === "read") {
      const filter =
        input["filter"] === undefined
          ? {}
          : (decode(asObject(input["filter"], "filter")) as Record<string, unknown>)
      if (!engine.isExposed(name)) {
        return json(200, {
          allowed: false,
          effectiveFilter: null,
          count: 0,
          documents: [],
          policies,
          hiddenFields,
          violations: ["The collection is not exposed"],
        })
      }
      const effective = engine.effectiveRead(name, filter, ctx)
      if (effective.kind === "deny") {
        return json(200, {
          allowed: false,
          effectiveFilter: null,
          count: 0,
          documents: [],
          policies,
          hiddenFields,
        })
      }
      const compiled = compileFilter(toFilter(effective))
      const matched = (collection?.documents ?? []).filter((document) => compiled.matches(document))
      const limit = typeof input["limit"] === "number" ? input["limit"] : 20
      return json(200, {
        allowed: true,
        bypass: explanation.bypass,
        effectiveFilter: toCanonical(toFilter(effective)),
        count: matched.length,
        documents: matched.slice(0, limit).map((document) => {
          const out: Record<string, unknown> = {}
          for (const [key, value] of Object.entries(document))
            if (canAccess(readable, key)) out[key] = value
          return toCanonical(out)
        }),
        policies,
        hiddenFields,
      })
    }
    const document = decode(asObject(input["document"] ?? {}, "document")) as Record<
      string,
      unknown
    >
    const update =
      input["update"] === undefined
        ? undefined
        : (decode(asObject(input["update"], "update")) as Record<string, unknown>)
    const outcome = evaluateInMemory(
      engine,
      {
        suite: "studio",
        collection: name,
        actor: viewAs.roles.includes("anon")
          ? actor.anon()
          : { label: viewAs.label ?? "user", roles: viewAs.roles, claims: viewAs.claims },
        action: op,
        doc: document,
        ...(update === undefined ? {} : { update }),
        expected: true,
      },
      new Date(now()),
    )
    const compiled =
      op === "delete"
        ? engine.target(name, "delete", ctx)
        : op === "update"
          ? engine.target(name, "update", ctx)
          : engine.check(name, "insert", ctx)
    return json(200, {
      allowed: outcome.allowed,
      bypass: explanation.bypass,
      effectiveFilter: compiled.kind === "deny" ? null : toCanonical(toFilter(compiled)),
      policies,
      hiddenFields,
      ...(outcome.allowed ? {} : { violations: [outcome.reason] }),
    })
  }

  const auth = async (
    request: Request,
    url: URL,
    parts: readonly string[],
    admin: Admin,
    can: ReturnType<typeof permissionsOf>,
    body: () => Promise<Record<string, unknown>>,
  ): Promise<Response> => {
    const [head, second, third] = parts
    const method = request.method
    if (head === "users") {
      if (second === undefined && method === "GET") {
        const search = (url.searchParams.get("search") ?? "").toLowerCase()
        const users = state.users.filter(
          (user) =>
            search === "" ||
            (user.email ?? "").toLowerCase().includes(search) ||
            user.id.includes(search),
        )
        return json(200, { users, nextCursor: null })
      }
      const user = state.users.find(
        (candidate) => candidate.id === decodeURIComponent(second ?? ""),
      )
      if (user === undefined) throw new HttpError(ErrorCode.NotFound, "No such user")
      if (third === undefined && method === "GET") return json(200, user)
      requireAllowed(can.manageUsers, "manage app users")
      if (third === undefined && method === "PATCH") {
        const input = await body()
        const index = state.users.indexOf(user)
        const next = {
          ...user,
          ...(typeof input["banned"] === "boolean" ? { banned: input["banned"] } : {}),
        }
        state.users[index] = next
        audit({
          actor: `admin:${admin.email}`,
          action: input["banned"] === true ? "user.ban" : "user.update",
          target: user.id,
        })
        return json(200, next)
      }
      if (third === undefined && method === "DELETE") {
        state.users.splice(state.users.indexOf(user), 1)
        audit({ actor: `admin:${admin.email}`, action: "user.delete", target: user.id })
        return json(200, {})
      }
      if (third === "revoke-sessions" && method === "POST") {
        const index = state.users.indexOf(user)
        state.users[index] = { ...user, sessions: [] }
        audit({ actor: `admin:${admin.email}`, action: "user.revoke_sessions", target: user.id })
        return json(200, {})
      }
    }
    if (head === "auth" && second === "providers") {
      if (method === "GET") {
        return json(200, {
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
        })
      }
    }
    if (head === "auth" && second === "templates" && method === "GET") {
      return json(200, {
        templates: [
          {
            id: "verification",
            subject: "Confirm your email",
            body: "Hi {{name}}, confirm with {{link}}.",
          },
          {
            id: "magic-link",
            subject: "Your sign in link",
            body: "Sign in with {{link}}. It expires in 10 minutes.",
          },
          { id: "reset", subject: "Reset your password", body: "Reset it with {{link}}." },
        ],
      })
    }
    if (head === "auth" && second === "keys") {
      if (third === undefined && method === "GET") {
        return json(200, {
          keys: [
            {
              kid: "k_2026_10",
              alg: "EdDSA",
              status: "active",
              createdAt: new Date(now() - 86_400_000 * 30).toISOString(),
            },
            {
              kid: "k_2026_11",
              alg: "EdDSA",
              status: "standby",
              createdAt: new Date(now() - 86_400_000).toISOString(),
            },
          ],
        })
      }
      if (third === "rotate" && method === "POST") {
        requireAllowed(can.manageSettings, "rotate signing keys")
        audit({ actor: `admin:${admin.email}`, action: "auth.rotate_signing_key" })
        return json(200, { kid: "k_2026_11" })
      }
    }
    throw new HttpError(ErrorCode.NotFound, "Not found")
  }

  const realtime = (request: Request, parts: readonly string[]): Response => {
    const [, second, third] = parts
    if (second === "stats") {
      const t = now()
      const history = Array.from({ length: 60 }, (_, index) => {
        const at = t - (59 - index) * 5000
        return {
          t: at,
          lagMs: Math.round(40 + 25 * Math.sin(at / 40_000) + (index % 7) * 3),
          eventsPerSecond: Math.round(18 + 6 * Math.cos(at / 30_000)),
        }
      })
      return json(200, {
        connections: state.connections.filter((connection) => connection.connected).length,
        sessions: state.connections.length,
        subscriptions: state.connections.reduce(
          (total, connection) => total + connection.subscriptions.length,
          0,
        ),
        observers: { matcher: observers().filter((o) => o.type === "matcher").length, polling: 0 },
        subjects: new Set(state.connections.map((connection) => connection.subject)).size,
        policyVersion:
          [...state.published.values()]
            .map((policy) => policy.hash)
            .join("")
            .slice(0, 16) || "sha256:none",
        streamPosition: { $timestamp: { t: Math.floor(t / 1000), i: 1 } },
        collections: [...state.collections.entries()]
          .filter(([, c]) => c.realtime)
          .map(([name]) => name),
        lagMs: history.at(-1)?.lagMs ?? 0,
        eventsPerSecond: history.at(-1)?.eventsPerSecond ?? 0,
        history,
      })
    }
    if (second === "connections") {
      return json(200, {
        connections: state.connections.map(({ claims: _claims, ...connection }) => connection),
      })
    }
    if (second === "observers") return json(200, { observers: observers() })
    if (second === "tail") return tail(request)
    if (second === "trace" && third !== undefined)
      return json(200, trace(decodeURIComponent(third)))
    throw new HttpError(ErrorCode.NotFound, "Not found")
  }

  const observers = (): RealtimeObserver[] => {
    const seen = new Map<string, RealtimeObserver>()
    for (const connection of state.connections) {
      for (const subscription of connection.subscriptions) {
        const existing = seen.get(subscription.observer)
        if (existing !== undefined) {
          seen.set(subscription.observer, { ...existing, subscribers: existing.subscribers + 1 })
          continue
        }
        const engine = engineFor(subscription.coll)
        const ctx = contextOf(
          { roles: connection.roles, claims: connection.claims ?? {} },
          new Date(now()),
        )
        const compiled = engine.using(subscription.coll, "read", ctx)
        seen.set(subscription.observer, {
          key: subscription.observer,
          coll: subscription.coll,
          type: "matcher",
          status: "live",
          subscribers: 1,
          filter:
            compiled.kind === "deny"
              ? { _id: { $in: [] } }
              : (toCanonical(toFilter(compiled)) as Record<string, unknown>),
          sort: null,
          limit: null,
          candidatesPerEvent: 1.4,
          matchCostMicros: 3.2,
        })
      }
    }
    return [...seen.values()]
  }

  const trace = (id: string) => {
    const event = state.events.find((candidate) => candidate.id === id)
    if (event === undefined)
      throw new HttpError(ErrorCode.NotFound, "The event is no longer in the trace buffer")
    const collection = state.collections.get(event.coll)
    const key = canonicalString(event.docId)
    const document = collection?.documents.find(
      (candidate) => canonicalString(toCanonical(candidate["_id"])) === key,
    )
    const engine = engineFor(event.coll)
    const candidates = observers()
      .filter((observer) => observer.coll === event.coll)
      .map((observer) => {
        const subscribers = state.connections.filter((connection) =>
          connection.subscriptions.some((subscription) => subscription.observer === observer.key),
        )
        const delivered: { sid: string; sub: string; subject: string }[] = []
        const filteredOut: { sid: string; subject: string; policy?: string; reason?: string }[] = []
        for (const connection of subscribers) {
          const subscription = connection.subscriptions.find((s) => s.observer === observer.key)
          const ctx = contextOf(
            { roles: connection.roles, claims: connection.claims ?? {} },
            new Date(now()),
          )
          const visible =
            document !== undefined && engine.isExposed(event.coll)
              ? (() => {
                  const compiled = engine.using(event.coll, "read", ctx)
                  return (
                    compiled.kind !== "deny" && compileFilter(toFilter(compiled)).matches(document)
                  )
                })()
              : event.op === "delete"
          if (visible) {
            delivered.push({
              sid: connection.sid,
              sub: subscription?.id ?? "",
              subject: connection.subject,
            })
          } else {
            const explanation = engine.explain(event.coll, "read", ctx)
            const responsible = explanation.policies.find(
              (policy) => policy.kind === "permissive" && policy.applies,
            )
            filteredOut.push({
              sid: connection.sid,
              subject: connection.subject,
              ...(responsible === undefined ? {} : { policy: responsible.name }),
              reason:
                responsible === undefined
                  ? "No read policy applies to this subscriber"
                  : `The document does not match "${responsible.name}"`,
            })
          }
        }
        return {
          observer: observer.key,
          type: observer.type,
          outcome:
            delivered.length > 0
              ? event.op === "insert"
                ? "entered"
                : event.op === "delete"
                  ? "left"
                  : "updated"
              : "unmatched",
          subscribers: delivered,
          filteredOut,
        }
      })
    return { ...event, policyVersion: state.published.get(event.coll)?.hash ?? "none", candidates }
  }

  const tail = (request: Request): Response => {
    const encoder = new TextEncoder()
    let cleanup = () => {}
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(": connected\n\n"))
        for (const event of [...state.events].slice(0, 20).reverse()) {
          controller.enqueue(encoder.encode(`event: change\ndata: ${JSON.stringify(event)}\n\n`))
        }
        const listener = (event: RealtimeEvent) => {
          try {
            controller.enqueue(encoder.encode(`event: change\ndata: ${JSON.stringify(event)}\n\n`))
          } catch {
            cleanup()
          }
        }
        tailListeners.add(listener)
        const ping = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": ping\n\n"))
          } catch {
            cleanup()
          }
        }, 15_000)
        cleanup = () => {
          tailListeners.delete(listener)
          clearInterval(ping)
        }
        request.signal.addEventListener("abort", () => {
          cleanup()
          try {
            controller.close()
          } catch {
            // Already closed by the client.
          }
        })
      },
      cancel() {
        cleanup()
      },
    })
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    })
  }

  const openapi = (): Response => {
    const paths: Record<string, unknown> = {}
    for (const [name, collection] of state.collections) {
      if (!collection.exposed) continue
      paths[`/rest/v1/${name}`] = {
        get: {
          summary: `List ${name}`,
          tags: [name],
          responses: { "200": { description: "Documents" } },
        },
        post: {
          summary: `Insert into ${name}`,
          tags: [name],
          responses: { "201": { description: "Inserted" } },
        },
      }
      paths[`/rest/v1/${name}/{id}`] = {
        get: {
          summary: `Get one of ${name}`,
          tags: [name],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Document" } },
        },
      }
    }
    return json(200, {
      openapi: "3.1.0",
      info: { title: "Canopy Data API", version: "0.4.0-mock" },
      paths,
    })
  }

  return {
    state,
    async fetch(request) {
      const url = new URL(request.url)
      try {
        if (url.pathname === "/rest/v1/openapi.json") return openapi()
        if (!url.pathname.startsWith("/admin/v1"))
          throw new HttpError(ErrorCode.NotFound, "Not found")
        return await route(request, url)
      } catch (error: unknown) {
        if (error instanceof HttpError) return problem(error)
        return problem(
          new HttpError(ErrorCode.Internal, error instanceof Error ? error.message : String(error)),
        )
      }
    },
    close() {
      if (timer !== undefined) clearInterval(timer)
    },
  }
}

function typeName(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  if (typeof value === "string") return "string"
  if (typeof value === "boolean") return "bool"
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "double"
  if (typeof value === "object") {
    if ("$oid" in value) return "objectId"
    if ("$date" in value) return "date"
    if ("$numberLong" in value) return "long"
    if ("$numberDecimal" in value) return "decimal"
    return "object"
  }
  return typeof value
}

export type { AdminRole }
