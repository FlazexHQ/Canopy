import type { ImportedPasswordHash } from "@canopy/auth"
import type { ResolvedConfig } from "@canopy/config"
import { NotFoundError, ValidationError } from "@canopy/protocol"
import { array, boolean, document, integer, object, oneOf, optional, string } from "../../schema.ts"
import type { AdminAuth } from "../api.ts"
import { EMAIL_KINDS } from "../email-templates.ts"
import { json } from "../http.ts"
import type { AdminDeps, Context, RouteFn } from "./core.ts"

const SOCIAL_PROVIDERS = ["google", "github", "apple", "microsoft", "discord"] as const

interface ProviderView {
  readonly id: string
  readonly enabled: boolean
  readonly configured: boolean
  readonly clientId?: string
  readonly issuer?: string
}

/** The sign in methods of a config, without secrets. */
function providersOf(auth: ResolvedConfig["auth"]): Record<string, unknown> {
  if (auth === undefined) return { mode: "external", providers: [] }
  if (auth.kind !== "builtin")
    return {
      mode: "external",
      providers: [],
      external: {
        issuer: auth.issuer,
        audience: auth.audience,
        ...(auth.jwksUrl === undefined ? {} : { jwksUrl: auth.jwksUrl }),
        ...(auth.algorithms === undefined ? {} : { algorithms: [...auth.algorithms] }),
      },
    }
  const builtin = (id: string, enabled: boolean): ProviderView => ({
    id,
    enabled,
    configured: true,
  })
  const providers: ProviderView[] = [
    builtin("email", auth.emailPassword !== false),
    builtin("magic-link", auth.magicLink),
    builtin("email-otp", auth.emailOtp),
    builtin("anonymous", auth.anonymous),
  ]
  for (const id of new Set([...SOCIAL_PROVIDERS, ...Object.keys(auth.providers)])) {
    const configured = auth.providers[id]
    providers.push(
      configured === undefined
        ? { id, enabled: false, configured: false }
        : { id, enabled: true, configured: true, clientId: configured.clientId },
    )
  }
  for (const oidc of auth.oidc)
    providers.push({
      id: oidc.id,
      enabled: true,
      configured: true,
      clientId: oidc.clientId,
      issuer: oidc.discoveryUrl,
    })
  return { mode: "builtin", providers }
}

/** Registers the API key, app user and email template routes. */
export function registerUsers(route: RouteFn, deps: AdminDeps): void {
  const { options, config, keys, realtime, require } = deps
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

  route(
    "POST",
    "users/import",
    "users.manage",
    async (context) => {
      const users = authOf().users
      if (users.import === undefined)
        throw new NotFoundError("This auth provider cannot import users")
      const body = object({
        users: array(
          object({
            email: string({ min: 1, max: 320 }),
            emailVerified: optional(boolean()),
            name: optional(string({ max: 200 })),
            createdAt: optional(string({ max: 64 })),
            disabled: optional(boolean()),
            roles: roleList,
            appMetadata: metadata,
            userMetadata: metadata,
            passwordHash: optional(document()),
            identities: optional(
              array(
                object({
                  provider: string({ min: 1, max: 64 }),
                  subject: string({ min: 1, max: 256 }),
                }),
                { max: 20 },
              ),
            ),
          }),
          { max: 1000 },
        ),
      }).parse(await context.body())
      const result = await users.import(
        body.users.map((user) => {
          const createdAt = user.createdAt === undefined ? undefined : new Date(user.createdAt)
          if (createdAt !== undefined && Number.isNaN(createdAt.getTime()))
            throw new ValidationError(`createdAt of ${user.email} is not a date`)
          return {
            email: user.email,
            ...(user.emailVerified === undefined ? {} : { emailVerified: user.emailVerified }),
            ...(user.name === undefined ? {} : { name: user.name }),
            ...(createdAt === undefined ? {} : { createdAt }),
            ...(user.disabled === undefined ? {} : { disabled: user.disabled }),
            ...(user.roles === undefined ? {} : { roles: user.roles }),
            ...(user.appMetadata === undefined ? {} : { appMetadata: user.appMetadata }),
            ...(user.userMetadata === undefined ? {} : { userMetadata: user.userMetadata }),
            ...(user.passwordHash === undefined
              ? {}
              : { passwordHash: user.passwordHash as unknown as ImportedPasswordHash }),
            ...(user.identities === undefined ? {} : { identities: user.identities }),
          }
        }),
      )
      await context.audit({
        action: "user.import",
        details: { created: result.created, skipped: result.skipped, failed: result.failed.length },
      })
      return json(result)
    },
    "user.import",
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

  /**
   * `GET /admin/v1/auth/providers`: how users sign in, read from the config (providers are configured there,
   * not in Studio). Client secrets are never returned.
   */
  route("GET", "auth/providers", "settings.read", async () => json(providersOf(config.auth)))

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

  // Email templates (built in auth)

  const templatesOf = () => {
    if (options.emailTemplates === undefined)
      throw new NotFoundError("Built in auth is not configured")
    return options.emailTemplates
  }
  const templateKind = (context: Context) => {
    const kind = context.params["kind"] ?? ""
    const found = EMAIL_KINDS.find((candidate) => candidate === kind)
    if (found === undefined) throw new NotFoundError(`No email template ${kind}`)
    return found
  }
  const templateBody = object({
    subject: string({ max: 1000 }),
    text: string({ max: 100_000 }),
    html: optional(string({ max: 200_000 })),
  })

  route("GET", "auth/templates", "settings.read", async () =>
    json(await templatesOf().store.list()),
  )

  route("GET", "auth/templates/history", "settings.read", async (context) => {
    const limit = Number(context.url.searchParams.get("limit") ?? "50") || 50
    return json({ data: await templatesOf().store.history(Math.min(Math.max(limit, 1), 200)) })
  })

  route("POST", "auth/templates/:kind/preview", "settings.read", async (context) => {
    const { store, appName } = templatesOf()
    const kind = templateKind(context)
    const body = object({ template: optional(templateBody) }).parse(await context.body())
    await store.load()
    return json({ kind, rendered: store.preview(kind, appName, body.template) })
  })

  route(
    "PUT",
    "auth/templates/:kind",
    "settings.write",
    async (context) => {
      const { store } = templatesOf()
      const kind = templateKind(context)
      const body = object({
        subject: string({ max: 1000 }),
        text: string({ max: 100_000 }),
        html: optional(string({ max: 200_000 })),
        expectedVersion: integer({ min: 0 }),
        comment: optional(string({ max: 2000 })),
      }).parse(await context.body())
      const result = await store.save({
        kind,
        template: {
          subject: body.subject,
          text: body.text,
          ...(body.html === undefined ? {} : { html: body.html }),
        },
        expectedVersion: body.expectedVersion,
        actor: context.actor,
        origin: context.origin,
        ...(body.comment === undefined ? {} : { comment: body.comment }),
      })
      return json(result)
    },
    "auth.templates.update",
  )

  route(
    "DELETE",
    "auth/templates/:kind",
    "settings.write",
    async (context) => {
      const { store } = templatesOf()
      const kind = templateKind(context)
      const expected = Number(context.url.searchParams.get("expectedVersion"))
      if (!Number.isSafeInteger(expected) || expected < 0)
        throw new ValidationError("expectedVersion must be a version number")
      const comment = context.url.searchParams.get("comment") ?? undefined
      const result = await store.save({
        kind,
        template: undefined,
        expectedVersion: expected,
        actor: context.actor,
        origin: context.origin,
        ...(comment === undefined ? {} : { comment }),
      })
      return json(result)
    },
    "auth.templates.reset",
  )
}
