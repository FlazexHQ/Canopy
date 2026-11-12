import type { InternalAdapter, SecretConfig } from "@better-auth/core"
import { runWithTransaction } from "@better-auth/core/context"
import { mongodbAdapter } from "@better-auth/mongo-adapter"
import { passkey } from "@better-auth/passkey"
import { hashPassword, symmetricEncrypt, verifyPassword } from "better-auth/crypto"
import { betterAuth } from "better-auth/minimal"
import { admin } from "better-auth/plugins/admin"
import { anonymous } from "better-auth/plugins/anonymous"
import { bearer } from "better-auth/plugins/bearer"
import { emailOTP } from "better-auth/plugins/email-otp"
import { genericOAuth } from "better-auth/plugins/generic-oauth"
import { generateExportedKeyPair, type JwtOptions, jwt } from "better-auth/plugins/jwt"
import { magicLink } from "better-auth/plugins/magic-link"
import { twoFactor } from "better-auth/plugins/two-factor"
import type { MongoClient } from "mongodb"
import type { Mailer } from "./email/mailer.ts"
import type { KeyMaterial, KeyRing, SigningAlgorithm } from "./keyring.ts"
import { isLegacyHash, verifyLegacyHash } from "./legacy-passwords.ts"
import type { AuthLogger } from "./logger.ts"

/** An OAuth provider Better Auth knows by name. */
export type SocialProviderId = "google" | "github" | "apple" | "microsoft" | "discord"

/** Client credentials of a named OAuth provider. */
export interface SocialProviderOptions {
  readonly clientId: string
  readonly clientSecret: string
  /** Microsoft only: the Entra ID tenant, or `common`. */
  readonly tenantId?: string
}

/** A generic OpenID Connect provider, configured through its discovery document. */
export interface OidcProviderOptions {
  /** The provider id used in `/auth/v1/sign-in/social` and `/auth/v1/callback/{id}`. */
  readonly id: string
  readonly discoveryUrl: string
  readonly clientId: string
  readonly clientSecret: string
  /** @default ["openid", "email", "profile"] */
  readonly scopes?: readonly string[]
}

/** Engine settings, already validated by the provider. */
export interface EngineSettings {
  readonly appName: string
  readonly publicUrl: string
  readonly secret: string
  readonly mongo: MongoClient
  readonly authDatabase: string
  readonly trustedOrigins: readonly string[]
  readonly accessTokenTtlSeconds: number
  readonly algorithm: SigningAlgorithm
  readonly emailPassword: {
    readonly enabled: boolean
    readonly minPasswordLength: number
    readonly requireEmailVerification: boolean
  }
  readonly magicLink: boolean
  readonly emailOtp: boolean
  readonly anonymous: boolean
  /** TOTP second factor with backup codes. */
  readonly twoFactor: boolean
  /** WebAuthn passkeys, for the relying party of the public URL. */
  readonly passkeys: boolean
  readonly socialProviders: Readonly<Partial<Record<SocialProviderId, SocialProviderOptions>>>
  readonly oidcProviders: readonly OidcProviderOptions[]
  readonly session: { readonly expiresInSeconds: number; readonly updateAgeSeconds: number }
  readonly rateLimit: { readonly windowSeconds: number; readonly max: number }
}

/** What the engine calls back into. */
export interface EngineHooks {
  readonly mailer: Mailer
  readonly keyring: KeyRing
  readonly logger: AuthLogger
  /** Whether magic link metadata marks an invite sent by an admin. */
  isInvite(metadata: Readonly<Record<string, unknown>> | undefined): boolean
  sessionCreated(
    session: { readonly id: string; readonly userId: string },
    path: string | undefined,
  ): void
  sessionEnded(session: { readonly id: string; readonly userId: string }): void
  userCreated(user: { readonly id: string }, path: string | undefined): void
  /** Replaces an imported password hash with a native one after a successful sign in. */
  rehash(legacy: string, hash: string): Promise<void>
}

/** The collections of `canopy_auth`. */
export const AUTH_COLLECTIONS = {
  users: "users",
  sessions: "sessions",
  accounts: "accounts",
  verifications: "verifications",
  twoFactors: "two_factors",
  passkeys: "passkeys",
  rateLimits: "rate_limits",
  signingKeys: "signing_keys",
  leases: "leases",
  identifierLimits: "identifier_limits",
} as const

/**
 * Paths that create a session only after a second factor or a passkey, so the session's access tokens
 * carry `aal: "aal2"`.
 */
const AAL2_PATHS = new Set([
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
  "/two-factor/verify-otp",
  "/passkey/verify-authentication",
])

