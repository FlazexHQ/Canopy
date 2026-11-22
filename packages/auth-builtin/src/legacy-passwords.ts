import { createCipheriv, pbkdf2, scrypt, timingSafeEqual } from "node:crypto"
import { promisify } from "node:util"
import type { ImportedPasswordHash } from "@canopy/auth"
import { ValidationError } from "@canopy/protocol"
import { argon2id, bcryptVerify } from "hash-wasm"

const pbkdf2Async = promisify(pbkdf2)
const scryptAsync = promisify(scrypt) as (
  password: Buffer | string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>

/** The prefix that marks a stored password hash as imported from another system. */
const LEGACY_PREFIX = "canopy-legacy$"

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

function base64(value: string, name: string): Buffer {
  if (!BASE64.test(value)) throw new ValidationError(`${name} is not base64`)
  return Buffer.from(value, "base64")
}

function count(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new ValidationError(`${name} must be an integer from ${min} to ${max}`)
  return value
}

const MAX_BCRYPT_COST = 16
const MAX_SCRYPT_ROUNDS = 16
const MAX_SCRYPT_MEM_COST = 16
const MAX_ARGON2_MEMORY_KIB = 262_144
const MAX_ARGON2_PASSES = 32
const MAX_ARGON2_LANES = 16

function argon2Parameter(hash: string, name: "m" | "t" | "p"): number {
  return Number(new RegExp(`[$,]${name}=(\\d+)`).exec(hash)?.[1])
}

function checkArgon2(hash: string): void {
  const memory = argon2Parameter(hash, "m")
  const passes = argon2Parameter(hash, "t")
  const lanes = argon2Parameter(hash, "p")
  if (!(memory >= 8 && memory <= MAX_ARGON2_MEMORY_KIB))
    throw new ValidationError(`The argon2id memory must be from 8 to ${MAX_ARGON2_MEMORY_KIB} KiB`)
  if (!(passes >= 1 && passes <= MAX_ARGON2_PASSES))
    throw new ValidationError(`The argon2id passes must be from 1 to ${MAX_ARGON2_PASSES}`)
  if (!(lanes >= 1 && lanes <= MAX_ARGON2_LANES))
    throw new ValidationError(`The argon2id lanes must be from 1 to ${MAX_ARGON2_LANES}`)
}

/** Checks a legacy hash and turns it into the form stored in the `password` field of the account. */
export function encodeLegacyHash(legacy: ImportedPasswordHash): string {
  switch (legacy.algorithm) {
    case "bcrypt":
      if (!/^\$2[abxy]?\$\d{2}\$[./A-Za-z0-9]{53}$/.test(legacy.hash))
        throw new ValidationError("The bcrypt hash is not in the $2b$ format")
      if (Number(legacy.hash.split("$")[2]) > MAX_BCRYPT_COST)
        throw new ValidationError(`The bcrypt cost may not exceed ${MAX_BCRYPT_COST}`)
      return `${LEGACY_PREFIX}bcrypt$${legacy.hash}`
    case "argon2id":
      if (!legacy.hash.startsWith("$argon2id$"))
        throw new ValidationError("The argon2id hash is not in the PHC format")
      checkArgon2(legacy.hash)
      return `${LEGACY_PREFIX}argon2id$${legacy.hash}`
    case "pbkdf2-sha1":
    case "pbkdf2-sha256":
    case "pbkdf2-sha512":
      count(legacy.iterations, "iterations", 1, 10_000_000)
      base64(legacy.salt, "salt")
      base64(legacy.hash, "hash")
      return `${LEGACY_PREFIX}${legacy.algorithm}$${legacy.iterations}$${legacy.salt}$${legacy.hash}`
    case "firebase-scrypt":
      base64(legacy.signerKey, "signerKey")
      base64(legacy.saltSeparator, "saltSeparator")
      count(legacy.rounds, "rounds", 1, MAX_SCRYPT_ROUNDS)
      count(legacy.memCost, "memCost", 1, MAX_SCRYPT_MEM_COST)
      base64(legacy.salt, "salt")
      base64(legacy.hash, "hash")
      return [
        `${LEGACY_PREFIX}firebase-scrypt`,
        legacy.signerKey,
        legacy.saltSeparator,
        legacy.rounds,
        legacy.memCost,
        legacy.salt,
        legacy.hash,
      ].join("$")
    default:
      throw new ValidationError(
        `Unknown password hash algorithm ${JSON.stringify((legacy as { algorithm?: unknown }).algorithm)}`,
      )
  }
}

/** Whether a stored password hash was imported and is checked by {@link verifyLegacyHash}. */
export function isLegacyHash(stored: string): boolean {
  return stored.startsWith(LEGACY_PREFIX)
}

function equal(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}

async function verifyImportedArgon2id(stored: string, password: string): Promise<boolean> {
  const match =
    /^\$argon2id\$v=19\$(?:[mtp]=\d+,){2}[mtp]=\d+\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(
      stored,
    )
  if (match?.[1] === undefined || match[2] === undefined) return false
  checkArgon2(stored)
  const tag = Buffer.from(match[2], "base64")
  if (tag.toString("base64").replace(/=+$/, "") !== match[2]) return false
  const derived = await argon2id({
    password,
    salt: Buffer.from(match[1], "base64"),
    memorySize: argon2Parameter(stored, "m"),
    iterations: argon2Parameter(stored, "t"),
    parallelism: argon2Parameter(stored, "p"),
    hashLength: tag.length,
    outputType: "binary",
  })
  return equal(Buffer.from(derived), tag)
}

/**
 * Checks a password against an imported hash. bcrypt and argon2id use their encoded parameters; PBKDF2
 * uses the given digest and iterations; Firebase's modified scrypt derives a key with scrypt over the salt
 * and the project's salt separator, encrypts the project's signer key with AES-256-CTR and a zero IV, and
 * compares the result. A malformed stored value never matches.
 */
export async function verifyLegacyHash(stored: string, password: string): Promise<boolean> {
  if (!isLegacyHash(stored)) return false
  const body = stored.slice(LEGACY_PREFIX.length)
  const algorithm = body.slice(0, body.indexOf("$"))
  const rest = body.slice(algorithm.length + 1)
  const parts = rest.split("$")
  try {
    switch (algorithm) {
      case "bcrypt":
        return await bcryptVerify({ password, hash: rest })
      case "argon2id":
        return await verifyImportedArgon2id(rest, password)
      case "pbkdf2-sha1":
      case "pbkdf2-sha256":
      case "pbkdf2-sha512": {
        const [iterations, salt, hash] = parts
        if (iterations === undefined || salt === undefined || hash === undefined) return false
        const expected = Buffer.from(hash, "base64")
        const digest = algorithm.slice("pbkdf2-".length)
        const derived = await pbkdf2Async(
          password,
          Buffer.from(salt, "base64"),
          Number(iterations),
          expected.length,
          digest,
        )
        return equal(derived, expected)
      }
      case "firebase-scrypt": {
        const [signerKey, separator, rounds, memCost, salt, hash] = parts
        if (
          signerKey === undefined ||
          separator === undefined ||
          rounds === undefined ||
          memCost === undefined ||
          salt === undefined ||
          hash === undefined
        )
          return false
        const N = 2 ** Number(memCost)
        const r = Number(rounds)
        const key = await scryptAsync(
          password,
          Buffer.concat([Buffer.from(salt, "base64"), Buffer.from(separator, "base64")]),
          32,
          { N, r, p: 1, maxmem: 256 * N * r + 1024 * 1024 },
        )
        const cipher = createCipheriv("aes-256-ctr", key, Buffer.alloc(16))
        const derived = Buffer.concat([
          cipher.update(Buffer.from(signerKey, "base64")),
          cipher.final(),
        ])
        return equal(derived, Buffer.from(hash, "base64"))
      }
      default:
        return false
    }
  } catch {
    return false
  }
}
