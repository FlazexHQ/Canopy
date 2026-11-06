import { type RequestContext, Role } from '@canopy/policy'
import { ErrorCode, ForbiddenError, UnauthorizedError } from '@canopy/protocol'
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  type JSONWebKeySet,
  type JWTPayload,
  type JWTVerifyGetKey,
  errors as joseErrors,
  jwtVerify,
} from 'jose'

/** How user tokens are verified (bring your own identity provider). */
export interface JwtAuthOptions {
  /** The JWKS endpoint of the identity provider. Must be HTTPS outside of tests. */
  readonly jwksUrl?: string
  /** A JWKS given inline, for tests or air gapped setups. */
  readonly jwks?: JSONWebKeySet
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

/** A verified caller. */
export interface Principal {
  readonly context: RequestContext
  /** The subject (`sub`) or `anon`/`service`. */
  readonly subject: string
  /** Token expiry in milliseconds since the epoch, if the caller sent a token. */
  readonly expiresAt: number | undefined
}

const DEFAULT_ALGORITHMS = ['EdDSA', 'ES256', 'ES384', 'RS256', 'RS384', 'RS512', 'PS256']
const FORBIDDEN_ALGORITHMS = new Set(['none', 'HS256', 'HS384', 'HS512'])

/** Verifies hello credentials and builds request contexts. */
export class Authenticator {
  private readonly keySet: JWTVerifyGetKey | undefined
  private readonly options: JwtAuthOptions | undefined
  private readonly keys: KeyOptions
  private readonly algorithms: string[]

  constructor(options: JwtAuthOptions | undefined, keys: KeyOptions = {}) {
    this.options = options
    this.keys = keys
    this.algorithms = [...(options?.algorithms ?? DEFAULT_ALGORITHMS)]
    for (const algorithm of this.algorithms) {
      if (FORBIDDEN_ALGORITHMS.has(algorithm))
        throw new TypeError(`The JWT algorithm ${algorithm} is not allowed`)
    }
    if (options === undefined) {
      this.keySet = undefined
    } else if (options.jwks !== undefined) {
      this.keySet = createLocalJWKSet(options.jwks)
    } else if (options.jwksUrl !== undefined) {
      const url = new URL(options.jwksUrl)
      if (
        url.protocol !== 'https:' &&
        url.hostname !== 'localhost' &&
        url.hostname !== '127.0.0.1'
      ) {
        throw new TypeError('The JWKS URL must use HTTPS')
      }
      this.keySet = createRemoteJWKSet(url)
    } else {
      throw new TypeError('JWT auth needs jwksUrl or jwks')
    }
  }

  /**
   * Authenticates a `hello` (or `auth`) message. An empty token gives `anon`; a secret key gives `service`.
   * Throws {@link UnauthorizedError} or {@link ForbiddenError}.
   */
  async authenticate(key: string, token: string | undefined): Promise<Principal> {
    if (this.keys.secret?.includes(key) === true) {
      return {
        context: { roles: new Set([Role.Service]), claims: null, now: new Date() },
        subject: 'service',
        expiresAt: undefined,
      }
    }
    if (this.keys.publishable !== undefined && !this.keys.publishable.includes(key)) {
      throw new UnauthorizedError('Unknown API key')
    }
    if (token === undefined || token === '') {
      return {
        context: { roles: new Set([Role.Anon]), claims: null, now: new Date() },
        subject: 'anon',
        expiresAt: undefined,
      }
    }
    if (this.keySet === undefined || this.options === undefined)
      throw new UnauthorizedError('User tokens are not accepted')
    let payload: JWTPayload
    try {
      const verified = await jwtVerify(token, this.keySet, {
        algorithms: this.algorithms,
        issuer: [
          ...(typeof this.options.issuer === 'string'
            ? [this.options.issuer]
            : this.options.issuer),
        ],
        ...(this.options.audience === undefined
          ? {}
          : {
              audience:
                typeof this.options.audience === 'string'
                  ? this.options.audience
                  : [...this.options.audience],
            }),
        clockTolerance: this.options.clockToleranceSeconds ?? 60,
        requiredClaims: ['exp'],
      })
      payload = verified.payload
    } catch (error: unknown) {
      if (error instanceof joseErrors.JWTExpired)
        throw new UnauthorizedError('The token has expired', { cause: error }, true)
      throw new UnauthorizedError('Invalid token', { cause: error })
    }
    const roles = new Set<string>([Role.Authenticated])
    const claimed =
      this.options.rolesClaim === undefined ? undefined : readPath(payload, this.options.rolesClaim)
    if (Array.isArray(claimed)) {
      for (const role of claimed) {
        if (
          typeof role !== 'string' ||
          role === Role.Anon ||
          role === Role.Authenticated ||
          role === Role.Public
        )
          continue
        if (role === Role.Service) {
          if (this.options.allowServiceRoleFromJwt !== true) {
            throw new ForbiddenError('A token may not assert the service role')
          }
          return {
            context: { roles: new Set([Role.Service]), claims: payload, now: new Date() },
            subject: String(payload.sub ?? 'service'),
            expiresAt: expiry(payload),
          }
        }
        roles.add(role)
      }
    }
    return {
      context: { roles, claims: payload, now: new Date() },
      subject: typeof payload.sub === 'string' ? payload.sub : 'unknown',
      expiresAt: expiry(payload),
    }
  }
}

function expiry(payload: JWTPayload): number | undefined {
  return typeof payload.exp === 'number' ? payload.exp * 1000 : undefined
}

function readPath(payload: JWTPayload, path: string): unknown {
  if (Object.hasOwn(payload, path)) return (payload as Record<string, unknown>)[path]
  let value: unknown = payload
  for (const segment of path.split('.')) {
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, segment))
      return undefined
    value = (value as Record<string, unknown>)[segment]
  }
  return value
}

/** True when the error means the token expired rather than being invalid. */
export function isExpired(error: unknown): boolean {
  return error instanceof UnauthorizedError && error.code === ErrorCode.TokenExpired
}
