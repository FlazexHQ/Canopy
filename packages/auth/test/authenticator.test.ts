import { Role } from '@canopy/policy'
import { ErrorCode, ForbiddenError, UnauthorizedError } from '@canopy/protocol'
import {
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
  type JWTPayload,
  SignJWT,
  UnsecuredJWT,
} from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  Authenticator,
  credentialsFromHeaders,
  isExpired,
  type JwtAuthOptions,
} from '../src/index.ts'

const ISSUER = 'https://idp.example.test/'
const AUDIENCE = 'https://api.example.test'

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey']

let privateKey: PrivateKey
let otherKey: PrivateKey
let jwks: JSONWebKeySet

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519' })
  privateKey = pair.privateKey
  otherKey = (await generateKeyPair('EdDSA', { crv: 'Ed25519' })).privateKey
  jwks = {
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'EdDSA', use: 'sig' }],
  }
})

function options(extra: Partial<JwtAuthOptions> = {}): JwtAuthOptions {
  return { jwks, issuer: ISSUER, audience: AUDIENCE, rolesClaim: 'app.roles', ...extra }
}

async function sign(
  claims: JWTPayload,
  { key = privateKey, exp = '5m' as string | number, iss = ISSUER, aud = AUDIENCE } = {},
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'EdDSA', kid: 'k1' })
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(key)
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error: unknown) {
    return error
  }
  throw new Error('expected the promise to reject')
}

describe('Authenticator', () => {
  it('refuses unsigned and HMAC algorithms at construction', () => {
    for (const algorithm of ['none', 'HS256', 'HS384', 'HS512']) {
      expect(() => new Authenticator(options({ algorithms: [algorithm] }))).toThrow(TypeError)
    }
  })

  it('requires HTTPS for a remote JWKS except on loopback', () => {
    expect(
      () => new Authenticator({ issuer: ISSUER, jwksUrl: 'http://idp.example.test/jwks.json' }),
    ).toThrow(TypeError)
    expect(
      () => new Authenticator({ issuer: ISSUER, jwksUrl: 'http://localhost:9/jwks.json' }),
    ).not.toThrow()
    expect(() => new Authenticator({ issuer: ISSUER })).toThrow(TypeError)
  })

  it('maps a secret key to service and ignores any token', async () => {
    const auth = new Authenticator(options(), { secret: ['canopy_sk_1'] })
    const principal = await auth.authenticate('canopy_sk_1', 'not-a-jwt')
    expect([...principal.context.roles]).toEqual([Role.Service])
    expect(principal.subject).toBe('service')
  })

  it('gives anon without a token and rejects unknown publishable keys', async () => {
    const auth = new Authenticator(options(), { publishable: ['canopy_pk_1'] })
    const anon = await auth.authenticate('canopy_pk_1', undefined)
    expect([...anon.context.roles]).toEqual([Role.Anon])
    expect(anon.context.claims).toBeNull()
    const error = await rejection(auth.authenticate('canopy_pk_2', undefined))
    expect(error).toBeInstanceOf(UnauthorizedError)
  })

  it('rejects user tokens when no identity provider is configured', async () => {
    const auth = new Authenticator(undefined)
    const error = await rejection(auth.authenticate('', await sign({ sub: 'u1' })))
    expect(error).toBeInstanceOf(UnauthorizedError)
  })

  it('verifies a token into authenticated plus custom roles', async () => {
    const auth = new Authenticator(options())
    const token = await sign({ sub: 'u_alice', app: { roles: ['editor', 'anon', 7, 'public'] } })
    const principal = await auth.authenticate('', token)
    expect([...principal.context.roles].sort()).toEqual([Role.Authenticated, 'editor'].sort())
    expect(principal.subject).toBe('u_alice')
    expect(principal.expiresAt).toBeGreaterThan(Date.now())
    expect(principal.context.claims?.['sub']).toBe('u_alice')
  })

  it('reads a roles claim whose name contains dots before walking the path', async () => {
    const auth = new Authenticator(options({ rolesClaim: 'https://example.test/roles' }))
    const token = await sign({ sub: 'u1', 'https://example.test/roles': ['hr'] })
    const principal = await auth.authenticate('', token)
    expect(principal.context.roles.has('hr')).toBe(true)
  })

  it('refuses a token that asserts service unless allowed', async () => {
    const token = await sign({ sub: 'u1', app: { roles: ['service'] } })
    const error = await rejection(new Authenticator(options()).authenticate('', token))
    expect(error).toBeInstanceOf(ForbiddenError)
    const allowed = await new Authenticator(
      options({ allowServiceRoleFromJwt: true }),
    ).authenticate('', token)
    expect([...allowed.context.roles]).toEqual([Role.Service])
  })

  it('rejects wrong issuer, wrong audience, foreign signature and missing exp', async () => {
    const auth = new Authenticator(options())
    const cases = [
      await sign({ sub: 'u1' }, { iss: 'https://evil.example.test/' }),
      await sign({ sub: 'u1' }, { aud: 'https://other.example.test' }),
      await sign({ sub: 'u1' }, { key: otherKey }),
      await new SignJWT({ sub: 'u1' })
        .setProtectedHeader({ alg: 'EdDSA', kid: 'k1' })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .sign(privateKey),
      new UnsecuredJWT({ sub: 'u1' })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('5m')
        .encode(),
    ]
    for (const token of cases) {
      const error = await rejection(auth.authenticate('', token))
      expect(error).toBeInstanceOf(UnauthorizedError)
      expect(isExpired(error)).toBe(false)
    }
  })

  it('reports expiry beyond the clock tolerance as TokenExpired', async () => {
    const auth = new Authenticator(options({ clockToleranceSeconds: 5 }))
    const past = Math.floor(Date.now() / 1000) - 60
    const error = await rejection(auth.authenticate('', await sign({ sub: 'u1' }, { exp: past })))
    expect(error).toBeInstanceOf(UnauthorizedError)
    expect((error as UnauthorizedError).code).toBe(ErrorCode.TokenExpired)
    expect(isExpired(error)).toBe(true)
    const tolerant = new Authenticator(options({ clockToleranceSeconds: 120 }))
    await expect(
      tolerant.authenticate('', await sign({ sub: 'u1' }, { exp: past })),
    ).resolves.toBeDefined()
  })
})

