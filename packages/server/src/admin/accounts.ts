import { createHash, randomBytes } from "node:crypto"
import type { Environment } from "@canopy/config"
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  UnauthorizedError,
  ValidationError,
} from "@canopy/protocol"
import {
  type ClientSession,
  type Collection,
  type Db,
  type MongoClient,
  MongoServerError,
} from "mongodb"
import type { Actor, AuditLog, RequestOrigin } from "../audit.ts"
import {
  checkPasswordStrength,
  DUMMY_PASSWORD_HASH,
  hashPassword,
  verifyPassword,
} from "./passwords.ts"
import { lockoutMs, RateLimiter } from "./rate-limit.ts"
import type { AdminRole } from "./rbac.ts"
import type { SecretBox } from "./secrets.ts"
import { base32Decode, generateTotpSecret, totpUri, verifyTotp } from "./totp.ts"

/** An admin account as `canopy.admin_users` stores it. Separate from app users. */
export interface AdminUserDocument {
  _id: string
  /** Lowercased. */
  email: string
  name?: string
  role: AdminRole
  passwordHash: string
  /** Set for accounts created with a generated password. */
  mustChangePassword: boolean
  totp?: { secret: string; confirmed: boolean; lastStep?: number }
  disabled: boolean
  failedLogins: number
  lockedUntil?: Date
  createdAt: Date
  createdBy: string
  updatedAt: Date
  passwordChangedAt: Date
  lastLoginAt?: Date
}

/** An admin session as `canopy.admin_sessions` stores it: only hashes of the token and the CSRF token. */
export interface AdminSessionDocument {
  /** The SHA-256 of the session token. */
  _id: string
  userId: string
  csrfHash: string
  /** `cookie` sessions need the CSRF token and an allowed Origin on mutations; `bearer` ones do not. */
  transport: "cookie" | "bearer"
  createdAt: Date
  lastSeenAt: Date
  expiresAt: Date
  ip?: string
  userAgent?: string
}

/** An admin account as the admin API shows it. */
export interface AdminUser {
  readonly id: string
  readonly email: string
  readonly name: string | undefined
  readonly role: AdminRole
  readonly mustChangePassword: boolean
  readonly totpEnabled: boolean
  readonly disabled: boolean
  readonly createdAt: Date
  readonly lastLoginAt: Date | undefined
}

/** A valid session with its account. */
export interface AdminSession {
  /** The session id, or the token id for `token` sessions. */
  readonly id: string
  /** The account; for a token, its role is the lower of the token's and the account's. */
  readonly user: AdminUser
  /** `token` for admin API tokens, which are accepted as `Authorization: Bearer` only. */
  readonly transport: "cookie" | "bearer" | "token"
  readonly csrfHash: string
  /** Absent for tokens that never expire. */
  readonly expiresAt: Date | undefined
  /** The admin API token behind a `token` session. */
  readonly token?: {
    readonly id: string
    readonly name: string
    readonly prefix: string
    readonly role: AdminRole
  }
}

/** The secret an authenticator app needs, shown once at enrollment. */
export interface TotpEnrollment {
  readonly secret: string
  readonly uri: string
}

/** A new session: its tokens are only ever returned here. */
export interface LoginResult {
  readonly user: AdminUser
  readonly token: string
  readonly csrfToken: string
  readonly expiresAt: Date
}

/** Options of {@link AdminAccounts}. */
export interface AdminAccountsOptions {
  readonly client: MongoClient
  readonly meta: Db
  readonly audit: AuditLog
  readonly secrets: SecretBox
  readonly environment: Environment
  /** @default 12 hours */
  readonly sessionLifetimeMs?: number
  /** @default 1 hour */
  readonly idleTimeoutMs?: number
  /** How long a setup token stays valid. @default 24 hours */
  readonly setupTokenTtlMs?: number
  readonly now?: () => number
}

const SESSION_PREFIX = "canopy_admin_"
const SETUP_PREFIX = "canopy_setup_"
const EMAIL = /^[^\s@]+@[^\s@]+$/
const TOUCH_INTERVAL_MS = 60_000
const INVALID_LOGIN = "Invalid email or password"

