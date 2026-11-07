import { ForbiddenError } from "@canopy/protocol"
import { boolean, integer, object, oneOf, optional, string } from "../../schema.ts"
import { CSRF_COOKIE, json, SESSION_COOKIE, setCookie } from "../http.ts"
import { ADMIN_ROLES, can } from "../rbac.ts"
import { roleAtMost } from "../tokens.ts"
import type { AdminDeps, RouteFn } from "./core.ts"

/** Registers the session, admin account and admin API token routes. */
export function registerSession(route: RouteFn, deps: AdminDeps): void {
  const { accounts, environment, tokens, require } = deps
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
      expiresAt: context.session.expiresAt ?? null,
      ...(context.session.token === undefined ? {} : { token: context.session.token }),
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

  // Admin API tokens

  route("GET", "tokens", "session", async (context) => {
    const all = context.url.searchParams.get("all") === "true"
    if (all) require(context, "admins.read")
    return json({ data: await tokens.list(all ? undefined : context.session.user.id) })
  })

  route(
    "POST",
    "tokens",
    "session",
    async (context) => {
      const body = object({
        name: string({ min: 1, max: 200 }),
        role: optional(oneOf(...ADMIN_ROLES)),
        expiresInDays: optional(integer({ min: 1, max: 3650 })),
      }).parse(await context.body())
      const role = body.role ?? context.session.user.role
      if (!roleAtMost(role, context.session.user.role)) {
        await context.audit({
          action: "admin_token.create",
          outcome: "denied",
          target: { name: body.name, role },
        })
        throw new ForbiddenError(
          `Your role (${context.session.user.role}) may not create a token for the ${role} role`,
        )
      }
      const created = await tokens.create(context.session, body, context.origin)
      return json({ token: created.token, ...created.info }, 201)
    },
    "admin_token.create",
  )

  route(
    "DELETE",
    "tokens/:id",
    "session",
    async (context) =>
      json(
        await tokens.revoke(
          context.session,
          context.params["id"] ?? "",
          {
            others: can(context.session.user.role, "admins.manage", environment),
            owners: can(context.session.user.role, "admins.manageOwners", environment),
          },
          context.origin,
        ),
      ),
    "admin_token.revoke",
  )
}
