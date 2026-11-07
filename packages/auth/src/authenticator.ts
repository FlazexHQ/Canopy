import { type RequestContext, Role } from "@canopy/policy"
import { ErrorCode, ForbiddenError, UnauthorizedError } from "@canopy/protocol"
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  decodeJwt,
  type JSONWebKeySet,
  type JWTPayload,
  type JWTVerifyGetKey,
  errors as joseErrors,
  jwtVerify,
} from "jose"
import { type ApiKeyRecord, type ApiKeyStore, apiKeyKind } from "./api-keys.ts"

/** How user tokens are verified (bring your own identity provider). */
export interface JwtAuthOptions {
  /** The JWKS endpoint of the identity provider. Must be HTTPS outside of tests. */
  readonly jwksUrl?: string
  /** A JWKS given inline, for tests or air gapped setups. */
  readonly jwks?: JSONWebKeySet
  /**
   * Resolves verification keys in process, for a provider that holds its own keys (built in auth). Takes
   * precedence over `jwks` and `jwksUrl`.
   */
  readonly keys?: JWTVerifyGetKey
  /** Refuses verified tokens of revoked sessions or users. */
  readonly isRevoked?: (claims: JWTPayload) => boolean
  readonly issuer: string | readonly string[]
  readonly audience?: string | readonly string[]
  /** Accepted algorithms. Pinned; `none` and HMAC algorithms are never accepted. */
  readonly algorithms?: readonly string[]
  /** The claim holding custom roles, for example `https://example.com/roles`. */
  readonly rolesClaim?: string
  /** Allow a JWT to assert the `service` role. Off by default. */
  readonly allowServiceRoleFromJwt?: boolean
  /** Clock skew tolerance in seconds. Defaults to 60. */
  readonly clockToleranceSeconds?: number
}

/** Project API keys. A publishable key maps to `anon`, a secret key to `service`. */
export interface KeyOptions {
  readonly publishable?: readonly string[]
  readonly secret?: readonly string[]
}

/** The issuer of view tokens, which let Studio follow data live as an impersonated caller. */
export const VIEW_TOKEN_ISSUER = "urn:canopy:studio"
/** The audience of view tokens. */
export const VIEW_TOKEN_AUDIENCE = "urn:canopy:view-as"
/** The claim of a view token holding the impersonated `{ roles, claims }`. */
export const VIEW_TOKEN_CLAIM = "canopy_view"

/** How view tokens are verified: the server's own key, never the identity provider's. */
export interface ViewTokenVerification {
  readonly key: Parameters<typeof jwtVerify>[1]
}

/** Options of an {@link Authenticator} beyond JWTs and config keys. */
export interface AuthenticatorOptions {
  /** Stored keys, checked after the keys of the config. */
  readonly store?: ApiKeyStore
  /**
   * Accepts view tokens signed with this key (EdDSA only), giving read only principals. A view token may
   * carry `service` alone, for Studio following data as the service role.
   */
  readonly viewTokens?: ViewTokenVerification
}

/** A verified caller. */
export interface Principal {
  readonly context: RequestContext
  /** The subject (`sub`) or `anon`/`service`. */
  readonly subject: string
  /** Token expiry in milliseconds since the epoch, if the caller sent a token. */
  readonly expiresAt: number | undefined
  /** The stored key the caller used, so its revocation can end the caller's connections. */
  readonly keyId?: string
  /** Set for view tokens: the caller may read and subscribe, never write. */
  readonly readOnly?: true
}

const DEFAULT_ALGORITHMS = ["EdDSA", "ES256", "ES384", "RS256", "RS384", "RS512", "PS256"]
const FORBIDDEN_ALGORITHMS = new Set(["none", "HS256", "HS384", "HS512"])

/** Verifies hello credentials and builds request contexts. */
export class Authenticator {
  private readonly keySet: JWTVerifyGetKey | undefined
  private readonly options: JwtAuthOptions | undefined
  private readonly keys: KeyOptions
  private readonly store: ApiKeyStore | undefined
  private readonly algorithms: string[]
  private readonly viewTokens: ViewTokenVerification | undefined