/** The assurance level of a session created on `path`. */
function assuranceOf(path: string | undefined): "aal1" | "aal2" {
  return path !== undefined && AAL2_PATHS.has(path) ? "aal2" : "aal1"
}

/** The header that carries the client address the front handler resolved. Clients cannot set it. */
export const CLIENT_IP_HEADER = "x-canopy-client-ip"

const ADMIN_PATHS = [
  "/admin/list-users",
  "/admin/get-user",
  "/admin/create-user",
  "/admin/update-user",
  "/admin/set-role",
  "/admin/ban-user",
  "/admin/unban-user",
  "/admin/impersonate-user",
  "/admin/stop-impersonating",
  "/admin/list-user-sessions",
  "/admin/revoke-user-session",
  "/admin/revoke-user-sessions",
  "/admin/remove-user",
  "/admin/set-user-password",
  "/admin/has-permission",
]

const EMAIL_OTP_PATHS = [
  "/email-otp/send-verification-otp",
  "/email-otp/check-verification-otp",
  "/email-otp/verify-email",
  "/sign-in/email-otp",
  "/email-otp/request-password-reset",
  "/forget-password/email-otp",
  "/email-otp/reset-password",
  "/email-otp/request-email-change",
  "/email-otp/change-email",
]

/** Better Auth routes that are off for a given configuration. */
function disabledPaths(settings: EngineSettings): string[] {
  const paths = ["/token", "/jwks", ...ADMIN_PATHS]
  if (!settings.anonymous) paths.push("/sign-in/anonymous", "/delete-anonymous-user")
  if (!settings.magicLink) paths.push("/sign-in/magic-link", "/magic-link/verify")
  if (!settings.emailOtp) paths.push(...EMAIL_OTP_PATHS)
  paths.push("/two-factor/send-otp", "/two-factor/verify-otp")
  return paths
}

function keyPairConfig(
  algorithm: SigningAlgorithm,
): NonNullable<JwtOptions["jwks"]>["keyPairConfig"] {
  return algorithm === "ES256" ? { alg: "ES256" } : { alg: "EdDSA", crv: "Ed25519" }
}

/** Creates key material for the keyring, encrypted with the engine secret the way the JWT plugin reads it. */
export function keyMinter(
  algorithm: SigningAlgorithm,
  secret: () => Promise<Parameters<typeof symmetricEncrypt>[0]["key"]>,
): () => Promise<KeyMaterial> {
  return async () => {
    const { publicWebKey, privateWebKey } = await generateExportedKeyPair({
      jwks: { keyPairConfig: keyPairConfig(algorithm) },
    })
    const encrypted = await symmetricEncrypt({
      key: await secret(),
      data: JSON.stringify(privateWebKey),
    })
    return {
      publicKey: JSON.stringify(publicWebKey),
      privateKey: JSON.stringify(encrypted),
      alg: algorithm,
      ...(algorithm === "EdDSA" ? { crv: "Ed25519" as const } : { crv: "P-256" as const }),
    }
  }
}

function socialProviders(settings: EngineSettings) {
  const out: Record<string, { clientId: string; clientSecret: string; tenantId?: string }> = {}
  for (const [id, provider] of Object.entries(settings.socialProviders)) {
    if (provider === undefined) continue
    out[id] = {
      clientId: provider.clientId,
      clientSecret: provider.clientSecret,
      ...(provider.tenantId === undefined ? {} : { tenantId: provider.tenantId }),
    }
  }
  return out
}

