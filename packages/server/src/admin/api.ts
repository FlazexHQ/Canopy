import { randomUUID } from "node:crypto"
import type { UserAdmin } from "@canopy/auth"
import type { ResolvedConfig } from "@canopy/config"
import {
  type ContextDefinitions,
  type ContextResolver,
  explainAccess,
  fieldAccess,
  formatAccessReport,
  OPERATIONS,
  type Operation,
  PolicyEngine,
  projectReadable,
  type RequestContext,
  Role,
  toFilter,
} from "@canopy/policy"
import {
  CanopyError,
  ErrorCode,
  encode,
  ForbiddenError,
  isDocument,
  NotFoundError,
  parse,
  ValidationError,
} from "@canopy/protocol"
import type { Logger, Realtime } from "@canopy/realtime"
import {
  type Caller,
  findParamsFromQuery,
  type IdType,
  parseId,
  ReadPath,
  readBody,
  SchemaCache,
  type WritePath,
  type WriteRequest,
} from "@canopy/rest"
import type { MongoClient } from "mongodb"
import type { ApiKeys } from "../api-keys.ts"
import type { Actor, AuditInput, AuditLog, RequestOrigin } from "../audit.ts"
import { migrationStatus } from "../migrations.ts"
import {
  collectionName,
  contextsInput,
  definitionFromInput,
  hashContexts,
  type PolicyStore,
} from "../policy-store.ts"
import {
  array,
  boolean,
  document,
  integer,
  object,
  oneOf,
  optional,
  string,
  unknownValue,
} from "../schema.ts"
import { type AdminAccounts, type AdminSession, actorOf, csrfHash } from "./accounts.ts"
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  checkOrigin,
  cookie,
  csrfFailure,
  isMutating,
  json,
  problem,
  SESSION_COOKIE,
  sameSecret,
  secure,
  setCookie,
} from "./http.ts"
import { ADMIN_ROLES, can, type Permission } from "./rbac.ts"
import { type SettingsStore, settingsPatch } from "./settings.ts"

/** Everything the admin API works on. */
export interface AdminApiOptions {
  readonly config: ResolvedConfig
  readonly client: MongoClient
  readonly accounts: AdminAccounts
  readonly audit: AuditLog
  readonly policies: PolicyStore
  readonly keys: ApiKeys
  readonly settings: SettingsStore
  /** The policies in force. */
  readonly engine: () => PolicyEngine
  readonly contexts: ContextResolver
  readonly writes: WritePath
  readonly realtime: Realtime | undefined
  readonly logger: Logger
  /** Origins allowed to send state changing requests, besides the request's own origin. */
  readonly origins?: readonly string[]
  /** Built in auth, when the config chooses it: serves `/admin/v1/users` and `/admin/v1/auth/keys`. */
  readonly auth?: AdminAuth
}

/** What the admin API needs from built in auth. */
export interface AdminAuth {
  readonly users: UserAdmin
  readonly keys: {
    list(): readonly unknown[]
    rotate(): Promise<readonly unknown[]>
    revoke(kid: string): Promise<boolean>
  }
}

/** The admin API: a Web standard handler for `/admin/v1/*`. */
export interface AdminApi {
  /** `info.ip` is the peer address, used for login limits and the audit log. */
  fetch(request: Request, info?: { readonly ip?: string }): Promise<Response>
}

interface Context {
  readonly request: Request
  readonly url: URL
  readonly params: Readonly<Record<string, string>>
  readonly origin: RequestOrigin
  /** Set on every route but the public ones. */
  readonly session: AdminSession
  readonly actor: Actor
  body(): Promise<unknown>
  /** Writes an audit entry for this request. */
  audit(input: Omit<AuditInput, "actor" | "origin">): Promise<void>
}

interface Route {
  readonly method: string
  readonly path: readonly string[]
  /** `public` routes run without a session. */
  readonly permission: Permission | "public"
  /** The audit action of a state changing route, recorded automatically when the handler does not. */
  readonly action?: string
  handler(context: Context): Promise<Response>
}

const MAX_BODY = 1024 * 1024
const MASK = "[masked]"
const NO_SESSION = Symbol("no session")

const asInput = object({
  role: optional(string({ min: 1, max: 200 })),
  roles: optional(array(string({ min: 1, max: 200 }), { max: 32 })),
  user: optional(string({ min: 1, max: 500 })),
  claims: optional(document()),
})

function mask(
  original: Record<string, unknown>,
  visible: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(original)) {
    if (!Object.hasOwn(visible, key)) out[key] = MASK
    else if (isDocument(value) && isDocument(visible[key])) out[key] = mask(value, visible[key])
    else out[key] = visible[key]
  }
  return out
}

/**
 * Builds the admin API. Every route needs a session (cookie or bearer) except setup and login; cookie
 * sessions must send the CSRF token and an allowed `Origin` on every state changing request; each route
 * checks its permission against the role read fresh from the account; and every state changing request is
 * written to `canopy.audit_log`, including refused ones.
 */
