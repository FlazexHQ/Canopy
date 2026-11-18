import { CanopyError, ErrorCode, isDocument } from "@canopy/protocol"
import type { JSONWebKeySet, JWK } from "jose"

const STRING_PARAMETERS = [
  "kty",
  "alg",
  "use",
  "x5t",
  "x5t#S256",
  "x5u",
  "kid",
  "crv",
  "d",
  "dp",
  "dq",
  "e",
  "k",
  "n",
  "p",
  "q",
  "qi",
  "x",
  "y",
  "pub",
  "priv",
] as const

function invalid(message: string): CanopyError {
  return new CanopyError(ErrorCode.ConfigInvalid, `auth.jwks: ${message}`)
}

function strings(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw invalid(`${where} must be an array of strings`)
  return value.filter((item): item is string => typeof item === "string")
}

function parseKey(value: unknown, index: number): JWK {
  const where = `keys[${index}]`
  if (!isDocument(value)) throw invalid(`${where} must be an object`)
  if (typeof value["kty"] !== "string") throw invalid(`${where}.kty must be a string`)
  const key: JWK = {}
  for (const name of STRING_PARAMETERS) {
    const item = value[name]
    if (item === undefined) continue
    if (typeof item !== "string") throw invalid(`${where}.${name} must be a string`)
    key[name] = item
  }
  const ext = value["ext"]
  if (ext !== undefined) {
    if (typeof ext !== "boolean") throw invalid(`${where}.ext must be a boolean`)
    key.ext = ext
  }
  if (value["key_ops"] !== undefined) key.key_ops = strings(value["key_ops"], `${where}.key_ops`)
  if (value["x5c"] !== undefined) key.x5c = strings(value["x5c"], `${where}.x5c`)
  const oth = value["oth"]
  if (oth !== undefined) {
    if (!Array.isArray(oth)) throw invalid(`${where}.oth must be an array`)
    key.oth = oth.map((prime, primeIndex) => {
      if (!isDocument(prime)) throw invalid(`${where}.oth[${primeIndex}] must be an object`)
      const out: { d?: string; r?: string; t?: string } = {}
      for (const name of ["d", "r", "t"] as const) {
        const item = prime[name]
        if (item === undefined) continue
        if (typeof item !== "string")
          throw invalid(`${where}.oth[${primeIndex}].${name} must be a string`)
        out[name] = item
      }
      return out
    })
  }
  return key
}

/**
 * Checks a JSON Web Key Set given inline (in the config file) and returns it with only the standard
 * parameters, each of the type RFC 7517 and RFC 7518 give it. Throws `CANOPY_CONFIG_INVALID` when the set
 * has no `keys` array or a key has a parameter of the wrong type.
 */
export function parseJsonWebKeySet(value: unknown): JSONWebKeySet {
  if (!isDocument(value) || !Array.isArray(value["keys"]))
    throw invalid("a key set needs a keys array")
  return { keys: value["keys"].map(parseKey) }
}