/** The hex SHA-256 of a token, which is all the meta database stores of session and API tokens. */
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function token(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`
}

/** Hashes a CSRF token the way sessions store it. */
export function csrfHash(value: string): string {
  return sha256(`csrf:${value}`)
}

function normalizeEmail(email: string): string {
  const value = email.trim().toLowerCase()
  if (value.length > 320 || !EMAIL.test(value)) throw new ValidationError("The email is not valid")
  return value
}

function view(doc: AdminUserDocument): AdminUser {
  return {
    id: doc._id,
    email: doc.email,
    name: doc.name,
    role: doc.role,
    mustChangePassword: doc.mustChangePassword,
    totpEnabled: doc.totp?.confirmed === true,
    disabled: doc.disabled,
    createdAt: doc.createdAt,
    lastLoginAt: doc.lastLoginAt,
  }
}

/** The audit actor of an account, and of the admin API token it acts through when there is one. */
export function actorOf(user: AdminUser, tokenId?: string): Actor {
  return {
    type: "admin",
    id: user.id,
    email: user.email,
    role: user.role,
    ...(tokenId === undefined ? {} : { tokenId }),
  }
}

/**
 * Admin accounts and sessions: the first run claim, password and TOTP login with rate limits and lockout,
 * sessions with an absolute and an idle lifetime, and account management with the rules that keep at least
 * one owner and stop anyone from changing their own role.
 */
export class AdminAccounts {
  readonly users: Collection<AdminUserDocument>
  readonly sessions: Collection<AdminSessionDocument>
  private readonly settings: Collection<{ _id: string; [key: string]: unknown }>
  private readonly client: MongoClient
  private readonly audit: AuditLog
  private readonly secrets: SecretBox
  private readonly lifetimeMs: number
  private readonly idleMs: number
  private readonly setupTtlMs: number
  private readonly now: () => number
  private readonly byIp: RateLimiter
  private readonly byEmail: RateLimiter
  private readonly setupAttempts: RateLimiter

  constructor(options: AdminAccountsOptions) {
    this.client = options.client
    this.users = options.meta.collection<AdminUserDocument>("admin_users")
    this.sessions = options.meta.collection<AdminSessionDocument>("admin_sessions")
    this.settings = options.meta.collection("settings")
    this.audit = options.audit
    this.secrets = options.secrets
    this.lifetimeMs = options.sessionLifetimeMs ?? 12 * 3_600_000
    this.idleMs = options.idleTimeoutMs ?? 3_600_000
    this.setupTtlMs = options.setupTokenTtlMs ?? 24 * 3_600_000
    this.now = options.now ?? Date.now
    this.byIp = new RateLimiter({ limit: 30, windowMs: 5 * 60_000, now: this.now })
    this.byEmail = new RateLimiter({ limit: 10, windowMs: 5 * 60_000, now: this.now })
    this.setupAttempts = new RateLimiter({ limit: 10, windowMs: 5 * 60_000, now: this.now })
  }

  /** Whether an enabled owner exists. */
  async hasOwner(): Promise<boolean> {
    return (await this.users.countDocuments({ role: "owner", disabled: false }, { limit: 1 })) > 0
  }

  /**
   * On a server that has never been claimed, makes a one time setup token and stores its hash. Returns
   * `undefined` once an owner exists. Every node (and every restart) adds its own token; any of them works
   * until one is used.
   */
  async createSetupToken(): Promise<string | undefined> {
    if (await this.hasOwner()) return undefined
    if ((await this.settings.countDocuments({ _id: "claimed" })) > 0) return undefined
    const value = token(SETUP_PREFIX)
    await this.settings.updateOne(
      { _id: "setup" },
      {
        $push: {
          tokens: {
            $each: [{ hash: sha256(value), expiresAt: new Date(this.now() + this.setupTtlMs) }],
            $slice: -20,
          },
        },
      } as never,
      { upsert: true },
    )
    return value
  }

  /**
   * Creates the first owner with a setup token. The owner's TOTP secret is returned for enrollment and
   * confirmed by the first login. Anyone without the token, and anyone once an owner exists, is refused.
   */
  async claim(
    input: {
      readonly token: string
      readonly email: string
      readonly password: string
      readonly name?: string
    },
    origin: RequestOrigin,
  ): Promise<{ readonly user: AdminUser; readonly totp: TotpEnrollment }> {
    const system: Actor = { type: "system", id: "setup" }
    const retry = this.setupAttempts.hit(origin.ip ?? "unknown")
    if (retry > 0) {
      await this.audit.record({
        action: "setup.claim",
        actor: system,
        outcome: "failed",
        origin,
        details: { reason: "rate limited" },
      })
      throw new RateLimitError("Too many setup attempts", {
        details: { retryAfterSeconds: Math.ceil(retry / 1000) },
      })
    }
    const setup = await this.settings.findOne({ _id: "setup" })
    const tokens = (Array.isArray(setup?.["tokens"]) ? setup["tokens"] : []) as {
      hash: string
      expiresAt: Date
    }[]
    const hash = sha256(input.token)
    const valid =
      input.token.startsWith(SETUP_PREFIX) &&
      tokens.some((entry) => entry.hash === hash && entry.expiresAt.getTime() > this.now())
    if (!valid || (await this.hasOwner())) {
      await this.audit.record({ action: "setup.claim", actor: system, outcome: "failed", origin })
      if (valid) throw new ConflictError("This server already has an owner")
      throw new UnauthorizedError(
        "The setup token is not valid; use the one printed in the server logs",
      )
    }
    checkPasswordStrength(input.password)
    const email = normalizeEmail(input.email)
    const secret = generateTotpSecret()
    const now = new Date(this.now())
    const doc: AdminUserDocument = {
      _id: `adm_${randomBytes(12).toString("base64url")}`,
      email,
      ...(input.name === undefined ? {} : { name: input.name }),
      role: "owner",
      passwordHash: await hashPassword(input.password),
      mustChangePassword: false,
      totp: { secret: this.secrets.seal(secret, `totp:${email}`), confirmed: false },
      disabled: false,
      failedLogins: 0,
      createdAt: now,
      createdBy: "setup",
      updatedAt: now,
      passwordChangedAt: now,
    }
    await this.transaction(async (session) => {
      try {
        await this.settings.insertOne({ _id: "claimed", at: now, by: doc._id }, { session })
      } catch (error: unknown) {
        if (error instanceof MongoServerError && error.code === 11000)
          throw new ConflictError("This server already has an owner")
        throw error
      }
      await this.users.insertOne(doc, { session })
      await this.settings.deleteOne({ _id: "setup" }, { session })
      await this.audit.record(
        { action: "setup.claim", actor: actorOf(view(doc)), target: { adminId: doc._id }, origin },
        session,
      )
    })
    return { user: view(doc), totp: { secret, uri: totpUri(secret, email) } }
  }

  private async transaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = this.client.startSession()
    try {
      return await session.withTransaction(work)
    } finally {
      await session.endSession()
    }
  }

  private async failLogin(
    user: AdminUserDocument | null,
    email: string,
    origin: RequestOrigin,
    reason: string,
  ): Promise<never> {
    if (user !== null) {
      const updated = await this.users.findOneAndUpdate(
        { _id: user._id },
        { $inc: { failedLogins: 1 } },
        { returnDocument: "after" },
      )
      const wait = lockoutMs(updated?.failedLogins ?? 0)
      if (wait > 0)
        await this.users.updateOne(
          { _id: user._id },
          { $set: { lockedUntil: new Date(this.now() + wait) } },
        )
    }
    await this.audit.record({
      action: "session.login",
      actor: { type: "admin", id: user?._id ?? "unknown", email },
      outcome: "failed",
      origin,
      details: { reason },
    })
    throw new UnauthorizedError(INVALID_LOGIN)
  }

  /**
   * Logs in with email, password and, for owners and accounts with TOTP, a current code. Refuses with one
   * generic message whether the account is unknown, disabled or the password is wrong, and spends the same
   * hashing time on each. Attempts are limited per address and per account, and repeated failures lock the
   * account for a doubling delay.
   */
  async login(
    input: { readonly email: string; readonly password: string; readonly totp?: string },
    origin: RequestOrigin,
    transport: "cookie" | "bearer",
  ): Promise<LoginResult> {
    const email = input.email.trim().toLowerCase().slice(0, 320)
    for (const [limiter, key] of [
      [this.byIp, `ip:${origin.ip ?? "unknown"}`],
      [this.byEmail, `email:${email}`],
    ] as const) {
      const retry = limiter.hit(key)
      if (retry > 0) {
        await this.audit.record({
          action: "session.login",
          actor: { type: "admin", id: "unknown", email },
          outcome: "failed",
          origin,
          details: { reason: "rate limited" },
        })
        throw new RateLimitError("Too many login attempts", {
          details: { retryAfterSeconds: Math.ceil(retry / 1000) },
        })
      }
    }
    const user = await this.users.findOne({ email })
    if (user?.lockedUntil !== undefined && user.lockedUntil.getTime() > this.now()) {
      await this.audit.record({
        action: "session.login",
        actor: { type: "admin", id: user._id, email },
        outcome: "failed",
        origin,
        details: { reason: "locked" },
      })
      throw new RateLimitError("Too many failed logins; try again later", {
        details: { retryAfterSeconds: Math.ceil((user.lockedUntil.getTime() - this.now()) / 1000) },
      })
    }
    const matches = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH)
    if (user === null || !matches || user.disabled)
      return this.failLogin(
        user,
        email,
        origin,
        user === null ? "unknown account" : matches ? "disabled" : "password",
      )

    const needsTotp = user.role === "owner" || user.totp?.confirmed === true
    if (needsTotp) {
      const pending = user.totp !== undefined && !user.totp.confirmed
      if (user.totp === undefined || (pending && input.totp === undefined)) {
        const enrollment = await this.beginTotp(user)
        throw new UnauthorizedError("Set up an authenticator app, then log in with its code", {
          details: { totpRequired: true, totpEnrollment: enrollment },
        })
      }
      if (input.totp === undefined)
        throw new UnauthorizedError("Enter the code of your authenticator app", {
          details: { totpRequired: true },
        })
      const secret = base32Decode(this.secrets.open(user.totp.secret, `totp:${user.email}`))
      const step = verifyTotp(secret, input.totp, this.now(), {
        ...(user.totp.lastStep === undefined ? {} : { lastStep: user.totp.lastStep }),
      })
      if (step === undefined) return this.failLogin(user, email, origin, "totp")
      const claimed = await this.users.updateOne(
        {
          _id: user._id,
          $or: [{ "totp.lastStep": { $lt: step } }, { "totp.lastStep": { $exists: false } }],
        },
        { $set: { "totp.lastStep": step, "totp.confirmed": true } },
      )
      if (claimed.modifiedCount === 0) return this.failLogin(user, email, origin, "totp reused")
    }

    const now = new Date(this.now())
    const sessionToken = token(SESSION_PREFIX)
    const csrf = randomBytes(32).toString("base64url")
    const expiresAt = new Date(now.getTime() + this.lifetimeMs)
    await this.sessions.insertOne({
      _id: sha256(sessionToken),
      userId: user._id,
      csrfHash: csrfHash(csrf),
      transport,
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
      ...(origin.ip === undefined ? {} : { ip: origin.ip }),
      ...(origin.userAgent === undefined ? {} : { userAgent: origin.userAgent.slice(0, 512) }),
    })
    const updated = await this.users.findOneAndUpdate(
      { _id: user._id },
      { $set: { failedLogins: 0, lastLoginAt: now }, $unset: { lockedUntil: "" } },
      { returnDocument: "after" },
    )
    this.byEmail.reset(`email:${email}`)
    const account = view(updated ?? user)
    await this.audit.record({
      action: "session.login",
      actor: actorOf(account),
      origin,
      details: { transport },
    })
    return { user: account, token: sessionToken, csrfToken: csrf, expiresAt }
  }

  private async beginTotp(user: AdminUserDocument): Promise<TotpEnrollment> {
    if (user.totp !== undefined && !user.totp.confirmed) {
      const secret = this.secrets.open(user.totp.secret, `totp:${user.email}`)
      return { secret, uri: totpUri(secret, user.email) }
    }
    const secret = generateTotpSecret()
    await this.users.updateOne(
      { _id: user._id, "totp.confirmed": { $ne: true } },
      {
        $set: {
          totp: { secret: this.secrets.seal(secret, `totp:${user.email}`), confirmed: false },
        },
      },
    )
    return { secret, uri: totpUri(secret, user.email) }
  }

  /**
   * Starts TOTP enrollment for the signed in account. The secret is confirmed by {@link confirmTotp} (or, for
   * owners, by the next login). An account whose TOTP is already confirmed cannot replace it here.
   */
  async enrollTotp(session: AdminSession, origin: RequestOrigin): Promise<TotpEnrollment> {
    const user = await this.users.findOne({ _id: session.user.id })
    if (user === null) throw new NotFoundError("No such admin")
    if (user.totp?.confirmed === true)
      throw new ConflictError("TOTP is already set up for this account")
    const enrollment = await this.beginTotp(user)
    await this.audit.record({ action: "admin.totp.enroll", actor: actorOf(session.user), origin })
    return enrollment
  }

  /** Confirms a pending TOTP secret with a current code. */
  async confirmTotp(session: AdminSession, code: string, origin: RequestOrigin): Promise<void> {
    const user = await this.users.findOne({ _id: session.user.id })
    if (user?.totp === undefined || user.totp.confirmed)
      throw new ConflictError("There is no pending TOTP enrollment")
    const secret = base32Decode(this.secrets.open(user.totp.secret, `totp:${user.email}`))
    const step = verifyTotp(secret, code, this.now())
    if (step === undefined) {
      await this.audit.record({
        action: "admin.totp.confirm",
        actor: actorOf(session.user),
        outcome: "failed",
        origin,
      })
      throw new ValidationError("The code is not valid")
    }
    await this.users.updateOne(
      { _id: user._id },
      { $set: { "totp.confirmed": true, "totp.lastStep": step, updatedAt: new Date(this.now()) } },
    )
    await this.audit.record({ action: "admin.totp.confirm", actor: actorOf(session.user), origin })
  }

  /**
   * Resolves a session token. Returns `undefined` for unknown, expired or idle sessions and for disabled or
   * removed accounts. The role is read from the account
   * every time, so role changes apply at once.
   */
  async session(sessionToken: string): Promise<AdminSession | undefined> {
    if (!sessionToken.startsWith(SESSION_PREFIX) || sessionToken.length > 200) return undefined
    const id = sha256(sessionToken)
    const doc = await this.sessions.findOne({ _id: id })
    const now = this.now()
    if (doc === null) return undefined
    if (doc.expiresAt.getTime() <= now || doc.lastSeenAt.getTime() + this.idleMs <= now) {
      await this.sessions.deleteOne({ _id: id })
      return undefined
    }
    const user = await this.users.findOne({ _id: doc.userId })
    if (user === null || user.disabled) {
      await this.sessions.deleteOne({ _id: id })
      return undefined
    }
    if (now - doc.lastSeenAt.getTime() >= TOUCH_INTERVAL_MS)
      await this.sessions.updateOne({ _id: id }, { $set: { lastSeenAt: new Date(now) } })
    return {
      id,
      user: view(user),
      transport: doc.transport,
      csrfHash: doc.csrfHash,
      expiresAt: doc.expiresAt,
    }
  }

  async logout(session: AdminSession, origin: RequestOrigin): Promise<void> {
    await this.sessions.deleteOne({ _id: session.id })
    await this.audit.record({ action: "session.logout", actor: actorOf(session.user), origin })
  }

  /** Changes the signed in account's password and ends its other sessions. */
  async changePassword(
    session: AdminSession,
    current: string,
    next: string,
    origin: RequestOrigin,
  ): Promise<void> {
    const user = await this.users.findOne({ _id: session.user.id })
    if (user === null || !(await verifyPassword(current, user.passwordHash))) {
      await this.audit.record({
        action: "admin.password.change",
        actor: actorOf(session.user),
        outcome: "failed",
        origin,
      })
      throw new ForbiddenError("The current password is not correct")
    }
    checkPasswordStrength(next)
    if (current === next) throw new ValidationError("Choose a different password")
    const now = new Date(this.now())
    await this.users.updateOne(
      { _id: user._id },
      {
        $set: {
          passwordHash: await hashPassword(next),
          mustChangePassword: false,
          passwordChangedAt: now,
          updatedAt: now,
        },
      },
    )
    await this.sessions.deleteMany({ userId: user._id, _id: { $ne: session.id } })
    await this.audit.record({
      action: "admin.password.change",
      actor: actorOf(session.user),
      origin,
    })
  }

  async list(): Promise<AdminUser[]> {
    return (await this.users.find({}).sort({ createdAt: 1 }).toArray()).map(view)
  }

  private guard(
    actor: AdminSession,
    targetRole: AdminRole | undefined,
    newRole: AdminRole | undefined,
  ): void {
    const touchesOwner = targetRole === "owner" || newRole === "owner"
    if (touchesOwner && actor.user.role !== "owner")
      throw new ForbiddenError("Only owners may manage owners")
  }

  /** Creates an admin with a generated password, returned once; it must be changed at first login. */
  async create(
    actor: AdminSession,
    input: { readonly email: string; readonly role: AdminRole; readonly name?: string },
    origin: RequestOrigin,
  ): Promise<{ readonly user: AdminUser; readonly password: string }> {
    this.guard(actor, undefined, input.role)
    return this.insertAdmin(input, actorOf(actor.user), origin)
  }

  /**
   * Creates an admin without a session, for bootstrap tools such as `canopy admin create` that reach the
   * meta database directly (and so already hold full control). Creating an owner also claims the server, so
   * setup tokens stop working. Owners enroll TOTP at their first login.
   */
  async createBootstrap(
    input: { readonly email: string; readonly role: AdminRole; readonly name?: string },
    actor: Actor,
    origin: RequestOrigin = {},
  ): Promise<{ readonly user: AdminUser; readonly password: string }> {
    const created = await this.insertAdmin(input, actor, origin)
    if (input.role === "owner") {
      await this.settings
        .insertOne({ _id: "claimed", at: new Date(this.now()), by: created.user.id })
        .catch((error: unknown) => {
          if (!(error instanceof MongoServerError && error.code === 11000)) throw error
        })
      await this.settings.deleteOne({ _id: "setup" })
    }
    return created
  }

  private async insertAdmin(
    input: { readonly email: string; readonly role: AdminRole; readonly name?: string },
    actor: Actor,
    origin: RequestOrigin,
  ): Promise<{ readonly user: AdminUser; readonly password: string }> {
    const email = normalizeEmail(input.email)
    const password = randomBytes(18).toString("base64url")
    const now = new Date(this.now())
    const doc: AdminUserDocument = {
      _id: `adm_${randomBytes(12).toString("base64url")}`,
      email,
      ...(input.name === undefined ? {} : { name: input.name }),
      role: input.role,
      passwordHash: await hashPassword(password),
      mustChangePassword: true,
      disabled: false,
      failedLogins: 0,
      createdAt: now,
      createdBy: actor.id,
      updatedAt: now,
      passwordChangedAt: now,
    }
    try {
      await this.users.insertOne(doc)
    } catch (error: unknown) {
      if (error instanceof MongoServerError && error.code === 11000)
        throw new ConflictError("An admin with this email already exists")
      throw error
    }
    await this.audit.record({
      action: "admin.create",
      actor,
      target: { adminId: doc._id, email, role: input.role },
      origin,
    })
    return { user: view(doc), password }
  }

  /** Finds an admin by id or email. */
  async find(idOrEmail: string): Promise<AdminUser | undefined> {
    const doc = await this.users.findOne(
      idOrEmail.includes("@") ? { email: idOrEmail.trim().toLowerCase() } : { _id: idOrEmail },
    )
    return doc === null ? undefined : view(doc)
  }

  /** Ends every admin session, the caller's included. Admin API tokens are not sessions and stay. */
  async endAllSessions(): Promise<number> {
    return (await this.sessions.deleteMany({})).deletedCount
  }

  /**
   * Seals every stored admin secret again with the current master key, for a secret still sealed with a
   * previous one (or in plain text from before a master key was set). Returns how many changed.
   */
  async resealSecrets(): Promise<number> {
    let changed = 0
    for await (const user of this.users.find({ totp: { $exists: true } })) {
      const totp = user.totp
      if (totp === undefined) continue
      const context = `totp:${user.email}`
      if (this.secrets.isCurrent(totp.secret, context)) continue
      const resealed = this.secrets.seal(this.secrets.open(totp.secret, context), context)
      const result = await this.users.updateOne(
        { _id: user._id, "totp.secret": totp.secret },
        { $set: { "totp.secret": resealed } },
      )
      changed += result.modifiedCount
    }
    return changed
  }

  /**
   * Clears an admin's TOTP secret and ends their sessions, for a lost authenticator. Owners must enroll a
   * new one at their next login. `session` is checked like other account changes; bootstrap tools pass
   * `undefined` with a system actor.
   */
  async resetTotp(
    id: string,
    actor: Actor,
    session: AdminSession | undefined,
    origin: RequestOrigin = {},
  ): Promise<AdminUser> {
    const target = await this.users.findOne({ _id: id })
    if (target === null) throw new NotFoundError("No such admin")
    if (session !== undefined) this.guard(session, target.role, undefined)
    const updated = await this.users.findOneAndUpdate(
      { _id: id },
      { $unset: { totp: "" }, $set: { updatedAt: new Date(this.now()) } },
      { returnDocument: "after" },
    )
    await this.sessions.deleteMany({ userId: id })
    await this.audit.record({
      action: "admin.totp.reset",
      actor,
      target: { adminId: id, email: target.email, role: target.role },
      origin,
    })
    return view(updated ?? target)
  }

  /** Changes an admin's role, name or disabled flag. Their sessions end when the role or flag changes. */
  async update(
    actor: AdminSession,
    id: string,
    changes: { readonly role?: AdminRole; readonly disabled?: boolean; readonly name?: string },
    origin: RequestOrigin,
  ): Promise<AdminUser> {
    const target = await this.users.findOne({ _id: id })
    if (target === null) throw new NotFoundError("No such admin")
    this.guard(actor, target.role, changes.role)
    if (id === actor.user.id && (changes.role !== undefined || changes.disabled !== undefined))
      throw new ForbiddenError("You cannot change your own role or disable yourself")
    const losesOwner =
      target.role === "owner" &&
      !target.disabled &&
      ((changes.role !== undefined && changes.role !== "owner") || changes.disabled === true)
    const updated = await this.transaction(async (session) => {
      if (losesOwner) {
        const owners = await this.users.countDocuments(
          { role: "owner", disabled: false },
          { session },
        )
        if (owners <= 1) throw new ConflictError("The last owner cannot be demoted or disabled")
      }
      const result = await this.users.findOneAndUpdate(
        { _id: id },
        {
          $set: {
            ...(changes.role === undefined ? {} : { role: changes.role }),
            ...(changes.disabled === undefined ? {} : { disabled: changes.disabled }),
            ...(changes.name === undefined ? {} : { name: changes.name }),
            updatedAt: new Date(this.now()),
          },
        },
        { returnDocument: "after", session },
      )
      if (result === null) throw new NotFoundError("No such admin")
      if (changes.role !== undefined || changes.disabled === true)
        await this.sessions.deleteMany({ userId: id }, { session })
      await this.audit.record(
        {
          action: "admin.update",
          actor: actorOf(actor.user),
          target: { adminId: id },
          diff: {
            before: { role: target.role, disabled: target.disabled, name: target.name ?? null },
            after: { role: result.role, disabled: result.disabled, name: result.name ?? null },
          },
          origin,
        },
        session,
      )
      return result
    })
    return view(updated)
  }

  /** Removes an admin and ends their sessions. */
  async remove(actor: AdminSession, id: string, origin: RequestOrigin): Promise<void> {
    const target = await this.users.findOne({ _id: id })
    if (target === null) throw new NotFoundError("No such admin")
    this.guard(actor, target.role, undefined)
    if (id === actor.user.id) throw new ForbiddenError("You cannot remove yourself")
    await this.transaction(async (session) => {
      if (target.role === "owner" && !target.disabled) {
        const owners = await this.users.countDocuments(
          { role: "owner", disabled: false },
          { session },
        )
        if (owners <= 1) throw new ConflictError("The last owner cannot be removed")
      }
      await this.users.deleteOne({ _id: id }, { session })
      await this.sessions.deleteMany({ userId: id }, { session })
      await this.audit.record(
        {
          action: "admin.remove",
          actor: actorOf(actor.user),
          target: { adminId: id, email: target.email, role: target.role },
          origin,
        },
        session,
      )
    })
  }
}