describe('credentialsFromHeaders', () => {
  it('reads apikey and a bearer token', () => {
    const headers = new Headers({ apikey: 'canopy_pk_1', authorization: 'Bearer abc.def.ghi' })
    expect(credentialsFromHeaders(headers)).toEqual({ key: 'canopy_pk_1', token: 'abc.def.ghi' })
  })

  it('returns no token without an Authorization header', () => {
    expect(credentialsFromHeaders(new Headers({ apikey: 'k' }))).toEqual({
      key: 'k',
      token: undefined,
    })
    expect(credentialsFromHeaders(new Headers())).toEqual({ key: '', token: undefined })
  })

  it('accepts a secret key as the bearer token', () => {
    const headers = new Headers({ authorization: 'bearer canopy_sk_123' })
    expect(credentialsFromHeaders(headers)).toEqual({ key: 'canopy_sk_123', token: undefined })
  })

  it('rejects a bearer secret key that contradicts the apikey header', () => {
    const headers = new Headers({ apikey: 'canopy_pk_1', authorization: 'Bearer canopy_sk_123' })
    expect(() => credentialsFromHeaders(headers)).toThrow(UnauthorizedError)
  })

  it('rejects other schemes and empty bearer values', () => {
    for (const value of ['Basic dXNlcjpwYXNz', 'Bearer', 'Bearer ', 'Token abc', 'Bearer a b']) {
      expect(() => credentialsFromHeaders(new Headers({ authorization: value }))).toThrow(
        UnauthorizedError,
      )
    }
  })
})
