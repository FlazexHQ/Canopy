import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto"
import { ValidationError } from "@canopy/protocol"

/** scrypt cost parameters: N = 2^15, r = 8, p = 1 (about 32 MiB and tens of milliseconds per hash). */
const LOG_N = 15
const R = 8
const P = 1
const KEY_LENGTH = 32
const MAX_MEMORY = 64 * 1024 * 1024

/** The shortest accepted admin password. */
export const MIN_PASSWORD_LENGTH = 12
/** The longest accepted admin password, so hashing cost stays bounded. */
export const MAX_PASSWORD_LENGTH = 1024

function scrypt(
  password: string,
  salt: Buffer,
  logN: number,
  r: number,
  p: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password.normalize("NFKC"),
      salt,
      KEY_LENGTH,
      { N: 2 ** logN, r, p, maxmem: MAX_MEMORY },
      (error, key) => {
        if (error !== null) reject(error)
        else resolve(key)
      },
    )
  })
}

/** Refuses passwords that are too short or too long. */
export function checkPasswordStrength(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH)
    throw new ValidationError(`The password must have at least ${MIN_PASSWORD_LENGTH} characters`)
  if (password.length > MAX_PASSWORD_LENGTH)
    throw new ValidationError(`The password must have at most ${MAX_PASSWORD_LENGTH} characters`)
}

/** Hashes a password as `scrypt$<log2 N>$<r>$<p>$<salt>$<hash>` with a random 16 byte salt. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await scrypt(password, salt, LOG_N, R, P)
  return `scrypt$${LOG_N}$${R}$${P}$${salt.toString("base64url")}$${hash.toString("base64url")}`
}

/** Checks a password against a stored hash in constant time. Malformed hashes never match. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, logN, r, p, salt, hash, extra] = stored.split("$")
  if (kind !== "scrypt" || salt === undefined || hash === undefined || extra !== undefined)
    return false
  const n = Number(logN)
  const rounds = Number(r)
  const parallel = Number(p)
  if (
    ![n, rounds, parallel].every((value) => Number.isInteger(value) && value > 0) ||
    n > 16 ||
    rounds > 16 ||
    parallel > 4
  )
    return false
  if (password.length > MAX_PASSWORD_LENGTH) return false
  const expected = Buffer.from(hash, "base64url")
  if (expected.length !== KEY_LENGTH) return false
  try {
    const actual = await scrypt(password, Buffer.from(salt, "base64url"), n, rounds, parallel)
    return timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

/** A hash to verify against when the account does not exist, so the response time does not reveal it. */
export const DUMMY_PASSWORD_HASH = `scrypt$${LOG_N}$${R}$${P}$${Buffer.alloc(16).toString("base64url")}$${Buffer.alloc(KEY_LENGTH).toString("base64url")}`
