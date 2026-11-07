import { createHash, randomBytes } from "node:crypto"
import { ForbiddenError, NotFoundError, ValidationError } from "@canopy/protocol"
import type { Collection, Db } from "mongodb"
import type { Actor, AuditLog, RequestOrigin } from "../audit.ts"
import { type AdminAccounts, type AdminSession, actorOf } from "./accounts.ts"
import { ADMIN_ROLES, type AdminRole } from "./rbac.ts"

/** The prefix of every admin API token, so leaked tokens are easy to recognize and scan for. */
export const ADMIN_TOKEN_PREFIX = "canopy_pat_"

/** An admin API token as `canopy.admin_tokens` stores it: only the hash of the secret. */
export interface AdminTokenDocument {
  _id: string
  /** The SHA-256 of the token. */
  hash: string
  /** The start of the token, shown in lists so a token can be recognized. */
  prefix: string
  name: string
  /** The most the token may do; it never exceeds its admin's current role. */
  role: AdminRole
  /** The admin the token acts as. */
  userId: string
  createdAt: Date
  createdBy: string
  expiresAt?: Date
  lastUsedAt?: Date
  revokedAt?: Date
  revokedBy?: string
}

/** An admin API token as the admin API shows it, never with its secret. */
export interface AdminTokenInfo {
  readonly id: string
  readonly name: string
  readonly prefix: string
  readonly role: AdminRole
  readonly userId: string
  readonly createdAt: Date
  readonly createdBy: string
  readonly expiresAt: Date | undefined
  readonly lastUsedAt: Date | undefined
  readonly revokedAt: Date | undefined
  /** Neither revoked nor expired. */
  readonly active: boolean
}

/** A new token: the secret is only ever returned here. */
export interface CreatedAdminToken {
  readonly token: string
  readonly info: AdminTokenInfo
}

/** Options of {@link AdminTokens}. */
export interface AdminTokensOptions {
  readonly meta: Db
  readonly accounts: AdminAccounts
  readonly audit: AuditLog
  /** How often `lastUsedAt` is written for a token in use. @default 60 seconds */
  readonly touchIntervalMs?: number
  readonly now?: () => number
}

const DISPLAY_LENGTH = ADMIN_TOKEN_PREFIX.length + 6
const MAX_LIFETIME_DAYS = 3650

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

/** How much a role may do, higher is more. */
function rank(role: AdminRole): number {
  return ADMIN_ROLES.length - ADMIN_ROLES.indexOf(role)
}

/** Whether `role` may do no more than `limit`. */
export function roleAtMost(role: AdminRole, limit: AdminRole): boolean {
  return rank(role) <= rank(limit)
}

/** The less privileged of two roles. */
export function lowerRole(a: AdminRole, b: AdminRole): AdminRole {
  return rank(a) <= rank(b) ? a : b
}

/**
 * Long lived admin API tokens for CI and GitOps, in `canopy.admin_tokens`. An admin creates one for a role
 * no higher than their own; it is stored as a hash with a display prefix, shown once, may expire and can
 * be revoked. A token acts as its admin with the lower of its role and the admin's current role, and stops
 * working when the admin is disabled or removed. Creating, revoking and refused uses are audited; the
 * admin API audits refused changes and every accepted use.
 */
export class AdminTokens {
  readonly collection: Collection<AdminTokenDocument>
  private readonly accounts: AdminAccounts
  private readonly audit: AuditLog
  private readonly touchMs: number
  private readonly now: () => number

  constructor(options: AdminTokensOptions) {
    this.collection = options.meta.collection<AdminTokenDocument>("admin_tokens")
    this.accounts = options.accounts
    this.audit = options.audit
    this.touchMs = options.touchIntervalMs ?? 60_000
    this.now = options.now ?? Date.now
  }

  /** Whether `value` looks like an admin API token (and not a session token). */
  static isToken(value: string): boolean {
    return value.startsWith(ADMIN_TOKEN_PREFIX)
  }

  private info(doc: AdminTokenDocument): AdminTokenInfo {
    const now = this.now()
    return {
      id: doc._id,
      name: doc.name,
      prefix: doc.prefix,
      role: doc.role,
      userId: doc.userId,
      createdAt: doc.createdAt,
      createdBy: doc.createdBy,
      expiresAt: doc.expiresAt,
      lastUsedAt: doc.lastUsedAt,
      revokedAt: doc.revokedAt,
      active: doc.revokedAt === undefined && (doc.expiresAt?.getTime() ?? Infinity) > now,
    }
  }

