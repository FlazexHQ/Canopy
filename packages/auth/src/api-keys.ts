import { sha256Hex } from "@canopy/protocol"

/** A publishable key maps to `anon`, a secret key to `service`. */
export type ApiKeyKind = "publishable" | "secret"

/** The prefix of each key kind. */
export const API_KEY_PREFIX: Readonly<Record<ApiKeyKind, string>> = {
  publishable: "canopy_pk_",
  secret: "canopy_sk_",
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
const KEY_PATTERN = /^canopy_(pk|sk)_[0-9A-Za-z]{32}$/
const RANDOM_LENGTH = 32
/** The number of random characters kept to identify a secret key in lists. */
export const API_KEY_DISPLAY_LENGTH = 8

function randomBase62(length: number): string {
  let out = ""
  const bytes = new Uint8Array(64)
  while (out.length < length) {
    globalThis.crypto.getRandomValues(bytes)
    for (const byte of bytes) {
      // 248 is the largest multiple of 62 below 256: rejecting the rest keeps every character equally likely.
      if (byte >= 248) continue
      out += BASE62[byte % 62]
      if (out.length === length) break
    }
  }
  return out
}

/** Generates a new key: the kind's prefix and 32 random base62 characters (about 190 bits). */
export function generateApiKey(kind: ApiKeyKind): string {
  return `${API_KEY_PREFIX[kind]}${randomBase62(RANDOM_LENGTH)}`
}

/** The kind of a well formed Canopy key, or `undefined` for anything else. */
export function apiKeyKind(value: string): ApiKeyKind | undefined {
  const match = KEY_PATTERN.exec(value)
  if (match === null) return undefined
  return match[1] === "pk" ? "publishable" : "secret"
}

/** The stored hash of a key. Secret keys are only ever stored in this form. */
export function hashApiKey(key: string): string {
  return `sha256:${sha256Hex(key)}`
}

/** The display prefix of a key: its first random characters, safe to show after creation. */
export function apiKeyDisplayPrefix(key: string): string {
  const kind = apiKeyKind(key)
  if (kind === undefined) throw new TypeError("Not a Canopy API key")
  const start = API_KEY_PREFIX[kind].length
  return key.slice(start, start + API_KEY_DISPLAY_LENGTH)
}

/** What a key store knows about a key. */
export interface ApiKeyRecord {
  readonly id: string
  readonly kind: ApiKeyKind
  /** A revoked key is refused with `CANOPY_FORBIDDEN`. */
  readonly revoked: boolean
}

/**
 * Where stored keys are looked up, for example `canopy.api_keys`. Keys from the config keep working next to
 * the stored ones.
 */
export interface ApiKeyStore {
  /** Looks a well formed key up. Implementations compare hashes, never plaintext secrets. */
  find(key: string): Promise<ApiKeyRecord | undefined>
  /** Told about every accepted request, so `lastUsedAt` can be sampled. Must not throw. */
  used?(record: ApiKeyRecord): void
}
