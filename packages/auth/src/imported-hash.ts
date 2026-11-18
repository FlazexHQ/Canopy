import { isDocument, ValidationError } from "@canopy/protocol"
import type { ImportedPasswordHash } from "./provider.ts"

const MAX_FIELD_LENGTH = 4096

function text(
  value: Record<string, unknown>,
  name: string,
  algorithm: string,
  allowEmpty = false,
): string {
  const item = value[name]
  if (
    typeof item !== "string" ||
    (item.length === 0 && !allowEmpty) ||
    item.length > MAX_FIELD_LENGTH
  )
    throw new ValidationError(`The ${algorithm} hash needs ${name} as a string`)
  return item
}

function count(value: Record<string, unknown>, name: string, algorithm: string): number {
  const item = value[name]
  if (typeof item !== "number" || !Number.isSafeInteger(item))
    throw new ValidationError(`The ${algorithm} hash needs ${name} as an integer`)
  return item
}

/**
 * Checks the shape of a password hash to import (from a request body or an export file): a known
 * `algorithm` and every field it needs, with its type. Throws `CANOPY_VALIDATION_FAILED` otherwise. The
 * values themselves (formats, work factors) are checked by the provider that stores them.
 */
export function parseImportedPasswordHash(value: unknown): ImportedPasswordHash {
  if (!isDocument(value)) throw new ValidationError("A password hash must be an object")
  const algorithm = value["algorithm"]
  switch (algorithm) {
    case "bcrypt":
    case "argon2id":
      return { algorithm, hash: text(value, "hash", algorithm) }
    case "pbkdf2-sha1":
    case "pbkdf2-sha256":
    case "pbkdf2-sha512":
      return {
        algorithm,
        iterations: count(value, "iterations", algorithm),
        salt: text(value, "salt", algorithm),
        hash: text(value, "hash", algorithm),
      }
    case "firebase-scrypt":
      return {
        algorithm,
        signerKey: text(value, "signerKey", algorithm),
        saltSeparator: text(value, "saltSeparator", algorithm, true),
        rounds: count(value, "rounds", algorithm),
        memCost: count(value, "memCost", algorithm),
        salt: text(value, "salt", algorithm),
        hash: text(value, "hash", algorithm),
      }
    default:
      throw new ValidationError(`Unknown password hash algorithm ${JSON.stringify(algorithm)}`)
  }
}
