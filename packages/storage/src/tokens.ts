import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto"

/** What a signed URL grants: reading one path of one bucket until it expires. */
export interface SignedGrant {
  readonly bucket: string
  readonly path: string
  /** Milliseconds since the epoch. */
  readonly expiresAt: number
}

/**
 * Signs and checks the tokens of signed URLs: base64url JSON of the grant, a dot and its HMAC SHA-256. The
 * key is derived from the master key, so every server accepts the tokens of the others; without a master key
 * each process makes its own (development only).
 */
export class UrlSigner {
  private readonly key: Buffer

  constructor(masterKey: string | undefined) {
    this.key =
      masterKey === undefined
        ? randomBytes(32)
        : Buffer.from(hkdfSync("sha256", masterKey, "canopy", "canopy storage signed urls", 32))
  }

  /** A token for the grant. */
  sign(grant: SignedGrant): string {
    const payload = Buffer.from(
      JSON.stringify({ b: grant.bucket, p: grant.path, e: grant.expiresAt }),
    ).toString("base64url")
    return `${payload}.${this.mac(payload)}`
  }

  /** The grant of a valid, unexpired token, else `undefined`. */
  verify(token: string, now: number = Date.now()): SignedGrant | undefined {
    const [payload, mac, extra] = token.split(".")
    if (payload === undefined || mac === undefined || extra !== undefined) return undefined
    const expected = Buffer.from(this.mac(payload))
    const given = Buffer.from(mac)
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    } catch {
      return undefined
    }
    if (typeof parsed !== "object" || parsed === null) return undefined
    const { b, p, e } = parsed as Record<string, unknown>
    if (typeof b !== "string" || typeof p !== "string" || typeof e !== "number") return undefined
    if (e <= now) return undefined
    return { bucket: b, path: p, expiresAt: e }
  }

  private mac(payload: string): string {
    return createHmac("sha256", this.key).update(payload).digest("base64url")
  }
}
