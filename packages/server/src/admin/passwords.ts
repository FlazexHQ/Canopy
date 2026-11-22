import { scrypt as scryptCallback, timingSafeEqual } from "node:crypto"
import { isArgon2idHash, verifyArgon2id } from "@canopy/auth-builtin/password-hashing"
import { ValidationError } from "@canopy/protocol"

export { hashArgon2id as hashPassword } from "@canopy/auth-builtin/password-hashing"

const KEY_LENGTH = 32
const MAX_MEMORY = 64 * 1024 * 1024

/** The shortest accepted admin password. */
const MIN_PASSWORD_LENGTH = 12
/** The longest accepted admin password, so hashing cost stays bounded. */
const MAX_PASSWORD_LENGTH = 1024

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
        if (error !== null && error !== undefined) reject(error)
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

/** Checks a password against a stored hash in constant time. Malformed hashes never match. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (password.length > MAX_PASSWORD_LENGTH) return false
  if (isArgon2idHash(stored)) return verifyArgon2id(password, stored)
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
export const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

const DUMMY_SCRYPT_HASH =
  "scrypt$15$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

/** Verifies the stored hash and runs the other format so their costs do not identify accounts. */
export async function verifyLoginPassword(password: string, stored: string): Promise<boolean> {
  const dummy = isArgon2idHash(stored) ? DUMMY_SCRYPT_HASH : DUMMY_PASSWORD_HASH
  const [matches] = await Promise.all([
    verifyPassword(password, stored),
    verifyPassword(password, dummy),
  ])
  return matches
}
