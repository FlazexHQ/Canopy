import { type PolicyEngine, type RequestContext, Role } from "@canopy/policy"
import {
  CanopyError,
  ErrorCode,
  ForbiddenError,
  isDocument,
  NotFoundError,
  parse,
  ValidationError,
} from "@canopy/protocol"
import { type Caller, type IdType, ReadPath, SchemaCache } from "@canopy/rest"
import type { Actor, AuditInput, RequestOrigin } from "../../audit.ts"
import { array, document, type Infer, object, optional, string } from "../../schema.ts"
import type { ViewIdentity } from "../../view-tokens.ts"
import type { AdminSession } from "../accounts.ts"
import type { AdminApiOptions } from "../api.ts"
import { can, type Permission } from "../rbac.ts"
import { AdminTokens } from "../tokens.ts"

export interface Context {
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

export interface Route {
  readonly method: string
  readonly path: readonly string[]
  /** `public` routes run without a session. */
  readonly permission: Permission | "public"
  /** The audit action of a state changing route, recorded automatically when the handler does not. */
  readonly action?: string
  handler(context: Context): Promise<Response>
}

/** Adds a route. `action` is the audit action of a state changing route. */
export type RouteFn = (
  method: string,
  path: string,
  permission: Route["permission"],
  handler: Route["handler"],
  action?: string,
) => void

const MASK = "[masked]"

/** The `as` input of the simulator, explain and view tokens. */
export const asInput = object({
  role: optional(string({ min: 1, max: 200 })),
  roles: optional(array(string({ min: 1, max: 200 }), { max: 32 })),
  user: optional(string({ min: 1, max: 500 })),
  claims: optional(document()),
})

/** The roles and claims an `as` input impersonates. Refuses `service` and `anon` mixed with other roles. */
export function viewIdentity(as: Infer<typeof asInput>): ViewIdentity {
  const roles = new Set<string>([...(as.role === undefined ? [] : [as.role]), ...(as.roles ?? [])])
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
  return { roles: [...roles], claims }
}

/** Replaces the fields of `original` that `visible` lacks with a mask, at any depth. */
export function mask(
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

/** What every route module works with: the API options and the values built from them once. */
export type AdminDeps = ReturnType<typeof adminDeps>

/** Builds the values the route modules share. */
export function adminDeps(options: AdminApiOptions) {
  const { config, accounts, audit, policies, keys, settings, realtime } = options
  const environment = config.environment
  const production = environment === "production"
  const tokens =
    options.tokens ??
    new AdminTokens({
      meta: options.client.db(config.mongodb.metaDatabase),
      accounts,
      audit,
    })
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
    collection: string | undefined,
    engine: PolicyEngine,
  ): Promise<{
    readonly context: RequestContext
    readonly subject: string
    readonly as: unknown
  }> => {
    const as = asInput.parse(input, "as")
    const identity = viewIdentity(as)
    const roles = new Set(identity.roles)
    const claims = identity.claims === null ? null : { ...identity.claims }
    const base: RequestContext = { roles, claims, now: new Date() }
    const names = engine.contextNames(collection === undefined ? undefined : [collection], roles)
    const context =
      names.length === 0
        ? base
        : { ...base, ctx: (await options.contexts.resolve(engine.set.contexts, names, base)).ctx }
    const subject = typeof claims?.["sub"] === "string" ? claims["sub"] : [...roles].join(",")
    return { context, subject, as }
  }

  const anyPublishableKey = async (): Promise<string> => {
    const configured = config.keys.publishable[0]
    if (configured !== undefined) return configured
    const stored = (await keys.list()).find(
      (key) => key.kind === "publishable" && key.revokedAt === undefined && key.key !== undefined,
    )
    if (stored?.key === undefined)
      throw new NotFoundError("No publishable key: create one to follow data live")
    return stored.key
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

  return {
    options,
    config,
    accounts,
    audit,
    policies,
    keys,
    settings,
    realtime,
    environment,
    production,
    tokens,
    app,
    schemas,
    idTypes,
    serviceReads,
    service,
    parseJsonParam,
    impersonate,
    anyPublishableKey,
    require,
    confirmWrite,
    allowedOrigins,
  }
}