function configure(settings: EngineSettings, hooks: EngineHooks) {
  if (process.env["BETTER_AUTH_TELEMETRY"] !== undefined) {
    hooks.logger.warn({}, "BETTER_AUTH_TELEMETRY is ignored; telemetry stays off")
    delete process.env["BETTER_AUTH_TELEMETRY"]
  }
  const { mailer, logger } = hooks
  return betterAuth({
    appName: settings.appName,
    baseURL: settings.publicUrl,
    basePath: "/auth/v1",
    secret: settings.secret,
    database: mongodbAdapter(settings.mongo.db(settings.authDatabase), { client: settings.mongo }),
    telemetry: { enabled: false },
    logger: {
      level: "warn",
      log: (level, message, ...args) => {
        if (level === "error") logger.error({ args }, message)
        else if (level === "warn") logger.warn({ args }, message)
      },
    },
    trustedOrigins: [...settings.trustedOrigins],
    emailAndPassword: {
      enabled: settings.emailPassword.enabled,
      requireEmailVerification: settings.emailPassword.requireEmailVerification,
      minPasswordLength: settings.emailPassword.minPasswordLength,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      password: {
        hash: (password) => hashPassword(password),
        verify: async ({ hash, password }) => {
          if (!isLegacyHash(hash)) return verifyPassword({ hash, password })
          if (!(await verifyLegacyHash(hash, password))) return false
          await hooks.rehash(hash, await hashPassword(password))
          return true
        },
      },
      sendResetPassword: ({ user, url }) =>
        mailer.send("reset_password", { email: user.email, url }),
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: ({ user, url }) =>
        mailer.send("verification", { email: user.email, url }),
    },
    user: {
      modelName: AUTH_COLLECTIONS.users,
      changeEmail: {
        enabled: true,
        sendChangeEmailConfirmation: ({ user, newEmail, url }) =>
          mailer.send("email_change", { email: user.email, newEmail, url }),
      },
      additionalFields: {
        roles: { type: "string[]", required: false, input: false, defaultValue: [] },
        appMetadata: { type: "json", required: false, input: false },
        userMetadata: { type: "json", required: false, input: true },
      },
    },
    session: {
      modelName: AUTH_COLLECTIONS.sessions,
      additionalFields: {
        aal: { type: "string", required: false, input: false, defaultValue: "aal1" },
      },
      expiresIn: settings.session.expiresInSeconds,
      updateAge: settings.session.updateAgeSeconds,
    },
    account: { modelName: AUTH_COLLECTIONS.accounts },
    verification: { modelName: AUTH_COLLECTIONS.verifications },
    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: AUTH_COLLECTIONS.rateLimits,
      window: settings.rateLimit.windowSeconds,
      max: settings.rateLimit.max,
    },
    socialProviders: socialProviders(settings),
    advanced: {
      // Better Auth skips origin and redirect checks when NODE_ENV is "test" unless this is set explicitly.
      disableOriginCheck: false,
      cookiePrefix: "canopy",
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      backgroundTasks: {
        handler: (promise) => {
          promise.catch((error: unknown) =>
            logger.error({ err: error }, "auth background task failed"),
          )
        },
      },
    },
    disabledPaths: disabledPaths(settings),
    databaseHooks: {
      user: {
        create: {
          after: async (user, context) => hooks.userCreated({ id: user.id }, context?.path),
        },
      },
      session: {
        create: {
          before: async (session, context) => ({
            data: { ...session, aal: assuranceOf(context?.path) },
          }),
          after: async (session, context) =>
            hooks.sessionCreated({ id: session.id, userId: session.userId }, context?.path),
        },
        delete: {
          after: async (session) => hooks.sessionEnded({ id: session.id, userId: session.userId }),
        },
      },
    },
    plugins: [
      bearer(),
      jwt({
        disableSettingJwtHeader: true,
        adapter: {
          getJwks: async () => hooks.keyring.signingKeys(),
          createJwk: async () => {
            throw new Error("No active signing key: the key rotation job has not run")
          },
        },
        jwks: { keyPairConfig: keyPairConfig(settings.algorithm) },
        jwt: {
          issuer: `${settings.publicUrl}/auth/v1`,
          audience: settings.publicUrl,
          expirationTime: `${settings.accessTokenTtlSeconds}s`,
          definePayload: () => {
            throw new Error("Access tokens are minted only by /auth/v1/token")
          },
        },
      }),
      anonymous({ emailDomainName: "anonymous.canopy.invalid" }),
      magicLink({
        expiresIn: 900,
        sendMagicLink: ({ email, url, metadata }) =>
          mailer.send(hooks.isInvite(metadata) ? "invite" : "magic_link", { email, url }),
      }),
      emailOTP({
        otpLength: 6,
        expiresIn: 300,
        allowedAttempts: 3,
        sendVerificationOTP: ({ email, otp }) => mailer.send("otp", { email, otp }),
      }),
      admin({ defaultRole: "user" }),
      ...(settings.twoFactor
        ? [
            twoFactor({
              issuer: settings.appName,
              twoFactorTable: AUTH_COLLECTIONS.twoFactors,
              backupCodeOptions: { amount: 10, length: 10 },
            }),
          ]
        : []),
      ...(settings.passkeys
        ? [
            passkey({
              rpID: new URL(settings.publicUrl).hostname,
              rpName: settings.appName,
              origin: [
                ...new Set([new URL(settings.publicUrl).origin, ...settings.trustedOrigins]),
              ],
              schema: { passkey: { modelName: AUTH_COLLECTIONS.passkeys } },
            }),
          ]
        : []),
      genericOAuth({
        config: settings.oidcProviders.map((provider) => ({
          providerId: provider.id,
          clientId: provider.clientId,
          clientSecret: provider.clientSecret,
          discoveryUrl: provider.discoveryUrl,
          scopes: [...(provider.scopes ?? ["openid", "email", "profile"])],
          pkce: true,
          requireIdTokenVerification: true,
        })),
      }),
    ],
  })
}

