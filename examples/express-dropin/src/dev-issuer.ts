import { randomUUID } from "node:crypto"
import { exportJWK, generateKeyPair, type JSONWebKeySet, SignJWT } from "jose"

/** A demo user of the development issuer. */
export interface DevUser {
  readonly id: string
  readonly name: string
  readonly roles: readonly string[]
}

/** The demo users: two customers and one support agent. */
export const DEV_USERS: readonly DevUser[] = [
  { id: "alice", name: "Alice", roles: [] },
  { id: "bob", name: "Bob", roles: [] },
  { id: "sam", name: "Sam (support)", roles: ["support"] },
]

/** A local stand in for Auth0: it publishes a JWKS and signs RS256 access tokens for the demo users. */
export interface DevIssuer {
  readonly jwks: JSONWebKeySet
  /** Signs a one hour access token, or returns `undefined` for an unknown user. */
  sign(userId: string): Promise<string | undefined>
}

/** Creates a development issuer with a fresh key pair. Never use it in production. */
export async function createDevIssuer(options: {
  readonly issuer: string
  readonly audience: string
  readonly rolesClaim: string
}): Promise<DevIssuer> {
  const kid = randomUUID()
  const { privateKey, publicKey } = await generateKeyPair("RS256")
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" }
  return {
    jwks: { keys: [jwk] },
    async sign(userId) {
      const user = DEV_USERS.find((candidate) => candidate.id === userId)
      if (user === undefined) return undefined
      return new SignJWT({ name: user.name, [options.rolesClaim]: [...user.roles] })
        .setProtectedHeader({ alg: "RS256", kid, typ: "at+jwt" })
        .setIssuer(options.issuer)
        .setAudience(options.audience)
        .setSubject(`dev|${user.id}`)
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(privateKey)
    },
  }
}