  constructor(
    options: JwtAuthOptions | undefined,
    keys: KeyOptions = {},
    extra: AuthenticatorOptions = {},
  ) {
    this.options = options
    this.keys = keys
    this.store = extra.store
    this.viewTokens = extra.viewTokens
    this.algorithms = [...(options?.algorithms ?? DEFAULT_ALGORITHMS)]
    for (const algorithm of this.algorithms) {
      if (FORBIDDEN_ALGORITHMS.has(algorithm))
        throw new TypeError(`The JWT algorithm ${algorithm} is not allowed`)
    }
    if (options === undefined) {
      this.keySet = undefined
    } else if (options.keys !== undefined) {
      this.keySet = options.keys
    } else if (options.jwks !== undefined) {
      this.keySet = createLocalJWKSet(options.jwks)
    } else if (options.jwksUrl !== undefined) {
      const url = new URL(options.jwksUrl)
      if (
        url.protocol !== "https:" &&
        url.hostname !== "localhost" &&
        url.hostname !== "127.0.0.1"
      ) {
        throw new TypeError("The JWKS URL must use HTTPS")
      }
      this.keySet = createRemoteJWKSet(url)
    } else {
      throw new TypeError("JWT auth needs jwksUrl or jwks")
    }
  }

  /**
   * Authenticates a `hello` (or `auth`) message. An empty token gives `anon`; a secret key gives `service`.
   * Throws {@link UnauthorizedError} or {@link ForbiddenError}.
   */
  async authenticate(key: string, token: string | undefined): Promise<Principal> {
    if (this.keys.secret?.includes(key) === true) return service(undefined)
    let stored: ApiKeyRecord | undefined
    if (this.store !== undefined && apiKeyKind(key) !== undefined) {
      stored = await this.store.find(key)
      if (stored?.revoked === true) throw new ForbiddenError("The API key was revoked")
      if (stored !== undefined) this.store.used?.(stored)
      if (stored?.kind === "secret") return service(stored.id)
    }
    if (
      stored === undefined &&
      this.keys.publishable !== undefined &&
      !this.keys.publishable.includes(key)
    ) {
      throw new UnauthorizedError("Unknown API key")
    }
    const keyId = stored === undefined ? {} : { keyId: stored.id }
    if (token === undefined || token === "") {
      return {
        context: { roles: new Set([Role.Anon]), claims: null, now: new Date() },
        subject: "anon",
        expiresAt: undefined,
        ...keyId,
      }
    }
    if (this.viewTokens !== undefined && issuerOf(token) === VIEW_TOKEN_ISSUER)
      return { ...(await this.verifyViewToken(token, this.viewTokens)), ...keyId }
    if (this.keySet === undefined || this.options === undefined)
      throw new UnauthorizedError("User tokens are not accepted")
    let payload: JWTPayload
    try {
      const verified = await jwtVerify(token, this.keySet, {
        algorithms: this.algorithms,
        issuer: [
          ...(typeof this.options.issuer === "string"
            ? [this.options.issuer]
            : this.options.issuer),
        ],
        ...(this.options.audience === undefined
          ? {}
          : {
              audience:
                typeof this.options.audience === "string"
                  ? this.options.audience
                  : [...this.options.audience],
            }),
        clockTolerance: this.options.clockToleranceSeconds ?? 60,
        requiredClaims: ["exp"],
      })
      payload = verified.payload
    } catch (error: unknown) {
      if (error instanceof joseErrors.JWTExpired)
        throw new UnauthorizedError("The token has expired", { cause: error }, true)
      throw new UnauthorizedError("Invalid token", { cause: error })
    }
    if (this.options.isRevoked?.(payload) === true)
      throw new UnauthorizedError("The session of this token was revoked")
    const roles = new Set<string>([Role.Authenticated])
    const claimed =
      this.options.rolesClaim === undefined ? undefined : readPath(payload, this.options.rolesClaim)
    if (Array.isArray(claimed)) {
      for (const role of claimed) {
        if (
          typeof role !== "string" ||
          role === Role.Anon ||
          role === Role.Authenticated ||
          role === Role.Public
        )
          continue
        if (role === Role.Service) {
          if (this.options.allowServiceRoleFromJwt !== true) {
            throw new ForbiddenError("A token may not assert the service role")
          }
          return {
            context: { roles: new Set([Role.Service]), claims: payload, now: new Date() },
            subject: String(payload.sub ?? "service"),
            expiresAt: expiry(payload),
            ...keyId,
          }
        }
        roles.add(role)
      }
    }
    return {
      context: { roles, claims: payload, now: new Date() },
      subject: typeof payload.sub === "string" ? payload.sub : "unknown",
      expiresAt: expiry(payload),
      ...keyId,
    }
  }