/** A session as the engine returns it. */
export interface EngineSession {
  readonly id: string
  readonly userId: string
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly expiresAt: Date
  /** `aal2` when the session was created after a second factor or with a passkey. */
  readonly aal?: string | null | undefined
  readonly ipAddress?: string | null | undefined
  readonly userAgent?: string | null | undefined
}

/** A user as the engine returns it, with Canopy's additional fields. */
export interface EngineUser {
  readonly id: string
  readonly email: string
  readonly emailVerified: boolean
  readonly name?: string | null | undefined
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly isAnonymous?: boolean | null | undefined
  readonly roles?: unknown
  readonly appMetadata?: unknown
  readonly userMetadata?: unknown
  readonly banned?: boolean | null | undefined
  readonly banReason?: string | null | undefined
  readonly banExpires?: Date | null | undefined
}

/**
 * The parts of Better Auth Canopy uses, in one place. Everything else goes through `handler`, so replacing
 * the engine means reimplementing this interface and the routes the SDK calls.
 */
export interface EngineApi {
  handler(request: Request): Promise<Response>
  /** Resolves the session of a request, extending it when due; `headers` carries refreshed cookies. */
  getSession(headers: Headers): Promise<{
    readonly found: { readonly session: EngineSession; readonly user: EngineUser } | null
    readonly headers: Headers
  }>
  /** Signs an access token with the active key of the keyring. */
  signJwt(payload: Readonly<Record<string, unknown>>): Promise<string>
  /** Sends a magic link the way `/sign-in/magic-link` does. */
  sendMagicLink(input: {
    readonly email: string
    readonly callbackURL: string
    readonly metadata?: Readonly<Record<string, unknown>>
  }): Promise<void>
  /** Sends a verification email to the address of a user. */
  sendVerificationEmail(email: string, callbackURL: string | undefined): Promise<void>
  /** Internal adapter access: undocumented upstream, so pinned versions and integration tests guard it. */
  context(): Promise<EngineContext>
}

/** The engine internals Canopy builds on: user and session storage, transactions and hashing. */
interface EngineContext {
  readonly internalAdapter: InternalAdapter
  /** Runs `fn` in one MongoDB transaction; engine writes inside it join the transaction. */
  transaction<R>(fn: () => Promise<R>): Promise<R>
  hashPassword(password: string): Promise<string>
  readonly secret: string | SecretConfig
}

/**
 * Configures Better Auth for built in mode: its own database through a `MongoClient` (so multi document
 * writes are transactional), the `/auth/v1` base path, access tokens signed only through Canopy's `/token`
 * with keys from Canopy's keyring, and every admin route turned off (Canopy admins are separate accounts).
 */
export function createEngine(settings: EngineSettings, hooks: EngineHooks): EngineApi {
  const auth = configure(settings, hooks)
  return {
    handler: (request) => auth.handler(request),
    async getSession(headers) {
      const result = await auth.api.getSession({ headers, returnHeaders: true })
      const found = result.response
      return {
        found:
          found === null
            ? null
            : {
                session: found.session as EngineSession,
                user: found.user as unknown as EngineUser,
              },
        headers: result.headers,
      }
    },
    async signJwt(payload) {
      const { token } = await auth.api.signJWT({ body: { payload: { ...payload } } })
      return token
    },
    async sendMagicLink(input) {
      await auth.api.signInMagicLink({
        body: {
          email: input.email,
          callbackURL: input.callbackURL,
          ...(input.metadata === undefined ? {} : { metadata: { ...input.metadata } }),
        },
        headers: new Headers(),
      })
    },
    async sendVerificationEmail(email, callbackURL) {
      await auth.api.sendVerificationEmail({
        body: { email, ...(callbackURL === undefined ? {} : { callbackURL }) },
        headers: new Headers(),
      })
    },
    async context() {
      const context = await auth.$context
      return {
        internalAdapter: context.internalAdapter,
        transaction: <R>(fn: () => Promise<R>): Promise<R> =>
          runWithTransaction(context.adapter, fn).then((value) => value),
        hashPassword: (password) => context.password.hash(password),
        secret: context.secretConfig,
      }
    },
  }
}
