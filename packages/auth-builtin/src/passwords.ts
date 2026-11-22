import { scrypt, timingSafeEqual } from "node:crypto"
import { promisify } from "node:util"
import { isLegacyHash, verifyLegacyHash } from "./legacy-passwords.ts"
import { isArgon2idHash, verifyArgon2id } from "./password-hashing.ts"

const deriveScrypt = promisify(scrypt) as (
  password: string,
  salt: string,
  keyLength: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>
const BETTER_AUTH_SCRYPT = /^([a-f0-9]{32}):([a-f0-9]{128})$/

/** Checks a Canopy, Better Auth, or imported password hash. */
export async function verifyAppPassword(password: string, stored: string): Promise<boolean> {
  if (isArgon2idHash(stored)) return verifyArgon2id(password, stored)
  if (isLegacyHash(stored)) return verifyLegacyHash(stored, password)
  const match = BETTER_AUTH_SCRYPT.exec(stored)
  if (match?.[1] === undefined || match[2] === undefined) return false
  const [, salt, tag] = match
  const actual = await deriveScrypt(password.normalize("NFKC"), salt, 64, {
    N: 16_384,
    r: 16,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  })
  return timingSafeEqual(actual, Buffer.from(tag, "hex"))
}