  /**
   * Creates a token for the signed in admin. `role` defaults to the admin's own and may not be higher;
   * `expiresInDays` is optional. Only sessions may create tokens, so a token cannot mint another one.
   */
  async create(
    session: AdminSession,
    input: { readonly name: string; readonly role?: AdminRole; readonly expiresInDays?: number },
    origin: RequestOrigin,
  ): Promise<CreatedAdminToken> {
    if (session.transport === "token")
      throw new ForbiddenError("Admin API tokens cannot create tokens; sign in to create one")
    const own = session.user.role
    const role = input.role ?? own
    if (!roleAtMost(role, own))
      throw new ForbiddenError(`A ${own} may not create a token for the ${role} role`)
    const days = input.expiresInDays
    if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > MAX_LIFETIME_DAYS))
      throw new ValidationError(
        `expiresInDays must be a whole number from 1 to ${MAX_LIFETIME_DAYS}`,
      )
    const token = `${ADMIN_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`
    const now = this.now()
    const doc: AdminTokenDocument = {
      _id: `tok_${randomBytes(12).toString("base64url")}`,
      hash: sha256(token),
      prefix: token.slice(0, DISPLAY_LENGTH),
      name: input.name,
      role,
      userId: session.user.id,
      createdAt: new Date(now),
      createdBy: session.user.id,
      ...(days === undefined ? {} : { expiresAt: new Date(now + days * 86_400_000) }),
    }
    await this.collection.insertOne(doc)
    await this.audit.record({
      action: "admin_token.create",
      actor: actorOf(session.user),
      target: {
        tokenId: doc._id,
        name: doc.name,
        role,
        prefix: doc.prefix,
        ...(doc.expiresAt === undefined ? {} : { expiresAt: doc.expiresAt }),
      },
      origin,
    })
    return { token, info: this.info(doc) }
  }

  /** Lists tokens, newest first: those of one admin, or every token. */
  async list(userId?: string): Promise<AdminTokenInfo[]> {
    const docs = await this.collection
      .find(userId === undefined ? {} : { userId })
      .sort({ createdAt: -1 })
      .limit(1000)
      .toArray()
    return docs.map((doc) => this.info(doc))
  }

  /** Reads one token. */
  async get(id: string): Promise<AdminTokenInfo | undefined> {
    const doc = await this.collection.findOne({ _id: id })
    return doc === null ? undefined : this.info(doc)
  }

  /**
   * Revokes a token at once. Admins revoke their own tokens; `others` lets the caller revoke anyone's, and
   * tokens with the owner role also need `owners`.
   */
  async revoke(
    session: AdminSession,
    id: string,
    may: { readonly others: boolean; readonly owners: boolean },
    origin: RequestOrigin,
  ): Promise<AdminTokenInfo> {
    const doc = await this.collection.findOne({ _id: id })
    const mine = doc?.userId === session.user.id
    if (doc === null || (!mine && !may.others)) throw new NotFoundError("No such admin API token")
    if (!mine && doc.role === "owner" && !may.owners)
      throw new ForbiddenError("Only owners may revoke the tokens of owners")
    const updated =
      doc.revokedAt === undefined
        ? await this.collection.findOneAndUpdate(
            { _id: id },
            { $set: { revokedAt: new Date(this.now()), revokedBy: session.user.id } },
            { returnDocument: "after" },
          )
        : doc
    await this.audit.record({
      action: "admin_token.revoke",
      actor: actorOf(session.user),
      target: {
        tokenId: id,
        name: doc.name,
        role: doc.role,
        prefix: doc.prefix,
        userId: doc.userId,
      },
      origin,
    })
    return this.info(updated ?? doc)
  }

  /**
   * The session a token stands for, or `undefined` when it is unknown, revoked, expired or its admin is
   * disabled or gone. Known tokens that are refused are audited.
   */
  async authenticate(value: string, origin: RequestOrigin): Promise<AdminSession | undefined> {
    if (!AdminTokens.isToken(value) || value.length > 200) return undefined
    const doc = await this.collection.findOne({ hash: sha256(value) })
    if (doc === null) return undefined
    const now = this.now()
    const refuse = async (reason: string, actor?: Actor): Promise<undefined> => {
      await this.audit.record({
        action: "admin_token.use",
        actor: actor ?? { type: "system", id: "anonymous" },
        outcome: "failed",
        target: { tokenId: doc._id, prefix: doc.prefix },
        origin,
        details: { reason },
      })
      return undefined
    }
    if (doc.revokedAt !== undefined) return refuse("revoked")
    if (doc.expiresAt !== undefined && doc.expiresAt.getTime() <= now) return refuse("expired")
    const user = await this.accounts.find(doc.userId)
    if (user === undefined) return refuse("admin removed")
    if (user.disabled) return refuse("admin disabled", actorOf(user))
    if (doc.lastUsedAt === undefined || now - doc.lastUsedAt.getTime() >= this.touchMs)
      await this.collection.updateOne({ _id: doc._id }, { $set: { lastUsedAt: new Date(now) } })
    return {
      id: doc._id,
      user: { ...user, role: lowerRole(doc.role, user.role) },
      transport: "token",
      csrfHash: "",
      expiresAt: doc.expiresAt,
      token: { id: doc._id, name: doc.name, prefix: doc.prefix, role: doc.role },
    }
  }
}
