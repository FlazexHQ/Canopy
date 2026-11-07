import type {
  AuthSession,
  AuthUser,
  CreateUserInput,
  InviteInput,
  ListUsersQuery,
  UpdateUserInput,
  UserAdmin,
  UserPage,
} from "@canopy/auth"
import { ConflictError, NotFoundError, ValidationError } from "@canopy/protocol"
import { MongoServerError } from "mongodb"
import type { AuditLog } from "./audit.ts"
import type { EngineApi, EngineSession, EngineUser } from "./engine.ts"

const RESERVED_ROLES = new Set(["anon", "authenticated", "service", "public"])
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function record(value: unknown): Readonly<Record<string, unknown>> {
  let parsed = value
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value)
    } catch {
      return {}
    }
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {}
}

function strings(value: unknown): readonly string[] {
  let parsed = value
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value)
    } catch {
      return []
    }
  }
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : []
}

/** Converts an engine user into the public {@link AuthUser} shape. */
export function toAuthUser(user: EngineUser): AuthUser {
  const anonymous = user.isAnonymous === true
  return {
    id: user.id,
    email: anonymous ? undefined : user.email,
    emailVerified: user.emailVerified,
    name: user.name === null || user.name === undefined || user.name === "" ? undefined : user.name,
    isAnonymous: anonymous,
    roles: strings(user.roles),
    appMetadata: record(user.appMetadata),
    userMetadata: record(user.userMetadata),
    banned: user.banned === true,
    banReason: user.banReason ?? undefined,
    banExpires: user.banExpires ?? undefined,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  }
}

function toAuthSession(session: EngineSession): AuthSession {
  return {
    id: session.id,
    userId: session.userId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    expiresAt: session.expiresAt,
    ipAddress: session.ipAddress ?? undefined,
    userAgent: session.userAgent ?? undefined,
  }
}

function checkRoles(roles: readonly string[] | undefined): void {
  if (roles === undefined) return
  for (const role of roles) {
    if (typeof role !== "string" || role === "" || RESERVED_ROLES.has(role))
      throw new ValidationError(
        `The role ${JSON.stringify(role)} cannot be assigned; anon, authenticated, service and public are reserved`,
      )
  }
}

function checkMetadata(name: string, value: unknown): void {
  if (value === undefined) return
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ValidationError(`${name} must be an object`)
}

function checkEmail(email: string): string {
  const normalized = email.trim().toLowerCase()
  if (!EMAIL.test(normalized)) throw new ValidationError("Invalid email address")
  return normalized
}

/** What {@link EngineUserAdmin} needs from the provider. */
export interface UserAdminHooks {
  readonly engine: EngineApi
  readonly audit: AuditLog
  readonly minPasswordLength: number
  /** Revokes every access token of the user issued until now. */
  revokeUser(sub: string): void
  /** Sends an invite link to `email`, landing on `redirectTo`. */
  sendInvite(email: string, redirectTo: string): Promise<void>
}

/**
 * User management on Better Auth's internal adapter. The admin plugin's own endpoints need a Better Auth admin
 * session, and Canopy admins are separate accounts, so `/admin/v1/users` goes through here. Multi document
 * changes run in one transaction.
 */
export class EngineUserAdmin implements UserAdmin {
  private readonly hooks: UserAdminHooks

  constructor(hooks: UserAdminHooks) {
    this.hooks = hooks
  }

  private async require(id: string): Promise<EngineUser> {
    const context = await this.hooks.engine.context()
    const user = (await context.internalAdapter.findUserById(id)) as EngineUser | null
    if (user === null) throw new NotFoundError("No such user")
    return user
  }

  private checkPassword(password: string | undefined): void {
    if (password === undefined) return
    if (password.length < this.hooks.minPasswordLength || password.length > 128)
      throw new ValidationError(`Passwords need ${this.hooks.minPasswordLength} to 128 characters`)
  }