export function createAdminApi(options: AdminApiOptions): AdminApi {
  const { config, accounts, audit, policies, keys, settings, realtime } = options
  const environment = config.environment
  const production = environment === "production"
  const app = options.client.db(config.mongodb.database)
  const schemas = new SchemaCache(app)
  const idTypes: Readonly<Record<string, IdType>> = Object.fromEntries(
    Object.entries(config.collections).map(([name, c]) => [name, c.idType]),
  )
  const serviceReads = new ReadPath({
    client: options.client,
    database: config.mongodb.database,
    policies: options.engine,
  })
  const service: Caller = {
    context: { roles: new Set([Role.Service]), claims: null, now: new Date() },
    subject: "service",
  }
  const allowedOrigins = new Set<string>(options.origins ?? [])
  if (config.publicUrl !== undefined) allowedOrigins.add(new URL(config.publicUrl).origin)

  const parseJsonParam = (url: URL, name: string): unknown => {
    const text = url.searchParams.get(name)
    if (text === null) return undefined
    try {
      return parse(text)
    } catch (error: unknown) {
      throw new ValidationError(`${name} must be EJSON`, { cause: error })
    }
  }

  /** The request context of an impersonated caller, with its context lookups resolved. */
  const impersonate = async (
    input: unknown,
    collection: string,
    engine: PolicyEngine,
  ): Promise<{
    readonly context: RequestContext
    readonly subject: string
    readonly as: unknown
  }> => {
    const as = asInput.parse(input, "as")
    const roles = new Set<string>([
      ...(as.role === undefined ? [] : [as.role]),
      ...(as.roles ?? []),
    ])
    let claims: Record<string, unknown> | null = null
    if (as.user !== undefined || as.claims !== undefined) {
      claims = { ...(as.claims ?? {}), ...(as.user === undefined ? {} : { sub: as.user }) }
      roles.add(Role.Authenticated)
    }
    if (roles.size === 0) throw new ValidationError("as needs a role, a user or claims")
    if (roles.has(Role.Service))
      throw new ValidationError("Impersonating service is not allowed; act as service directly")
    if (roles.has(Role.Anon) && roles.size > 1)
      throw new ValidationError("anon cannot be combined with other roles")
    const base: RequestContext = { roles, claims, now: new Date() }
    const names = engine.contextNames([collection], roles)
    const context =
      names.length === 0
        ? base
        : { ...base, ctx: (await options.contexts.resolve(engine.set.contexts, names, base)).ctx }
    const subject = typeof claims?.["sub"] === "string" ? claims["sub"] : [...roles].join(",")
    return { context, subject, as }
  }

  const routes: Route[] = []
  const route = (
    method: string,
    path: string,
    permission: Route["permission"],
    handler: Route["handler"],
    action?: string,
  ): void => {
    routes.push({
      method,
      path: path.split("/").filter((part) => part !== ""),
      permission,
      handler,
      ...(action === undefined ? {} : { action }),
    })
  }

  const require = (context: Context, permission: Permission): void => {
    if (!can(context.session.user.role, permission, environment))
      throw new ForbiddenError(`The ${context.session.user.role} role may not do this`)
  }

  const confirmWrite = (context: Context, collection: string): void => {
    if (!production) return
    if (context.request.headers.get("x-canopy-confirm") !== collection)
      throw new CanopyError(
        ErrorCode.Forbidden,
        `Data edits in production need typed confirmation: send x-canopy-confirm: ${collection}`,
        { details: { reason: "confirmation" } },
      )
  }

  // Session

  route("GET", "setup", "public", async () => json({ claimed: await accounts.hasOwner() }))

  route(
    "POST",
    "setup",
    "public",
    async (context) => {
      const body = object({
        token: string({ min: 1, max: 200 }),
        email: string({ min: 3, max: 320 }),
        password: string({ min: 1, max: 1024 }),
        name: optional(string({ max: 200 })),
      }).parse(await context.body())
      const claimed = await accounts.claim(body, context.origin)
      return json(claimed, 201)
    },
    "setup.claim",
  )

  route(
    "POST",
    "login",
    "public",
    async (context) => {
      const body = object({
        email: string({ min: 1, max: 320 }),
        password: string({ min: 1, max: 1024 }),
        totp: optional(string({ min: 1, max: 12 })),
        transport: optional(oneOf("cookie", "bearer")),
      }).parse(await context.body())
      const transport = body.transport ?? "cookie"
      const result = await accounts.login(body, context.origin, transport)
      const payload = {
        user: result.user,
        csrfToken: result.csrfToken,
        expiresAt: result.expiresAt,
        ...(transport === "bearer" ? { token: result.token } : {}),
      }
      const response = json(payload)
      if (transport === "cookie") {
        const maxAge = (result.expiresAt.getTime() - Date.now()) / 1000
        response.headers.append(
          "set-cookie",
          setCookie(SESSION_COOKIE, result.token, { maxAgeSeconds: maxAge, httpOnly: true }),
        )
        response.headers.append(
          "set-cookie",
          setCookie(CSRF_COOKIE, result.csrfToken, { maxAgeSeconds: maxAge, httpOnly: false }),
        )
      }
      return response
    },
    "session.login",
  )

  route(
    "POST",
    "logout",
    "session",
    async (context) => {
      await accounts.logout(context.session, context.origin)
      const response = new Response(null, { status: 204 })
      response.headers.append(
        "set-cookie",
        setCookie(SESSION_COOKIE, "", { maxAgeSeconds: 0, httpOnly: true }),
      )
      response.headers.append(
        "set-cookie",
        setCookie(CSRF_COOKIE, "", { maxAgeSeconds: 0, httpOnly: false }),
      )
      return response
    },
    "session.logout",
  )

  route("GET", "me", "session", async (context) =>
    json({
      user: context.session.user,
      environment,
      expiresAt: context.session.expiresAt,
      permissions: (
        [
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
      ).filter((permission) => can(context.session.user.role, permission, environment)),
    }),
  )

  route(
    "POST",
    "me/password",
    "session",
    async (context) => {
      const body = object({
        current: string({ min: 1, max: 1024 }),
        next: string({ min: 1, max: 1024 }),
      }).parse(await context.body())
      await accounts.changePassword(context.session, body.current, body.next, context.origin)
      return new Response(null, { status: 204 })
    },
    "admin.password.change",
  )

  route(
    "POST",
    "me/totp",
    "session",
    async (context) => json(await accounts.enrollTotp(context.session, context.origin), 201),
    "admin.totp.enroll",
  )

  route(
    "POST",
    "me/totp/confirm",
    "session",
    async (context) => {
      const body = object({ code: string({ min: 1, max: 12 }) }).parse(await context.body())
      await accounts.confirmTotp(context.session, body.code, context.origin)
      return new Response(null, { status: 204 })
    },
    "admin.totp.confirm",
  )

  // Admins

  route("GET", "admins", "admins.read", async () => json({ data: await accounts.list() }))

  route(
    "POST",
    "admins",
    "admins.manage",
    async (context) => {
      const body = object({
        email: string({ min: 3, max: 320 }),
        role: oneOf(...ADMIN_ROLES),
        name: optional(string({ max: 200 })),
      }).parse(await context.body())
      return json(await accounts.create(context.session, body, context.origin), 201)
    },
    "admin.create",
  )

  route(
    "PATCH",
    "admins/:id",
    "admins.manage",
    async (context) => {
      const body = object({
        role: optional(oneOf(...ADMIN_ROLES)),
        disabled: optional(boolean()),
        name: optional(string({ max: 200 })),
      }).parse(await context.body())
      return json({
        user: await accounts.update(
          context.session,
          context.params["id"] ?? "",
          body,
          context.origin,
        ),
      })
    },
    "admin.update",
  )

  route(
    "POST",
    "admins/:id/reset-totp",
    "admins.manage",
    async (context) =>
      json({
        user: await accounts.resetTotp(
          context.params["id"] ?? "",
          context.actor,
          context.session,
          context.origin,
        ),
      }),
    "admin.totp.reset",
  )

  route(
    "DELETE",
    "admins/:id",
    "admins.manage",
    async (context) => {
      await accounts.remove(context.session, context.params["id"] ?? "", context.origin)
      return new Response(null, { status: 204 })
    },
    "admin.remove",
  )

  // Collections

  route("GET", "collections", "collections.read", async () => {
    const engine = options.engine()
    const listed = await app.listCollections({}, { nameOnly: false }).toArray()
    const names = new Set<string>(
      listed.filter((c) => !c.name.startsWith("system.")).map((c) => c.name),
    )
    for (const name of engine.set.collections.keys()) names.add(name)
    const stored = (await policies.all()).stored
    const data = [...names].sort().map((name) => {
      const info = listed.find((c) => c.name === name)
      const def = engine.collection(name)
      return {
        name,
        type: info?.type ?? "missing",
        exists: info !== undefined,
        exposed: def?.exposed === true,
        realtime: def?.realtime === true,
        policies: def?.policies.length ?? 0,
        version: stored.get(name)?.version ?? 0,
        hash: engine.set.hashes.get(name),
      }
    })
    return json({ data })
  })

  route(
    "PATCH",
    "collections/:collection",
    "collections.write",
    async (context) => {
      const collection = collectionName(context.params["collection"] ?? "")
      const body = object({
        exposed: optional(boolean()),
        realtime: optional(boolean()),
        expectedVersion: integer({ min: 0 }),
        comment: optional(string({ max: 2000 })),
      }).parse(await context.body())
      if (production && (body.comment === undefined || body.comment.trim() === ""))
        throw new ValidationError("Publishing in production needs a comment")
      const current = (await policies.all()).definitions.get(collection) ?? {
        collection,
        exposed: false,
        realtime: false,
        policies: [],
      }
      const result = await policies.publish(
        {
          definition: {
            ...current,
            ...(body.exposed === undefined ? {} : { exposed: body.exposed }),
            ...(body.realtime === undefined ? {} : { realtime: body.realtime }),
          },
          expectedVersion: body.expectedVersion,
          actor: context.actor,
          origin: context.origin,
          ...(body.comment === undefined ? {} : { comment: body.comment }),
        },
        "collection.update",
      )
      return json(result)
    },
    "collection.update",
  )

  route("GET", "collections/:collection/schema", "collections.read", async (context) => {
    const collection = collectionName(context.params["collection"] ?? "")
    const found = await schemas.all([collection])
    return json({ collection, schema: found.get(collection) ?? null })
  })

  route("GET", "collections/:collection/stats", "collections.read", async (context) => {
    const collection = collectionName(context.params["collection"] ?? "")
    const exists =
      (await app.listCollections({ name: collection }, { nameOnly: true }).toArray()).length > 0
    if (!exists) throw new NotFoundError(`The collection ${collection} does not exist`)
    const [stats] = await app
      .collection(collection)
      .aggregate<{ storageStats?: Record<string, unknown> }>([{ $collStats: { storageStats: {} } }])
      .toArray()
    const storage = stats?.storageStats ?? {}
    const indexes = await app.collection(collection).indexes()
    return json({
      collection,
      documents: storage["count"] ?? 0,
      size: storage["size"] ?? 0,
      averageDocumentSize: storage["avgObjSize"] ?? 0,
      storageSize: storage["storageSize"] ?? 0,
      totalIndexSize: storage["totalIndexSize"] ?? 0,
      indexes: indexes.map((index) => ({
        name: index.name,
        key: index.key,
        unique: index.unique === true,
        ...(index.expireAfterSeconds === undefined
          ? {}
          : { expireAfterSeconds: index.expireAfterSeconds }),
      })),
    })
  })

  // Documents

  const findDocuments = async (context: Context, id?: string): Promise<Response> => {
    const collection = collectionName(context.params["collection"] ?? "")
    const asParam = parseJsonParam(context.url, "as")
    const query = new URLSearchParams()
    for (const [name, value] of context.url.searchParams)
      if (name !== "as" && name !== "count") query.append(name, value)
    const role = context.session.user.role
    let caller: Caller = service
    let impersonated: unknown
    if (asParam !== undefined) {
      require(context, "documents.viewAs")
      const engine = options.engine()
      const as = await impersonate(asParam, collection, engine)
      caller = { context: as.context, subject: as.subject }
      impersonated = as.as
    }
    const reads = serviceReads
    let docs: Record<string, unknown>[]
    let extra: Record<string, unknown> = {}
    if (id === undefined) {
      const params = findParamsFromQuery(query, { maxLimit: 1000, maxSkip: 10_000 }, undefined)
      const result = await reads.find(
        caller,
        {
          collection,
          filter: params.filter,
          ...(params.sort === undefined ? {} : { sort: params.sort }),
          ...(params.fields === undefined ? {} : { fields: params.fields }),
          ...(params.limit === undefined ? {} : { limit: params.limit }),
          ...(params.skip === undefined ? {} : { skip: params.skip }),
          ...(params.after === undefined ? {} : { after: params.after }),
        },
        { signal: context.request.signal },
      )
      docs = [...result.docs]
      extra = { page: { limit: result.limit, next: result.next }, ct: result.ct }
    } else {
      const result = await reads.findById(
        caller,
        collection,
        parseId(id, idTypes[collection] ?? "auto"),
        undefined,
        { signal: context.request.signal },
      )
      if (result.doc === null) throw new NotFoundError("Document not found")
      docs = [result.doc]
      extra = { ct: result.ct }
    }
    let masked = false
    if (asParam === undefined && role === "viewer") {
      const access = fieldAccess(
        options.engine().collection(collection)?.fields?.read,
        new Set([Role.Authenticated]),
      )
      docs = docs.map((doc) => mask(doc, projectReadable(access, doc)))
      masked = true
    }
    if (impersonated !== undefined)
      await context.audit({
        action: "documents.viewAs",
        target: { collection, ...(id === undefined ? {} : { id }) },
        details: { as: impersonated, query: Object.fromEntries(query) },
      })
    return json({
      data: id === undefined ? docs : docs[0],
      ...extra,
      ...(masked ? { masked: true } : {}),
    })
  }

  route("GET", "collections/:collection/documents", "documents.read", (context) =>
    findDocuments(context),
  )
  route("GET", "collections/:collection/documents/:id", "documents.read", (context) =>
    findDocuments(context, context.params["id"] ?? ""),
  )

  const writeDocument = async (
    context: Context,
    build: (collection: string, body: unknown) => WriteRequest,
    action: string,
  ): Promise<Response> => {
    const collection = collectionName(context.params["collection"] ?? "")
    confirmWrite(context, collection)
    const body = await context.body()
    const asParam = parseJsonParam(context.url, "as")
    let caller: Caller = service
    let impersonated: unknown
    let reason: string | undefined
    if (asParam !== undefined) {
      require(context, "documents.writeAs")
      reason = context.url.searchParams.get("reason")?.trim()
      if (reason === undefined || reason === "")
        throw new ValidationError("Writing as another caller needs a reason")
      const as = await impersonate(asParam, collection, options.engine())
      caller = { context: as.context, subject: as.subject }
      impersonated = as.as
    }
    const request = build(collection, body)
    const before =
      "id" in request
        ? await app.collection(collection).findOne({ _id: request.id as never })
        : undefined
    const result = await options.writes.execute(caller, request, { mutationId: randomUUID() })
    await context.audit({
      action: impersonated === undefined ? action : `${action}As`,
      target: {
        collection,
        ids: result.changedIds.length > 0 ? result.changedIds : result.insertedIds,
      },
      diff: { before: before ?? null, after: result.documents?.[0] ?? null },
      ...(reason === undefined ? {} : { comment: reason }),
      ...(impersonated === undefined ? {} : { details: { as: impersonated } }),
    })
    return json(
      {
        data: result.documents?.[0] ?? null,
        matched: result.matched,
        modified: result.modified,
        deleted: result.deleted,
        insertedIds: result.insertedIds,
        ct: result.ct,
      },
      request.op === "insert" ? 201 : 200,
    )
  }

  const idOf = (context: Context, collection: string): unknown =>
    parseId(context.params["id"] ?? "", idTypes[collection] ?? "auto")

  route(
    "POST",
    "collections/:collection/documents",
    "documents.write",
    (context) =>
      writeDocument(
        context,
        (collection, doc) => ({ op: "insert", collection, doc }),
        "documents.insert",
      ),
    "documents.insert",
  )
  route(
    "PATCH",
    "collections/:collection/documents/:id",
    "documents.write",
    (context) =>
      writeDocument(
        context,
        (collection, update) => ({
          op: "update",
          collection,
          id: idOf(context, collection),
          update,
        }),
        "documents.update",
      ),
    "documents.update",
  )
  route(
    "PUT",
    "collections/:collection/documents/:id",
    "documents.write",
    (context) =>
      writeDocument(
        context,
        (collection, doc) => ({ op: "replace", collection, id: idOf(context, collection), doc }),
        "documents.replace",
      ),
    "documents.replace",
  )
  route(
    "DELETE",
    "collections/:collection/documents/:id",
    "documents.write",
    (context) =>
      writeDocument(
        context,
        (collection) => ({ op: "delete", collection, id: idOf(context, collection) }),
        "documents.delete",
      ),
    "documents.delete",
  )

  // Policies

  route("GET", "policies", "policies.read", async () => {
    const { stored } = await policies.all()
    return json({
      data: [...stored.values()].map((doc) => ({
        collection: doc._id,
        version: doc.version,
        hash: doc.hash,
        exposed: doc.exposed,
        realtime: doc.realtime,
        policies: doc.policies.length,
        updatedAt: doc.updatedAt,
        updatedBy: doc.updatedBy,
      })),
      writable: policies.isWritable,
      bundle: options.engine().version,
    })
  })

  route("GET", "policies/:collection", "policies.read", async (context) => {
    const collection = collectionName(context.params["collection"] ?? "")
    const stored = await policies.get(collection)
    const active = options.engine().collection(collection)
    const findings = active === undefined ? [] : (await policies.check(active)).findings
    return json({
      collection,
      stored: stored ?? null,
      version: stored?.version ?? 0,
      active: options.engine().set.hashes.get(collection) ?? null,
      findings,
      writable: policies.isWritable,
    })
  })

  route("POST", "policies/:collection/validate", "policies.simulate", async (context) => {
    const collection = collectionName(context.params["collection"] ?? "")
    const body = object({ definition: unknownValue() }).parse(await context.body())
    const definition = definitionFromInput(collection, body.definition)
    const { findings, set } = await policies.check(definition)
    return json({
      valid: findings.every((finding) => finding.severity !== "error"),
      hash: set.hashes.get(collection),
      findings,
    })
  })

  route("POST", "policies/:collection/simulate", "policies.simulate", async (context) => {
    const collection = collectionName(context.params["collection"] ?? "")
    const body = object({
      definition: optional(unknownValue()),
      as: unknownValue(),
      op: oneOf(...OPERATIONS),
      filter: optional(unknownValue()),
      limit: optional(integer({ min: 1, max: 100 })),
    }).parse(await context.body())
    const engine =
      body.definition === undefined
        ? options.engine()
        : new PolicyEngine(
            (await policies.check(definitionFromInput(collection, body.definition))).set,
          )
    const as = await impersonate(body.as, collection, engine)
    const op: Operation = body.op
    const filterInput = body.filter === undefined ? {} : body.filter
    if (!isDocument(filterInput)) throw new ValidationError("filter must be a document")
    const filter = filterInput
    const explain = engine.explain(collection, op, as.context, "using")
    const check =
      op === "insert" || op === "update"
        ? engine.explain(collection, op, as.context, "check")
        : undefined
    const granted = engine.hasGrant(collection, op, as.context)
    let result: Record<string, unknown> = {}
    if (op === "read" && granted) {
      const reads = new ReadPath({
        client: options.client,
        database: config.mongodb.database,
        policies: engine,
      })
      const page = await reads.find(
        { context: as.context, subject: as.subject },
        { collection, filter, limit: body.limit ?? 20, count: "exact" },
        { signal: context.request.signal },
      )
      result = { count: page.total, sample: page.docs }
    } else if ((op === "update" || op === "delete") && granted) {
      const target = toFilter(engine.target(collection, op, as.context))
      const count = await app
        .collection(collection)
        .countDocuments({ $and: [filter, target] }, { maxTimeMS: 5000 })
      result = { count }
    }
    return json({
      allowed: granted,
      op,
      roles: [...as.context.roles].sort(),
      effectiveFilter: { $and: [filter, toFilter(explain.result)] },
      explain,
      ...(check === undefined ? {} : { check }),
      fields: {
        read: engine.readable(collection, as.context),
        ...(op === "insert" || op === "update"
          ? { write: engine.writable(collection, op, as.context) }
          : {}),
      },
      ...result,
    })
  })

  route("POST", "policies/:collection/explain", "policies.simulate", async (context) => {
    const collection = collectionName(context.params["collection"] ?? "")
    const body = object({
      as: unknownValue(),
      op: optional(oneOf(...OPERATIONS)),
      filter: optional(document()),
    }).parse(await context.body())
    const engine = options.engine()
    const as = await impersonate(body.as, collection, engine)
    const report = explainAccess(engine, {
      collection,
      op: body.op ?? "read",
      context: as.context,
      ...(body.filter === undefined ? {} : { filter: body.filter }),
    })
    return json({
      ...report,
      effectiveFilter: toFilter(report.effective),
      text: formatAccessReport(report),
    })
  })

  route(
    "POST",
    "policies/:collection/publish",
    "policies.publish",
    async (context) => {
      const collection = collectionName(context.params["collection"] ?? "")
      const body = object({
        definition: unknownValue(),
        expectedVersion: integer({ min: 0 }),
        comment: optional(string({ max: 2000 })),
        commitSha: optional(string({ min: 7, max: 64, pattern: /^[0-9a-f]+$/ })),
      }).parse(await context.body())
      if (production && (body.comment === undefined || body.comment.trim() === ""))
        throw new ValidationError("Publishing in production needs a comment")
      const result = await policies.publish({
        definition: definitionFromInput(collection, body.definition),
        expectedVersion: body.expectedVersion,
        actor: context.actor,
        origin: context.origin,
        ...(body.comment === undefined ? {} : { comment: body.comment }),
        ...(body.commitSha === undefined ? {} : { commitSha: body.commitSha }),
      })
      return json(result)
    },
    "policy.publish",
  )

  route("GET", "policies/:collection/history", "policies.read", async (context) => {
    const collection = collectionName(context.params["collection"] ?? "")
    const limit = Number(context.url.searchParams.get("limit") ?? "50")
    const before = context.url.searchParams.get("before")
    const entries = await policies.versions(collection, {
      limit: Number.isFinite(limit) ? limit : 50,
      ...(before === null ? {} : { before: Number(before) }),
    })
    return json({ data: entries })
  })

  route(
    "POST",
    "policies/:collection/rollback",
    "policies.publish",
    async (context) => {
      const collection = collectionName(context.params["collection"] ?? "")
      const body = object({
        version: integer({ min: 1 }),
        expectedVersion: integer({ min: 0 }),
        comment: optional(string({ max: 2000 })),
      }).parse(await context.body())
      if (production && (body.comment === undefined || body.comment.trim() === ""))
        throw new ValidationError("Publishing in production needs a comment")
      return json(
        await policies.rollback({
          collection,
          version: body.version,
          expectedVersion: body.expectedVersion,
          actor: context.actor,
          origin: context.origin,
          ...(body.comment === undefined ? {} : { comment: body.comment }),
        }),
      )
    },
    "policy.rollback",
  )

  // Context lookups

  route("GET", "contexts", "policies.read", async () => {
    const stored = await policies.getContexts()
    return json({
      stored: stored ?? null,
      version: stored?.version ?? 0,
      writable: policies.isWritable,
    })
  })

  route("POST", "contexts/validate", "policies.simulate", async (context) => {
    const body = contextsInput.parse(await context.body())
    const { findings } = await policies.checkContexts(body.lookups as ContextDefinitions)
    return json({
      valid: findings.every((finding) => finding.severity !== "error"),
      hash: hashContexts(body.lookups as ContextDefinitions),
      findings,
    })
  })

  route(
    "POST",
    "contexts/publish",
    "policies.publish",
    async (context) => {
      const body = object({
        lookups: document(),
        expectedVersion: integer({ min: 0 }),
        comment: optional(string({ max: 2000 })),
        commitSha: optional(string({ min: 7, max: 64, pattern: /^[0-9a-f]+$/ })),
      }).parse(await context.body())
      if (production && (body.comment === undefined || body.comment.trim() === ""))
        throw new ValidationError("Publishing in production needs a comment")
      return json(
        await policies.publishContexts({
          lookups: body.lookups as ContextDefinitions,
          expectedVersion: body.expectedVersion,
          actor: context.actor,
          origin: context.origin,
          ...(body.comment === undefined ? {} : { comment: body.comment }),
          ...(body.commitSha === undefined ? {} : { commitSha: body.commitSha }),
        }),
      )
    },
    "context.publish",
  )

  route("GET", "contexts/history", "policies.read", async (context) => {
    const limit = Number(context.url.searchParams.get("limit") ?? "50")
    return json({
      data: await policies.versions("_context", { limit: Number.isFinite(limit) ? limit : 50 }),
    })
  })

  route(
    "POST",
    "contexts/rollback",
    "policies.publish",
    async (context) => {
      const body = object({
        version: integer({ min: 1 }),
        expectedVersion: integer({ min: 0 }),
        comment: optional(string({ max: 2000 })),
      }).parse(await context.body())
      if (production && (body.comment === undefined || body.comment.trim() === ""))
        throw new ValidationError("Publishing in production needs a comment")
      return json(
        await policies.rollbackContexts({
          version: body.version,
          expectedVersion: body.expectedVersion,
          actor: context.actor,
          origin: context.origin,
          ...(body.comment === undefined ? {} : { comment: body.comment }),
        }),
      )
    },
    "context.rollback",
  )

  // API keys

  route("GET", "api-keys", "keys.read", async () => json({ data: await keys.list() }))

  route(
    "POST",
    "api-keys",
    "keys.publishable",
    async (context) => {
      const body = object({
        kind: oneOf("publishable", "secret"),
        name: string({ min: 1, max: 200 }),
      }).parse(await context.body())
      if (body.kind === "secret") require(context, "keys.secret")
      const created = await keys.create({
        kind: body.kind,
        name: body.name,
        createdBy: context.actor.id,
      })
      await context.audit({
        action: "key.create",
        target: {
          keyId: created.info.id,
          kind: body.kind,
          name: body.name,
          prefix: created.info.prefix,
        },
      })
      return json(created, 201)
    },
    "key.create",
  )

  route(
    "DELETE",
    "api-keys/:id",
    "keys.publishable",
    async (context) => {
      const id = context.params["id"] ?? ""
      const existing = await keys.get(id)
      if (existing === undefined) throw new NotFoundError("No such API key")
      if (existing.kind === "secret") require(context, "keys.secret")
      const revoked = await keys.revoke(id, context.actor.id)
      await context.audit({
        action: "key.revoke",
        target: { keyId: id, kind: existing.kind, name: existing.name, prefix: existing.prefix },
      })
      return json(revoked)
    },
    "key.revoke",
  )

  // App users (built in auth)

  const authOf = (): AdminAuth => {
    if (options.auth === undefined) throw new NotFoundError("Built in auth is not configured")
    return options.auth
  }
  const userOf = async (context: Context) => {
    const id = context.params["id"] ?? ""
    const user = await authOf().users.get(id)
    if (user === undefined) throw new NotFoundError("No such user")
    return user
  }
  const metadata = optional(document())
  const roleList = optional(array(string({ min: 1, max: 200 }), { max: 64 }))

  route("GET", "users", "users.read", async (context) => {
    const limit = context.url.searchParams.get("limit")
    const offset = context.url.searchParams.get("offset")
    const email = context.url.searchParams.get("email")
    const page = await authOf().users.list({
      ...(limit === null ? {} : { limit: Number(limit) || 50 }),
      ...(offset === null ? {} : { offset: Number(offset) || 0 }),
      ...(email === null ? {} : { email }),
    })
    return json({ data: page.users, total: page.total })
  })

  route(
    "POST",
    "users/invite",
    "users.manage",
    async (context) => {
      const body = object({
        email: string({ min: 3, max: 320 }),
        redirectTo: optional(string({ min: 1, max: 2000 })),
        roles: roleList,
        appMetadata: metadata,
      }).parse(await context.body())
      const user = await authOf().users.invite({
        email: body.email,
        ...(body.redirectTo === undefined ? {} : { redirectTo: body.redirectTo }),
        ...(body.roles === undefined ? {} : { roles: body.roles }),
        ...(body.appMetadata === undefined ? {} : { appMetadata: body.appMetadata }),
      })
      await context.audit({ action: "user.invite", target: { userId: user.id } })
      return json(user, 201)
    },
    "user.invite",
  )

  route(
    "POST",
    "users",
    "users.manage",
    async (context) => {
      const body = object({
        email: string({ min: 3, max: 320 }),
        password: optional(string({ min: 1, max: 1024 })),
        name: optional(string({ max: 200 })),
        emailVerified: optional(boolean()),
        roles: roleList,
        appMetadata: metadata,
        userMetadata: metadata,
      }).parse(await context.body())
      const user = await authOf().users.create({
        email: body.email,
        ...(body.password === undefined ? {} : { password: body.password }),
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.emailVerified === undefined ? {} : { emailVerified: body.emailVerified }),
        ...(body.roles === undefined ? {} : { roles: body.roles }),
        ...(body.appMetadata === undefined ? {} : { appMetadata: body.appMetadata }),
        ...(body.userMetadata === undefined ? {} : { userMetadata: body.userMetadata }),
      })
      await context.audit({ action: "user.create", target: { userId: user.id } })
      return json(user, 201)
    },
    "user.create",
  )

  route("GET", "users/:id", "users.read", async (context) => json(await userOf(context)))

  route(
    "PATCH",
    "users/:id",
    "users.manage",
    async (context) => {
      const before = await userOf(context)
      const body = object({
        email: optional(string({ min: 3, max: 320 })),
        password: optional(string({ min: 1, max: 1024 })),
        name: optional(string({ max: 200 })),
        emailVerified: optional(boolean()),
        roles: roleList,
        appMetadata: metadata,
        userMetadata: metadata,
      }).parse(await context.body())
      const after = await authOf().users.update(before.id, {
        ...(body.email === undefined ? {} : { email: body.email }),
        ...(body.password === undefined ? {} : { password: body.password }),
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.emailVerified === undefined ? {} : { emailVerified: body.emailVerified }),
        ...(body.roles === undefined ? {} : { roles: body.roles }),
        ...(body.appMetadata === undefined ? {} : { appMetadata: body.appMetadata }),
        ...(body.userMetadata === undefined ? {} : { userMetadata: body.userMetadata }),
      })
      await context.audit({
        action: "user.update",
        target: { userId: before.id },
        diff: {
          before: { roles: before.roles, appMetadata: before.appMetadata, email: before.email },
          after: { roles: after.roles, appMetadata: after.appMetadata, email: after.email },
        },
        details: {
          fields: Object.keys(body).map((key) => (key === "password" ? "password" : key)),
        },
      })
      return json(after)
    },
    "user.update",
  )

  route(
    "POST",
    "users/:id/ban",
    "users.manage",
    async (context) => {
      const user = await userOf(context)
      const body = object({
        reason: optional(string({ max: 500 })),
        until: optional(string({ min: 1, max: 40 })),
      }).parse(await context.body())
      const until = body.until === undefined ? undefined : new Date(body.until)
      if (until !== undefined && Number.isNaN(until.getTime()))
        throw new ValidationError("until must be an ISO date")
      realtime?.closeConnections((principal) => principal.subject === user.id, 4003, "user banned")
      const banned = await authOf().users.ban(user.id, {
        ...(body.reason === undefined ? {} : { reason: body.reason }),
        ...(until === undefined ? {} : { until }),
      })
      await context.audit({
        action: "user.ban",
        target: { userId: user.id },
        details: { reason: body.reason },
      })
      return json(banned)
    },
    "user.ban",
  )

  route(
    "POST",
    "users/:id/unban",
    "users.manage",
    async (context) => {
      const user = await userOf(context)
      const unbanned = await authOf().users.unban(user.id)
      await context.audit({ action: "user.unban", target: { userId: user.id } })
      return json(unbanned)
    },
    "user.unban",
  )

  route(
    "DELETE",
    "users/:id",
    "users.manage",
    async (context) => {
      const user = await userOf(context)
      realtime?.closeConnections((principal) => principal.subject === user.id, 4003, "user deleted")
      await authOf().users.delete(user.id)
      await context.audit({ action: "user.delete", target: { userId: user.id, email: user.email } })
      return new Response(null, { status: 204 })
    },
    "user.delete",
  )

  route("GET", "users/:id/sessions", "users.read", async (context) => {
    const user = await userOf(context)
    return json({ data: await authOf().users.listSessions(user.id) })
  })

  route(
    "DELETE",
    "users/:id/sessions",
    "users.manage",
    async (context) => {
      const user = await userOf(context)
      const count = await authOf().users.revokeSessions(user.id)
      await context.audit({
        action: "user.sessions.revoke",
        target: { userId: user.id },
        details: { count },
      })
      return json({ revoked: count })
    },
    "user.sessions.revoke",
  )

  route(
    "DELETE",
    "users/:id/sessions/:sid",
    "users.manage",
    async (context) => {
      const user = await userOf(context)
      const sid = context.params["sid"] ?? ""
      const count = await authOf().users.revokeSessions(user.id, sid)
      await context.audit({
        action: "user.sessions.revoke",
        target: { userId: user.id, sessionId: sid },
      })
      return json({ revoked: count })
    },
    "user.sessions.revoke",
  )

  route("GET", "auth/keys", "settings.read", async () => json({ data: authOf().keys.list() }))

  route(
    "POST",
    "auth/keys/rotate",
    "settings.write",
    async (context) => {
      const keys = await authOf().keys.rotate()
      await context.audit({ action: "auth.keys.rotate" })
      return json({ data: keys })
    },
    "auth.keys.rotate",
  )

  route(
    "DELETE",
    "auth/keys/:kid",
    "settings.write",
    async (context) => {
      const kid = context.params["kid"] ?? ""
      if (!(await authOf().keys.revoke(kid))) throw new NotFoundError("No such signing key")
      await context.audit({ action: "auth.keys.revoke", target: { kid } })
      return json({ data: authOf().keys.list() })
    },
    "auth.keys.revoke",
  )

  // Realtime

  const engineOf = (): Realtime => {
    if (realtime === undefined) throw new NotFoundError("Realtime is turned off")
    return realtime
  }
  route("GET", "realtime/stats", "realtime.stats", async () => json(engineOf().stats()))
  route("GET", "realtime/connections", "realtime.inspect", async () =>
    json({ data: engineOf().connections() }),
  )
  route("GET", "realtime/observers", "realtime.inspect", async () =>
    json({ data: engineOf().observers() }),
  )
  route("GET", "realtime/events", "realtime.inspect", async () =>
    json({ data: engineOf().recentEvents(100) }),
  )
  route("GET", "realtime/trace/:eventId", "realtime.inspect", async (context) => {
    const trace = engineOf().trace(context.params["eventId"] ?? "")
    if (trace === undefined) throw new NotFoundError("The event is no longer in the trace buffer")
    return json(trace)
  })
  route("GET", "realtime/tail", "realtime.inspect", async (context) => {
    const engine = engineOf()
    const encoder = new TextEncoder()
    let stop: (() => void) | undefined
    let heartbeat: ReturnType<typeof setInterval> | undefined
    const close = (): void => {
      stop?.()
      if (heartbeat !== undefined) clearInterval(heartbeat)
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(": canopy realtime tail\n\n"))
        stop = engine.tail((event) => {
          try {
            controller.enqueue(
              encoder.encode(
                `id: ${event.id}\nevent: change\ndata: ${JSON.stringify(encode(event))}\n\n`,
              ),
            )
          } catch {
            close()
          }
        })
        heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": ping\n\n"))
          } catch {
            close()
          }
        }, 15_000)
        context.request.signal.addEventListener("abort", () => {
          close()
          try {
            controller.close()
          } catch {}
        })
      },
      cancel: close,
    })
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    })
  })

  // Ops

  route("GET", "doctor", "ops.doctor", async () => {
    const checks: { name: string; status: "ok" | "warn" | "fail"; message: string }[] = []
    const add = (name: string, status: "ok" | "warn" | "fail", message: string): void => {
      checks.push({ name, status, message })
    }
    try {
      const hello = await app.command({ hello: 1 })
      const build = await app.command({ buildInfo: 1 })
      add("mongodb", "ok", `MongoDB ${String(build["version"])}`)
      if (typeof hello["setName"] === "string")
        add("replica-set", "ok", `Replica set ${hello["setName"]}`)
      else add("replica-set", "fail", "Change streams and transactions need a replica set")
    } catch (error: unknown) {
      add("mongodb", "fail", error instanceof Error ? error.message : "MongoDB is unreachable")
    }
    const migrations = await migrationStatus(options.client.db(config.mongodb.metaDatabase))
    const pending = migrations.filter((m) => m.appliedAt === undefined)
    add(
      "meta-migrations",
      pending.length === 0 ? "ok" : "fail",
      pending.length === 0
        ? "The meta database is up to date"
        : `${pending.length} migration(s) pending`,
    )
    add(
      "master-key",
      config.masterKey === undefined ? (production ? "fail" : "warn") : "ok",
      config.masterKey === undefined
        ? "No master key: stored secrets are not encrypted"
        : "Stored secrets are encrypted",
    )
    add(
      "admin-listener",
      config.server.adminListen === undefined ? (production ? "warn" : "ok") : "ok",
      config.server.adminListen === undefined
        ? "/admin is served on the public listener; set CANOPY_ADMIN_LISTEN to keep it private"
        : `/admin is served only on ${config.server.adminListen}`,
    )
    add(
      "policies",
      "ok",
      `Bundle ${options.engine().version}, ${options.engine().set.collections.size} collection(s)`,
    )
    if (realtime !== undefined) {
      const stats = realtime.stats()
      add("realtime", "ok", `${stats.connections} connection(s), stream at ${stats.streamPosition}`)
    }
    const status = checks.some((c) => c.status === "fail")
      ? "fail"
      : checks.some((c) => c.status === "warn")
        ? "warn"
        : "ok"
    return json({ status, environment, checks })
  })

  route("GET", "audit", "ops.audit", async (context) => {
    const search = context.url.searchParams
    const action = search.get("action")
    const actor = search.get("actor")
    const before = search.get("before")
    const limit = Number(search.get("limit") ?? "100")
    const entries = await audit.list({
      ...(action === null ? {} : { action }),
      ...(actor === null ? {} : { actorId: actor }),
      ...(before === null ? {} : { before }),
      limit: Number.isFinite(limit) ? limit : 100,
    })
    return json({ data: entries, next: entries.length === 0 ? null : String(entries.at(-1)?._id) })
  })

  route("GET", "settings", "settings.read", async () => json(await settings.get()))

  route(
    "PATCH",
    "settings",
    "settings.write",
    async (context) => {
      const patch = settingsPatch.parse(await context.body())
      return json(await settings.update(patch, context.actor, context.origin))
    },
    "settings.update",
  )

  const match = (
    method: string,
    segments: readonly string[],
  ): { route?: Route; params: Record<string, string>; allowed: string[] } => {
    const allowed: string[] = []
    for (const candidate of routes) {
      if (candidate.path.length !== segments.length) continue
      const params: Record<string, string> = {}
      let ok = true
      for (let i = 0; i < segments.length; i++) {
        const part = candidate.path[i] ?? ""
        const segment = segments[i] ?? ""
        if (part.startsWith(":")) params[part.slice(1)] = segment
        else if (part !== segment) {
          ok = false
          break
        }
      }
      if (!ok) continue
      allowed.push(candidate.method)
      if (candidate.method === method) return { route: candidate, params, allowed }
    }
    return { params: {}, allowed }
  }

  const authenticate = async (request: Request): Promise<AdminSession | undefined> => {
    const header = request.headers.get("authorization")
    if (header !== null) {
      const bearer = /^Bearer[ ]+(\S+)$/i.exec(header)?.[1]
      if (bearer === undefined) return undefined
      const session = await accounts.session(bearer)
      return session?.transport === "bearer" ? session : undefined
    }
    const token = cookie(request.headers.get("cookie"), SESSION_COOKIE)
    if (token === undefined) return undefined
    const session = await accounts.session(token)
    return session?.transport === "cookie" ? session : undefined
  }

  const serve = async (request: Request, origin: RequestOrigin): Promise<Response> => {
    const url = new URL(request.url)
    const segments = url.pathname
      .slice("/admin/v1".length)
      .split("/")
      .filter((part) => part !== "")
      .map((part) => {
        try {
          return decodeURIComponent(part)
        } catch {
          throw new ValidationError("The path is not valid")
        }
      })
    const found = match(request.method, segments)
    if (found.route === undefined) {
      if (found.allowed.length === 0) throw new NotFoundError("Not found")
      const response = problem(
        new CanopyError(ErrorCode.InvalidQuery, `${request.method} is not allowed here`),
        url.pathname,
        origin.requestId ?? "",
      )
      return new Response(response.body, {
        status: 405,
        headers: { "content-type": "application/problem+json", allow: found.allowed.join(", ") },
      })
    }
    const current = found.route
    const mutating = isMutating(request.method)
    const ownOrigin = new Set([...allowedOrigins, `http://${url.host}`, `https://${url.host}`])

    let session: AdminSession | undefined
    if (current.permission !== "public") {
      session = await authenticate(request)
      if (session === undefined) {
        throw new CanopyError(ErrorCode.Unauthorized, "Log in to use the admin API")
      }
    }
    if (mutating) {
      checkOrigin(request, ownOrigin, session?.transport === "cookie")
      if (session?.transport === "cookie") {
        const header = request.headers.get(CSRF_HEADER) ?? ""
        const fromCookie = cookie(request.headers.get("cookie"), CSRF_COOKIE) ?? ""
        if (
          header === "" ||
          !sameSecret(header, fromCookie) ||
          !sameSecret(csrfHash(header), session.csrfHash)
        )
          throw csrfFailure("The CSRF token is missing or does not match")
      }
    }

    let audited = false
    let bodyCache: Promise<unknown> | undefined
    const actor: Actor =
      session === undefined ? { type: "system", id: "anonymous" } : actorOf(session.user)
    const context: Context = {
      request,
      url,
      params: found.params,
      origin,
      session: session ?? (NO_SESSION as unknown as AdminSession),
      actor,
      body: () => {
        bodyCache ??= readBody(request, MAX_BODY).then((read) => read?.value)
        return bodyCache
      },
      audit: async (input) => {
        audited = true
        await audit.record({ ...input, actor, origin })
      },
    }

    if (session !== undefined) {
      if (
        session.user.mustChangePassword &&
        !(
          current.permission === "session" &&
          ["me", "me/password", "logout"].includes(current.path.join("/"))
        )
      )
        throw new CanopyError(ErrorCode.Forbidden, "Change your password first", {
          details: { reason: "password_change_required" },
        })
      if (
        current.permission !== "public" &&
        !can(session.user.role, current.permission, environment)
      ) {
        if (mutating)
          await audit.record({
            action: current.action ?? `${request.method} ${url.pathname}`,
            actor,
            outcome: "denied",
            target: found.params,
            origin,
          })
        throw new ForbiddenError(`The ${session.user.role} role may not do this`)
      }
    }

    try {
      const response = await current.handler(context)
      if (
        mutating &&
        current.action !== undefined &&
        !audited &&
        response.status < 400 &&
        !selfAudited.has(current.action)
      )
        await audit.record({ action: current.action, actor, target: found.params, origin })
      return response
    } catch (error: unknown) {
      if (
        mutating &&
        session !== undefined &&
        error instanceof CanopyError &&
        error.code === ErrorCode.Forbidden &&
        !audited
      )
        await audit.record({
          action: current.action ?? `${request.method} ${url.pathname}`,
          actor,
          outcome: "denied",
          target: found.params,
          origin,
          details: { message: error.message },
        })
      throw error
    }
  }

  return {
    async fetch(request, info = {}) {
      const requestId = request.headers.get("x-request-id")?.slice(0, 128) ?? randomUUID()
      const origin: RequestOrigin = {
        ...(info.ip === undefined ? {} : { ip: info.ip }),
        ...(request.headers.get("user-agent") === null
          ? {}
          : { userAgent: (request.headers.get("user-agent") ?? "").slice(0, 512) }),
        requestId,
      }
      let response: Response
      try {
        response = await serve(request, origin)
      } catch (error: unknown) {
        const canopy = error instanceof CanopyError ? error : undefined
        if (canopy === undefined || canopy.status >= 500)
          options.logger.error(
            { err: error, path: new URL(request.url).pathname },
            "admin request failed",
          )
        response = problem(error, new URL(request.url).pathname, requestId)
      }
      response.headers.set("x-request-id", requestId)
      return secure(response)
    },
  }
}

/** Actions whose stores write their own audit entries (inside their transactions). */
const selfAudited: ReadonlySet<string> = new Set([
  "setup.claim",
  "session.login",
  "session.logout",
  "admin.password.change",
  "admin.totp.enroll",
  "admin.totp.confirm",
  "admin.create",
  "admin.update",
  "admin.remove",
  "admin.totp.reset",
  "collection.update",
  "policy.publish",
  "policy.rollback",
  "context.publish",
  "context.rollback",
  "settings.update",
])
