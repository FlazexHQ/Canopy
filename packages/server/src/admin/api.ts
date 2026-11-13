import { randomUUID } from "node:crypto"
import type { UserAdmin } from "@canopy/auth"
import type { ResolvedConfig } from "@canopy/config"
import type { GraphqlHandler } from "@canopy/graphql"
import type { ContextResolver, PolicyEngine } from "@canopy/policy"
import {
  CanopyError,
  ErrorCode,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@canopy/protocol"
import type { Logger, Realtime } from "@canopy/realtime"
import { readBody, type WritePath } from "@canopy/rest"
import type { MongoClient } from "mongodb"
import type { ApiKeys } from "../api-keys.ts"
import type { Actor, AuditLog, RequestOrigin } from "../audit.ts"
import type { PolicyStore } from "../policy-store.ts"
import type { RequestLog } from "../request-log.ts"
import type { ViewTokens } from "../view-tokens.ts"
import { type AdminAccounts, type AdminSession, actorOf, csrfHash } from "./accounts.ts"
import type { EmailTemplateStore } from "./email-templates.ts"
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  checkOrigin,
  cookie,
  csrfFailure,
  isMutating,
  problem,
  SESSION_COOKIE,
  sameSecret,
  secure,
} from "./http.ts"
import type { LagSampler } from "./lag.ts"
import { can } from "./rbac.ts"
import { adminDeps, type Context, type Route, type RouteFn } from "./routes/core.ts"
import { registerData } from "./routes/data.ts"
import { registerOps } from "./routes/ops.ts"
import { registerPolicies } from "./routes/policies.ts"
import { registerRealtime } from "./routes/realtime.ts"
import { registerSession } from "./routes/session.ts"
import { registerUsers } from "./routes/users.ts"
import type { SettingsStore } from "./settings.ts"
import { AdminTokens } from "./tokens.ts"

const MAX_BODY = 1024 * 1024
const NO_SESSION = Symbol("no session")

/** Everything the admin API works on. */
export interface AdminApiOptions {
  readonly config: ResolvedConfig
  readonly client: MongoClient
  readonly accounts: AdminAccounts
  readonly audit: AuditLog
  readonly policies: PolicyStore
  readonly keys: ApiKeys
  readonly settings: SettingsStore
  /** Admin API tokens; by default stored in the meta database of `config`. */
  readonly tokens?: AdminTokens
  /** Serves `GET /admin/v1/logs`; without it the route answers `404`. */
  readonly requestLog?: RequestLog
  /** The policies in force. */
  readonly engine: () => PolicyEngine
  readonly contexts: ContextResolver
  readonly writes: WritePath
  /** The GraphQL handler, for the explorer's `POST /admin/v1/graphql`. */
  readonly graphql?: GraphqlHandler
  readonly realtime: Realtime | undefined
  /** Signs the view tokens of `POST /admin/v1/realtime/token`; without it the route answers `404`. */
  readonly viewTokens?: ViewTokens
  /** Change stream lag samples for `GET /admin/v1/realtime/stats`. */
  readonly lag?: LagSampler
  readonly logger: Logger
  /** Origins allowed to send state changing requests, besides the request's own origin. */
  readonly origins?: readonly string[]
  /** Built in auth, when the config chooses it: serves `/admin/v1/users` and `/admin/v1/auth/keys`. */
  readonly auth?: AdminAuth
  /** Email templates of built in auth edited in Studio: serves `/admin/v1/auth/templates`. */
  readonly emailTemplates?: {
    readonly store: EmailTemplateStore
    /** The app name built in auth puts in emails, used by previews. */
    readonly appName: string
  }
}

/** What the admin API needs from built in auth. */
export interface AdminAuth {
  readonly users: UserAdmin
  readonly keys: {
    list(): readonly unknown[]
    rotate(): Promise<readonly unknown[]>
    revoke(kid: string): Promise<boolean>
  }
  /** Whether revocations written by other nodes reach this one right now. */
  readonly revocationsFollowing?: boolean
}

/** The admin API: a Web standard handler for `/admin/v1/*`. */
export interface AdminApi {
  /** Every route as `METHOD path` with `:name` parameters, such as `GET users/:id`. */
  readonly routes: readonly string[]
  /** `info.ip` is the peer address, used for login limits and the audit log. */
  fetch(request: Request, info?: { readonly ip?: string }): Promise<Response>
}

/**
 * Builds the admin API. Every route needs a session (cookie or bearer) except setup and login; cookie
 * sessions must send the CSRF token and an allowed `Origin` on every state changing request; each route
 * checks its permission against the role read fresh from the account; and every state changing request is
 * written to `canopy.audit_log`, including refused ones.
 */
export function createAdminApi(options: AdminApiOptions): AdminApi {
  const deps = adminDeps(options)
  const { accounts, audit, environment, tokens, allowedOrigins } = deps
  const routes: Route[] = []
  const route: RouteFn = (method, path, permission, handler, action) => {
    routes.push({
      method,
      path: path.split("/").filter((part) => part !== ""),
      permission,
      handler,
      ...(action === undefined ? {} : { action }),
    })
  }
  for (const register of [
    registerSession,
    registerData,
    registerPolicies,
    registerUsers,
    registerRealtime,
    registerOps,
  ])
    register(route, deps)

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

  const authenticate = async (
    request: Request,
    origin: RequestOrigin,
  ): Promise<AdminSession | undefined> => {
    const header = request.headers.get("authorization")
    if (header !== null) {
      const bearer = /^Bearer[ ]+(\S+)$/i.exec(header)?.[1]
      if (bearer === undefined) return undefined
      if (AdminTokens.isToken(bearer)) return tokens.authenticate(bearer, origin)
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
      session = await authenticate(request, origin)
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
      session === undefined
        ? { type: "system", id: "anonymous" }
        : actorOf(session.user, session.transport === "token" ? session.id : undefined)
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

    if (session?.transport === "token") {
      await audit.record({
        action: "admin_token.use",
        actor,
        target: { tokenId: session.id },
        origin,
        details: { method: request.method, path: url.pathname },
      })
      if (SESSION_ONLY.has(`${current.method} ${current.path.join("/")}`)) {
        if (mutating)
          await audit.record({
            action: current.action ?? `${request.method} ${url.pathname}`,
            actor,
            outcome: "denied",
            target: found.params,
            origin,
            details: { reason: "session_required" },
          })
        throw new CanopyError(
          ErrorCode.Forbidden,
          "Admin API tokens cannot manage credentials or admins; sign in to do this",
          { details: { reason: "session_required" } },
        )
      }
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
    routes: routes.map((route) => `${route.method} ${route.path.join("/")}`),
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

/**
 * Routes admin API tokens may not use: credentials and admin accounts, so a leaked token can neither
 * outlive its revocation through new credentials nor change who may do what.
 */
const SESSION_ONLY: ReadonlySet<string> = new Set([
  "POST logout",
  "POST me/password",
  "POST me/totp",
  "POST me/totp/confirm",
  "POST admins",
  "PATCH admins/:id",
  "POST admins/:id/reset-totp",
  "DELETE admins/:id",
  "POST api-keys",
  "GET tokens",
  "POST tokens",
  "DELETE tokens/:id",
])

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
  "auth.templates.update",
  "auth.templates.reset",
  "admin_token.create",
  "admin_token.revoke",
])