  async list(query: ListUsersQuery = {}): Promise<UserPage> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 1000)
    const offset = Math.max(query.offset ?? 0, 0)
    const where =
      query.email === undefined || query.email === ""
        ? undefined
        : [{ field: "email", operator: "starts_with" as const, value: query.email.toLowerCase() }]
    const context = await this.hooks.engine.context()
    const users = (await context.internalAdapter.listUsers(
      limit,
      offset,
      { field: "createdAt", direction: "desc" },
      where,
    )) as EngineUser[]
    const total = await context.internalAdapter.countTotalUsers(where)
    return { users: users.map(toAuthUser), total }
  }

  async get(id: string): Promise<AuthUser | undefined> {
    const context = await this.hooks.engine.context()
    const user = (await context.internalAdapter.findUserById(id)) as EngineUser | null
    return user === null ? undefined : toAuthUser(user)
  }

  async create(input: CreateUserInput): Promise<AuthUser> {
    const email = checkEmail(input.email)
    checkRoles(input.roles)
    checkMetadata("appMetadata", input.appMetadata)
    checkMetadata("userMetadata", input.userMetadata)
    this.checkPassword(input.password)
    const context = await this.hooks.engine.context()
    if ((await context.internalAdapter.findUserByEmail(email)) !== null)
      throw new ConflictError("A user with this email exists")
    const hash =
      input.password === undefined ? undefined : await context.hashPassword(input.password)
    let created: EngineUser
    try {
      created = await context.transaction(async () => {
        const user = (await context.internalAdapter.createUser(
          {
            email,
            name: input.name ?? "",
            emailVerified: input.emailVerified ?? false,
            roles: [...(input.roles ?? [])],
            appMetadata: { ...input.appMetadata },
            userMetadata: { ...input.userMetadata },
          },
          { method: "admin" },
        )) as EngineUser
        if (hash !== undefined)
          await context.internalAdapter.linkAccount({
            providerId: "credential",
            accountId: user.id,
            userId: user.id,
            password: hash,
          })
        return user
      })
    } catch (error: unknown) {
      if (error instanceof MongoServerError && error.code === 11000)
        throw new ConflictError("A user with this email exists", { cause: error })
      throw error
    }
    this.hooks.audit.record({
      action: "auth.admin.user_created",
      actor: { type: "admin" },
      target: { type: "user", id: created.id },
    })
    return toAuthUser(created)
  }

  async update(id: string, input: UpdateUserInput): Promise<AuthUser> {
    checkRoles(input.roles)
    checkMetadata("appMetadata", input.appMetadata)
    checkMetadata("userMetadata", input.userMetadata)
    this.checkPassword(input.password)
    const existing = await this.require(id)
    const email = input.email === undefined ? undefined : checkEmail(input.email)
    const context = await this.hooks.engine.context()
    if (email !== undefined && email !== existing.email) {
      const owner = await context.internalAdapter.findUserByEmail(email)
      if (owner !== null) throw new ConflictError("A user with this email exists")
    }
    const data: Record<string, unknown> = {}
    if (email !== undefined) data["email"] = email
    if (input.name !== undefined) data["name"] = input.name
    if (input.emailVerified !== undefined) data["emailVerified"] = input.emailVerified
    if (input.roles !== undefined) data["roles"] = [...input.roles]
    if (input.appMetadata !== undefined) data["appMetadata"] = { ...input.appMetadata }
    if (input.userMetadata !== undefined) data["userMetadata"] = { ...input.userMetadata }
    const hash =
      input.password === undefined ? undefined : await context.hashPassword(input.password)
    let updated: EngineUser
    try {
      updated = await context.transaction(async () => {
        const user =
          Object.keys(data).length === 0
            ? existing
            : ((await context.internalAdapter.updateUser(id, data)) as EngineUser)
        if (hash !== undefined) {
          const account = await context.internalAdapter.findCredentialAccount(id)
          if (account === null)
            await context.internalAdapter.linkAccount({
              providerId: "credential",
              accountId: id,
              userId: id,
              password: hash,
            })
          else await context.internalAdapter.updatePassword(id, hash)
        }
        return user
      })
    } catch (error: unknown) {
      if (error instanceof MongoServerError && error.code === 11000)
        throw new ConflictError("A user with this email exists", { cause: error })
      throw error
    }
    this.hooks.audit.record({
      action: "auth.admin.user_updated",
      actor: { type: "admin" },
      target: { type: "user", id },
      details: { fields: [...Object.keys(data), ...(hash === undefined ? [] : ["password"])] },
    })
    return toAuthUser(updated)
  }

  async ban(
    id: string,
    options: { readonly reason?: string; readonly until?: Date } = {},
  ): Promise<AuthUser> {
    await this.require(id)
    const context = await this.hooks.engine.context()
    const user = await context.transaction(async () => {
      const banned = (await context.internalAdapter.updateUser(id, {
        banned: true,
        banReason: options.reason ?? null,
        banExpires: options.until ?? null,
      })) as EngineUser
      await context.internalAdapter.deleteUserSessions(id)
      return banned
    })
    this.hooks.revokeUser(id)
    this.hooks.audit.record({
      action: "auth.admin.user_banned",
      actor: { type: "admin" },
      target: { type: "user", id },
      ...(options.reason === undefined ? {} : { details: { reason: options.reason } }),
    })
    return toAuthUser(user)
  }

  async unban(id: string): Promise<AuthUser> {
    await this.require(id)
    const context = await this.hooks.engine.context()
    const user = (await context.internalAdapter.updateUser(id, {
      banned: false,
      banReason: null,
      banExpires: null,
    })) as EngineUser
    this.hooks.audit.record({
      action: "auth.admin.user_unbanned",
      actor: { type: "admin" },
      target: { type: "user", id },
    })
    return toAuthUser(user)
  }

  async delete(id: string): Promise<boolean> {
    const context = await this.hooks.engine.context()
    if ((await context.internalAdapter.findUserById(id)) === null) return false
    await context.transaction(async () => {
      await context.internalAdapter.deleteUserSessions(id)
      await context.internalAdapter.deleteAccounts(id)
      await context.internalAdapter.deleteUser(id)
    })
    this.hooks.revokeUser(id)
    this.hooks.audit.record({
      action: "auth.admin.user_deleted",
      actor: { type: "admin" },
      target: { type: "user", id },
    })
    return true
  }

  async listSessions(id: string): Promise<readonly AuthSession[]> {
    await this.require(id)
    const context = await this.hooks.engine.context()
    const sessions = await context.internalAdapter.listSessions(id, { onlyActiveSessions: true })
    return sessions.map(toAuthSession)
  }

  async revokeSessions(id: string, sessionId?: string): Promise<number> {
    await this.require(id)
    const context = await this.hooks.engine.context()
    const sessions = await context.internalAdapter.listSessions(id)
    const chosen =
      sessionId === undefined ? sessions : sessions.filter((session) => session.id === sessionId)
    if (sessionId !== undefined && chosen.length === 0) throw new NotFoundError("No such session")
    for (const session of chosen) await context.internalAdapter.deleteSession(session.token)
    this.hooks.audit.record({
      action: "auth.admin.sessions_revoked",
      actor: { type: "admin" },
      target: { type: "user", id },
      details: { count: chosen.length, ...(sessionId === undefined ? {} : { sessionId }) },
    })
    return chosen.length
  }

  async invite(input: InviteInput): Promise<AuthUser> {
    const email = checkEmail(input.email)
    checkRoles(input.roles)
    checkMetadata("appMetadata", input.appMetadata)
    const context = await this.hooks.engine.context()
    const found = await context.internalAdapter.findUserByEmail(email)
    let user: AuthUser
    if (found === null) {
      user = await this.create({
        email,
        ...(input.roles === undefined ? {} : { roles: input.roles }),
        ...(input.appMetadata === undefined ? {} : { appMetadata: input.appMetadata }),
      })
    } else {
      user = toAuthUser(found.user as EngineUser)
      if (input.roles !== undefined || input.appMetadata !== undefined)
        user = await this.update(user.id, {
          ...(input.roles === undefined ? {} : { roles: input.roles }),
          ...(input.appMetadata === undefined ? {} : { appMetadata: input.appMetadata }),
        })
    }
    await this.hooks.sendInvite(email, input.redirectTo ?? "/")
    this.hooks.audit.record({
      action: "auth.admin.user_invited",
      actor: { type: "admin" },
      target: { type: "user", id: user.id },
    })
    return user
  }
}
