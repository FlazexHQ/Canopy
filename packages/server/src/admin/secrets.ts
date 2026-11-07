import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto"
import { CanopyError, ErrorCode } from "@canopy/protocol"

const VERSION = "v1"

/**
 * Encrypts secrets stored in the meta database with AES-256-GCM under a key derived from the master key.
 * Without a master key (development only, the config refuses it in production) secrets are stored with a
 * `plain:` marker, so they can be encrypted once a master key is set.
 */
export class SecretBox {
  private readonly key: Buffer | undefined

  constructor(masterKey: string | undefined) {
    this.key =
      masterKey === undefined || masterKey === ""
        ? undefined
        : Buffer.from(hkdfSync("sha256", masterKey, "canopy", "canopy meta secrets v1", 32))
  }

  /** Whether secrets are encrypted. */
  get encrypting(): boolean {
    return this.key !== undefined
  }

  seal(plaintext: string, context: string): string {
    if (this.key === undefined) return `plain:${plaintext}`
    const iv = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", this.key, iv)
    cipher.setAAD(Buffer.from(context))
    const body = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ])
    return `${VERSION}.${iv.toString("base64url")}.${body.toString("base64url")}`
  }

  open(sealed: string, context: string): string {
    if (sealed.startsWith("plain:")) return sealed.slice(6)
    const [version, iv, body] = sealed.split(".")
    if (version !== VERSION || iv === undefined || body === undefined || this.key === undefined)
      throw new CanopyError(
        ErrorCode.Internal,
        "A stored secret cannot be decrypted with this master key",
      )
    const bytes = Buffer.from(body, "base64url")
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"))
      decipher.setAAD(Buffer.from(context))
      decipher.setAuthTag(bytes.subarray(bytes.length - 16))
      return Buffer.concat([
        decipher.update(bytes.subarray(0, bytes.length - 16)),
        decipher.final(),
      ]).toString("utf8")
    } catch (error: unknown) {
      throw new CanopyError(
        ErrorCode.Internal,
        "A stored secret cannot be decrypted with this master key",
        {
          cause: error,
        },
      )
    }
  }
}
