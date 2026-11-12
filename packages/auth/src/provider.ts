import type { JSONWebKeySet, JWTPayload } from "jose"
import type { JwtAuthOptions } from "./authenticator.ts"

/** The claims of an access token minted by built in auth. */
export interface AccessTokenClaims extends JWTPayload {
  readonly sub: string
  /** The session the token was minted for. */
  readonly sid?: string
  readonly role?: string
  readonly roles?: readonly string[]
  readonly email?: string
  readonly email_verified?: boolean
  readonly is_anonymous?: boolean
  readonly aal?: string
  readonly app_metadata?: Readonly<Record<string, unknown>>
  readonly user_metadata?: Readonly<Record<string, unknown>>
}

/** An app user of built in auth, as the admin API shows it. */
export interface AuthUser {
  readonly id: string
  /** `undefined` for anonymous users. */
  readonly email: string | undefined
  readonly emailVerified: boolean
  readonly name: string | undefined
  readonly isAnonymous: boolean
  readonly roles: readonly string[]
  /** Written only by `service` and admins, so policies may rely on it. */
  readonly appMetadata: Readonly<Record<string, unknown>>
  /** Editable by the user. Never use it in policies. */
  readonly userMetadata: Readonly<Record<string, unknown>>
  readonly banned: boolean
  readonly banReason: string | undefined
  readonly banExpires: Date | undefined
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** A session of an app user. The session token itself is never exposed. */
export interface AuthSession {
  readonly id: string
  readonly userId: string
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly expiresAt: Date
  readonly ipAddress: string | undefined
  readonly userAgent: string | undefined
}

/** What a new user starts with. */
export interface CreateUserInput {
  readonly email: string
  /** Without a password the user signs in with a magic link, an OTP or OAuth. */
  readonly password?: string
  readonly name?: string
  /** @default false */
  readonly emailVerified?: boolean
  readonly roles?: readonly string[]
  readonly appMetadata?: Readonly<Record<string, unknown>>
  readonly userMetadata?: Readonly<Record<string, unknown>>
}

/** The fields an admin may change. Omitted fields stay as they are. */
export interface UpdateUserInput {
  readonly email?: string
  readonly name?: string
  readonly emailVerified?: boolean
  readonly roles?: readonly string[]
  readonly appMetadata?: Readonly<Record<string, unknown>>
  readonly userMetadata?: Readonly<Record<string, unknown>>
  readonly password?: string
}

/** A page of users. */
export interface UserPage {
  readonly users: readonly AuthUser[]
  readonly total: number
}

/** Paging and filtering for {@link UserAdmin.list}. */
export interface ListUsersQuery {
  /** @default 50, at most 1000 */
  readonly limit?: number
  /** @default 0 */
  readonly offset?: number
  /** Users whose email starts with this text (case insensitive). */
  readonly email?: string
}

/** A password hash exported from another system. Base64 fields are standard base64. */
export type ImportedPasswordHash =
  | { readonly algorithm: "bcrypt"; readonly hash: string }
  | { readonly algorithm: "argon2id"; readonly hash: string }
  | {
      readonly algorithm: "pbkdf2-sha256" | "pbkdf2-sha512" | "pbkdf2-sha1"
      readonly iterations: number
      readonly salt: string
      readonly hash: string
    }
  | {
      /** Firebase Auth's modified scrypt; the first four fields are the project's hash parameters. */
      readonly algorithm: "firebase-scrypt"
      readonly signerKey: string
      readonly saltSeparator: string
      readonly rounds: number
      readonly memCost: number
      readonly salt: string
      readonly hash: string
    }

/** A user to import from another identity system. */
export interface ImportUserInput {
  readonly email: string
  readonly emailVerified?: boolean
  readonly name?: string
  readonly createdAt?: Date
  /** Imported banned, so the user cannot sign in until unbanned. */
  readonly disabled?: boolean
  readonly roles?: readonly string[]
  readonly appMetadata?: Readonly<Record<string, unknown>>
  readonly userMetadata?: Readonly<Record<string, unknown>>
  /** Checked on the first sign in, then replaced by a native hash of the same password. */
  readonly passwordHash?: ImportedPasswordHash
  /** Linked OAuth accounts, so the user signs in with the same provider without a new account. */
  readonly identities?: readonly { readonly provider: string; readonly subject: string }[]
}

/** The outcome of an import. */
export interface ImportResult {
  readonly created: number
  /** Users whose email already exists; they are left unchanged. */
  readonly skipped: number
  readonly failed: readonly { readonly email: string; readonly reason: string }[]
}

/** Invites a user by email: the user is created if needed and receives a sign in link. */
export interface InviteInput {
  readonly email: string
  /** Where the link lands after sign in. Must pass the redirect allowlist. */
  readonly redirectTo?: string
  readonly roles?: readonly string[]
  readonly appMetadata?: Readonly<Record<string, unknown>>
}

/** User management for `/admin/v1/users`, Studio and the CLI. */
export interface UserAdmin {
  list(query?: ListUsersQuery): Promise<UserPage>
  get(id: string): Promise<AuthUser | undefined>
  create(input: CreateUserInput): Promise<AuthUser>
  update(id: string, input: UpdateUserInput): Promise<AuthUser>
  /** Blocks sign in and ends every session of the user. */
  ban(id: string, options?: { readonly reason?: string; readonly until?: Date }): Promise<AuthUser>
  unban(id: string): Promise<AuthUser>
  /** Deletes the user with its sessions and linked accounts. Returns false when there was no such user. */
  delete(id: string): Promise<boolean>
  listSessions(id: string): Promise<readonly AuthSession[]>
  /** Ends one session, or every session of the user without `sessionId`. Returns how many ended. */
  revokeSessions(id: string, sessionId?: string): Promise<number>
  /**
   * Ends every session of every user and revokes every access token issued until now. Returns how many
   * sessions ended.
   */
  revokeAllSessions(): Promise<number>
  invite(input: InviteInput): Promise<AuthUser>
  /** Imports users with their password hashes and identities; absent when the provider cannot. */
  import?(users: readonly ImportUserInput[]): Promise<ImportResult>
}

/**
 * A revoked session or user. Access tokens stay valid until they expire, so verifiers keep these and refuse
 * matching tokens: `session` refuses tokens with the same `sid`, `user` refuses tokens of `sub` issued at or
 * before `at`, and `all` refuses every token issued at or before `at` (its `sub` is `*`).
 */
export interface Revocation {
  readonly kind: "session" | "user" | "all"
  readonly sub: string
  readonly sid?: string
  readonly at: Date
  /** After this the revocation is moot because every affected token has expired. */
  readonly expiresAt: Date
}

/** Where a request came from, as the server saw the socket. */
export interface RequestInfo {
  /** The peer address of the connection; forwarded headers are only trusted from configured proxies. */
  readonly clientAddress?: string
}

/**
 * The contract of a built in identity provider. The SDK only talks to the routes `handler` serves, so a
 * different engine can replace the first one (Better Auth) without breaking applications.
 */
export interface AuthProvider extends AsyncDisposable {
  /** Serves `/auth/v1/*` and `/.well-known/jwks.json`. Anything else is answered with 404. */
  handler(request: Request, info?: RequestInfo): Promise<Response>
  /** Verifies an access token in process, refusing revoked sessions. */
  verifyAccessToken(token: string): Promise<AccessTokenClaims>
  /** The public keys that verify access tokens, the next key included before it signs. */
  jwks(): Promise<JSONWebKeySet>
  readonly users: UserAdmin
  /** Options for an `Authenticator` that verifies this provider's tokens in process. */
  readonly verification: JwtAuthOptions
  /** Calls `listener` for every revocation, local or from another node. Returns an unsubscribe function. */
  onRevocation(listener: (revocation: Revocation) => void): () => void
  close(): Promise<void>
}
