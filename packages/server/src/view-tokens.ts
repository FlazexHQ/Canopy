import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
} from "node:crypto"
import {
  VIEW_TOKEN_AUDIENCE,
  VIEW_TOKEN_CLAIM,
  VIEW_TOKEN_ISSUER,
  type ViewTokenVerification,
} from "@canopy/auth"
import { SignJWT } from "jose"

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex")

/** Who a view token impersonates. `claims` is `null` for a role without a signed in user. */
export interface ViewIdentity {
  readonly roles: readonly string[]
  readonly claims: Readonly<Record<string, unknown>> | null
}

/**
 * Signs view tokens: short lived, read only tokens with which Studio follows data live as an impersonated
 * caller. The Ed25519 key is derived from the master key, so every node accepts tokens of every other
 * node; without a master key (development) each process makes its own.
 */
export class ViewTokens {
  private readonly privateKey: KeyObject
  private readonly publicKey: KeyObject

  constructor(masterKey: string | undefined) {
    this.privateKey =
      masterKey === undefined || masterKey === ""
        ? generateKeyPairSync("ed25519").privateKey
        : createPrivateKey({
            key: Buffer.concat([
              ED25519_PKCS8_PREFIX,
              Buffer.from(hkdfSync("sha256", masterKey, "canopy", "canopy view tokens v1", 32)),
            ]),
            format: "der",
            type: "pkcs8",
          })
    this.publicKey = createPublicKey(this.privateKey)
  }

  /** What an `Authenticator` needs to accept these tokens. */
  get verification(): ViewTokenVerification {
    return { key: this.publicKey }
  }

  /** Signs a token for `identity`, valid for `ttlSeconds`. */
  async mint(
    identity: ViewIdentity,
    ttlSeconds = 300,
  ): Promise<{ readonly token: string; readonly expiresAt: Date }> {
    const now = Math.floor(Date.now() / 1000)
    const sub = identity.claims?.["sub"]
    let jwt = new SignJWT({
      [VIEW_TOKEN_CLAIM]: { roles: [...identity.roles], claims: identity.claims },
    })
      .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
      .setIssuer(VIEW_TOKEN_ISSUER)
      .setAudience(VIEW_TOKEN_AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(now + ttlSeconds)
    if (typeof sub === "string") jwt = jwt.setSubject(sub)
    return {
      token: await jwt.sign(this.privateKey),
      expiresAt: new Date((now + ttlSeconds) * 1000),
    }
  }
}