  private async verifyViewToken(
    token: string,
    verification: ViewTokenVerification,
  ): Promise<Principal> {
    let payload: JWTPayload
    try {
      payload = (
        await jwtVerify(token, verification.key, {
          algorithms: ["EdDSA"],
          issuer: VIEW_TOKEN_ISSUER,
          audience: VIEW_TOKEN_AUDIENCE,
          requiredClaims: ["exp"],
        })
      ).payload
    } catch (error: unknown) {
      if (error instanceof joseErrors.JWTExpired)
        throw new UnauthorizedError("The view token has expired", { cause: error }, true)
      throw new UnauthorizedError("Invalid view token", { cause: error })
    }
    const view = payload[VIEW_TOKEN_CLAIM]
    if (!isRecord(view) || !Array.isArray(view["roles"]))
      throw new UnauthorizedError("Invalid view token")
    const claims = view["claims"] === null ? null : view["claims"]
    if (claims !== null && !isRecord(claims)) throw new UnauthorizedError("Invalid view token")
    const roles = new Set<string>()
    for (const role of view["roles"]) {
      if (typeof role !== "string" || role === Role.Public)
        throw new UnauthorizedError("Invalid view token")
      roles.add(role)
    }
    if (claims !== null) roles.add(Role.Authenticated)
    const alone = (role: string): boolean => !roles.has(role) || roles.size === 1
    if (roles.size === 0 || !alone(Role.Anon) || !alone(Role.Service))
      throw new UnauthorizedError("Invalid view token")
    const subject = typeof claims?.["sub"] === "string" ? claims["sub"] : [...roles].join(",")
    return {
      context: { roles, claims, now: new Date() },
      subject,
      expiresAt: expiry(payload),
      readOnly: true,
    }
  }
}

function issuerOf(token: string): string | undefined {
  try {
    return decodeJwt(token).iss
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function service(keyId: string | undefined): Principal {
  return {
    context: { roles: new Set([Role.Service]), claims: null, now: new Date() },
    subject: "service",
    expiresAt: undefined,
    ...(keyId === undefined ? {} : { keyId }),
  }
}

function expiry(payload: JWTPayload): number | undefined {
  return typeof payload.exp === "number" ? payload.exp * 1000 : undefined
}

function readPath(payload: JWTPayload, path: string): unknown {
  if (Object.hasOwn(payload, path)) return (payload as Record<string, unknown>)[path]
  let value: unknown = payload
  for (const segment of path.split(".")) {
    if (typeof value !== "object" || value === null || !Object.hasOwn(value, segment))
      return undefined
    value = (value as Record<string, unknown>)[segment]
  }
  return value
}

/** The credentials an HTTP request carries. */
export interface Credentials {
  readonly key: string
  readonly token: string | undefined
}

const SECRET_KEY_PREFIX = "canopy_sk_"

/**
 * Reads the `apikey` and `Authorization: Bearer` headers. A secret key may also arrive as the bearer
 * token, for server callers that only set `Authorization`. Throws {@link UnauthorizedError} for a
 * malformed `Authorization` header.
 */
export function credentialsFromHeaders(headers: Headers): Credentials {
  const key = headers.get("apikey") ?? ""
  const authorization = headers.get("authorization")
  if (authorization === null) return { key, token: undefined }
  const match = /^Bearer[ ]+(\S+)[ ]*$/i.exec(authorization)
  if (match === null || match[1] === undefined)
    throw new UnauthorizedError("The Authorization header must use the Bearer scheme")
  const token = match[1]
  if (token.startsWith(SECRET_KEY_PREFIX)) {
    if (key !== "" && key !== token)
      throw new UnauthorizedError("The apikey header and the bearer secret key differ")
    return { key: token, token: undefined }
  }
  return { key, token }
}

/** True when the error means the token expired rather than being invalid. */
export function isExpired(error: unknown): boolean {
  return error instanceof UnauthorizedError && error.code === ErrorCode.TokenExpired
}
