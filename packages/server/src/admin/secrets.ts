import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto"
import { CanopyError, ErrorCode } from "@canopy/protocol"

const VERSION = "v1"

function derive(masterKey: string): Buffer {
  return Buffer.from(hkdfSync("sha256", masterKey, "canopy", "canopy meta secrets v1", 32))
}

/**
 * Encrypts secrets stored in the meta database with AES-256-GCM under a key derived from the master key.
 * Without a master key (development only, the config refuses it in production) secrets are stored with a
 * `plain:` marker, so they can be encrypted once a master key is set. Secrets sealed with one of the
 * previous master keys still open, so a master key can be rotated without downtime: see
 * {@link SecretBox.isCurrent}.
 */
export class SecretBox {
  private readonly key: Buffer | undefined
  private readonly previous: readonly Buffer[]

  constructor(masterKey: string | undefined, previousMasterKeys: readonly string[] = []) {
    this.key = masterKey === undefined || masterKey === "" ? undefined : derive(masterKey)
    this.previous = previousMasterKeys.filter((key) => key !== "").map(derive)
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
    return this.unseal(sealed, context).plaintext
  }

  /**
   * Whether `sealed` is sealed with the current master key, or stays in plain text because there is none.
   * Anything else should be sealed again.
   */
  isCurrent(sealed: string, context: string): boolean {
    if (sealed.startsWith("plain:")) return this.key === undefined
    return this.unseal(sealed, context).current
  }

  private unseal(sealed: string, context: string): { plaintext: string; current: boolean } {
    if (sealed.startsWith("plain:")) return { plaintext: sealed.slice(6), current: true }
    const [version, iv, body] = sealed.split(".")
    const keys = this.key === undefined ? this.previous : [this.key, ...this.previous]
    if (version !== VERSION || iv === undefined || body === undefined || keys.length === 0)
      throw new CanopyError(
        ErrorCode.Internal,
        "A stored secret cannot be decrypted with this master key",
      )
    const bytes = Buffer.from(body, "base64url")
    let failure: unknown
    for (const key of keys) {
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"))
        decipher.setAAD(Buffer.from(context))
        decipher.setAuthTag(bytes.subarray(bytes.length - 16))
        const plaintext = Buffer.concat([
          decipher.update(bytes.subarray(0, bytes.length - 16)),
          decipher.final(),
        ]).toString("utf8")
        return { plaintext, current: key === this.key }
      } catch (error: unknown) {
        failure = error
      }
    }
    throw new CanopyError(
      ErrorCode.Internal,
      "A stored secret cannot be decrypted with this master key",
      { cause: failure },
    )
  }
}
