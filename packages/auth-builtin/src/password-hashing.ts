import * as crypto from "node:crypto"
import { promisify } from "node:util"

const MEMORY_KIB = 19_456
const PASSES = 2
const LANES = 1
const TAG_LENGTH = 32
const PARAMETERS = `$argon2id$v=19$m=${MEMORY_KIB},t=${PASSES},p=${LANES}$`
const PHC =
  /^\$argon2id\$v=19\$m=([1-9]\d{0,5}),t=([1-9]\d?),p=([1-9]\d?)\$([A-Za-z0-9+/]{22,43})\$([A-Za-z0-9+/]{43})$/
const bunPassword = (
  globalThis as {
    Bun?: {
      password?: {
        hash(
          password: string,
          options: { algorithm: "argon2id"; memoryCost: number; timeCost: number },
        ): Promise<string>
        verify(password: string, hash: string): Promise<boolean>
      }
    }
  }
).Bun?.password
const nativeArgon2 = typeof crypto.argon2 === "function" ? promisify(crypto.argon2) : undefined

async function derive(
  message: string,
  nonce: Buffer<ArrayBuffer>,
  memory: number,
  passes: number,
  parallelism: number,
): Promise<Uint8Array> {
  if (nativeArgon2 !== undefined)
    return nativeArgon2("argon2id", {
      message,
      nonce,
      memory,
      passes,
      parallelism,
      tagLength: TAG_LENGTH,
    })
  const password = Buffer.from(message)
  let key: crypto.webcrypto.CryptoKey
  try {
    key = await crypto.webcrypto.subtle.importKey("raw", password, "Argon2id", false, [
      "deriveBits",
    ])
  } catch (error: unknown) {
    if (!(error instanceof DOMException) || error.name !== "NotSupportedError") throw error
    const { argon2idAsync } = await import("@noble/hashes/argon2.js")
    return argon2idAsync(password, nonce, {
      m: memory,
      t: passes,
      p: parallelism,
      dkLen: TAG_LENGTH,
    })
  }
  const parameters = { name: "Argon2id", nonce, memory, passes, parallelism }
  return new Uint8Array(await crypto.webcrypto.subtle.deriveBits(parameters, key, TAG_LENGTH * 8))
}

/** Creates an Argon2id PHC string with a fresh salt and the current work factors. */
export async function hashArgon2id(password: string): Promise<string> {
  const normalized = password.normalize("NFKC")
  if (bunPassword !== undefined && normalized.length > 0)
    return bunPassword.hash(normalized, {
      algorithm: "argon2id",
      memoryCost: MEMORY_KIB,
      timeCost: PASSES,
    })
  const salt = crypto.randomBytes(16)
  const hash = await derive(normalized, salt, MEMORY_KIB, PASSES, LANES)
  return `${PARAMETERS}${unpaddedBase64(salt)}$${unpaddedBase64(hash)}`
}

function unpaddedBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/=+$/, "")
}

/** Checks a Canopy Argon2id PHC string with bounded work factors and a constant time comparison. */
export async function verifyArgon2id(password: string, stored: string): Promise<boolean> {
  const match = PHC.exec(stored)
  if (match === null) return false
  const [, m, t, p, salt, tag] = match
  const memory = Number(m)
  const passes = Number(t)
  const parallelism = Number(p)
  if (
    salt === undefined ||
    tag === undefined ||
    memory < 8 * parallelism ||
    memory > 262_144 ||
    passes > 8 ||
    parallelism > 4
  )
    return false
  const nonce = Buffer.from(salt, "base64")
  const expected = Buffer.from(tag, "base64")
  if (
    nonce.length < 16 ||
    expected.length !== TAG_LENGTH ||
    unpaddedBase64(nonce) !== salt ||
    unpaddedBase64(expected) !== tag
  )
    return false
  const normalized = password.normalize("NFKC")
  if (bunPassword !== undefined && normalized.length > 0)
    return bunPassword.verify(normalized, stored)
  const actual = await derive(normalized, nonce, memory, passes, parallelism)
  return crypto.timingSafeEqual(actual, expected)
}

/** Identifies the prefix used for native Argon2id hashes. */
export function isArgon2idHash(stored: string): boolean {
  return stored.startsWith("$argon2id$")
}

/** Reports whether to upgrade a verified legacy hash or a weaker native hash. */
export function needsPasswordRehash(stored: string): boolean {
  const match = PHC.exec(stored)
  if (match === null) return true
  const [, m, t, p] = match
  return (
    Number(p) === LANES &&
    Number(m) <= MEMORY_KIB &&
    Number(t) <= PASSES &&
    (Number(m) < MEMORY_KIB || Number(t) < PASSES)
  )
}
