import { createHash, createHmac } from "node:crypto"

type CryptoInput = string | Uint8Array

interface BunHasher {
  update(data: CryptoInput): BunHasher
  digest(): Uint8Array
}

const BunCryptoHasher = (
  globalThis as {
    Bun?: { CryptoHasher?: new (algorithm: string, key?: CryptoInput) => BunHasher }
  }
).Bun?.CryptoHasher

/** Returns the SHA-256 digest of UTF-8 text or bytes. */
export function sha256(data: string | Uint8Array): Buffer {
  if (BunCryptoHasher !== undefined)
    return Buffer.from(new BunCryptoHasher("sha256").update(data).digest())
  return createHash("sha256").update(data).digest()
}

/** Returns the HMAC SHA-256 digest of UTF-8 text or bytes. */
export function hmacSha256(key: string | Uint8Array, data: string | Uint8Array): Buffer {
  if (BunCryptoHasher !== undefined)
    return Buffer.from(new BunCryptoHasher("sha256", key).update(data).digest())
  return createHmac("sha256", key).update(data).digest()
}
