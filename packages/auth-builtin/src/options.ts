import type { AuthUser } from "@canopy/auth"
import type { Db, MongoClient } from "mongodb"
import type { EmailOptions } from "./email/mailer.ts"
import type { OidcProviderOptions, SocialProviderId, SocialProviderOptions } from "./engine.ts"
import type { SigningAlgorithm } from "./keyring.ts"
import type { AuthLogger } from "./logger.ts"

/** What the claims hook receives. */
export interface ClaimsHookInput {
  readonly user: AuthUser
  readonly session: { readonly id: string }
  /** The app database, for reads such as memberships. */
  readonly db: Db
  /** Aborted when the hook runs out of time; pass it on to driver calls. */
  readonly signal: AbortSignal
}

/** What the claims hook may add. Canopy owns every other claim. */
export interface ClaimsHookResult {
  /** Merged over the stored `app_metadata`. */
  readonly app_metadata?: Readonly<Record<string, unknown>>
  /** Added to the stored roles. `anon`, `authenticated`, `service` and `public` are refused. */
  readonly roles?: readonly string[]
}

/**
 * Runs when an access token is minted. It must finish within the timeout (200 ms by default) and the token
 * must stay within 4 KiB; otherwise no token is issued and the caller gets `CANOPY_AUTH_HOOK_FAILED`.
 */
export type ClaimsHook = (
  input: ClaimsHookInput,
) => ClaimsHookResult | undefined | Promise<ClaimsHookResult | undefined>

/** Settings of {@link createBuiltinAuth}. */
export interface BuiltinAuthOptions {
  /** The client of the deployment. It is not closed by the provider. */
  readonly mongo: MongoClient
  /** The external base URL, for example `https://api.example.com`. Tokens use `${publicUrl}/auth/v1` as issuer. */
  readonly publicUrl: string
  /** Signs cookies and encrypts private keys. At least 32 characters. */
  readonly secret: string
  /** The app database the claims hook reads. Built in auth never writes to it. */
  readonly appDatabase: string
  /** @default "canopy" */
  readonly metaDatabase?: string
  /** @default "canopy_auth" */
  readonly authDatabase?: string
  /** Shown in emails. @default "Canopy" */
  readonly appName?: string
  /**
   * Origins (or URLs, whose origin is used) that redirects, OAuth callbacks and cross origin calls may use.
   * The origin of `publicUrl` is always allowed; relative paths are always allowed.
   */
  readonly redirectUrls?: readonly string[]
  /** 300 to 3600. @default 600 */
  readonly accessTokenTtlSeconds?: number
  /** @default "EdDSA" */
  readonly algorithm?: SigningAlgorithm
  readonly keyRotation?: {
    /** How long a key signs. @default 30 days */
    readonly intervalSeconds?: number
    /** How long a retired key stays published. @default 30 days */
    readonly graceSeconds?: number
    /** How often keys are reloaded and the rotation job runs. @default 30000 */
    readonly refreshMs?: number
  }
  /** `false` turns email and password sign in off. */
  readonly emailPassword?:
    | boolean
    | {
        /** At least 10. @default 10 */
        readonly minPasswordLength?: number
        /** Without it, sign up answers reveal whether an address is taken. @default true */
        readonly requireEmailVerification?: boolean
      }
  /** @default true */
  readonly magicLink?: boolean
  /** @default true */
  readonly emailOtp?: boolean
  /** @default false */
  readonly anonymous?: boolean
  readonly socialProviders?: Readonly<Partial<Record<SocialProviderId, SocialProviderOptions>>>
  readonly oidcProviders?: readonly OidcProviderOptions[]
  readonly claims?: ClaimsHook
  /** @default 200 */
  readonly claimsTimeoutMs?: number
  /** @default 4096 */
  readonly maxTokenBytes?: number
  /** Without it no email is sent, and each skipped email logs a warning. */
  readonly email?: EmailOptions
  /** Addresses or IPv4 CIDR ranges of proxies whose `X-Forwarded-For` is trusted. */
  readonly trustedProxies?: readonly string[]
  /** Per email address and route. @default 10 per 60 s */
  readonly identifierLimit?: { readonly max?: number; readonly windowSeconds?: number }
  /** Per client address, by the engine. @default 100 per 60 s */
  readonly rateLimit?: { readonly max?: number; readonly windowSeconds?: number }
  readonly session?: {
    /** @default 7 days */
    readonly expiresInSeconds?: number
    /** How often a used session is extended. @default 1 day */
    readonly updateAgeSeconds?: number
  }
  /** The response time of routes whose timing could reveal whether an email exists. @default 80 */
  readonly responseFloorMs?: number
  readonly logger?: AuthLogger
}
