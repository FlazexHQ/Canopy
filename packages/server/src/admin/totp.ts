import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

/** Encodes bytes as RFC 4648 base32 without padding, the form authenticator apps expect. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ""
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

/** Decodes base32, ignoring case, spaces and padding. Throws `TypeError` on other characters. */
export function base32Decode(text: string): Uint8Array {
  const clean = text.replace(/[\s=]/g, "").toUpperCase()
  const out: number[] = []
  let bits = 0
  let value = 0
  for (const char of clean) {
    const index = BASE32.indexOf(char)
    if (index < 0) throw new TypeError("Not a base32 string")
    value = ((value << 5) | index) & 0xffff
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Uint8Array.from(out)
}

/** The HMAC algorithms RFC 6238 defines. */
export type TotpAlgorithm = "sha1" | "sha256" | "sha512"

/** HOTP (RFC 4226): the one time password for a counter value. */
export function hotp(
  secret: Uint8Array,
  counter: number,
  options: { readonly digits?: number; readonly algorithm?: TotpAlgorithm } = {},
): string {
  const digits = options.digits ?? 6
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const mac = createHmac(options.algorithm ?? "sha1", secret)
    .update(message)
    .digest()
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f
  const binary = mac.readUInt32BE(offset) & 0x7fffffff
  return (binary % 10 ** digits).toString().padStart(digits, "0")
}

/** TOTP parameters. The defaults (30 s, 6 digits, SHA-1) are what authenticator apps use. */
export interface TotpOptions {
  readonly step?: number
  readonly digits?: number
  readonly algorithm?: TotpAlgorithm
}

/** The time step of a moment, in whole steps since the epoch. */
function totpStep(timeMs: number, step = 30): number {
  return Math.floor(timeMs / 1000 / step)
}

/** TOTP (RFC 6238): the one time password at a moment. */
export function totp(secret: Uint8Array, timeMs: number, options: TotpOptions = {}): string {
  return hotp(secret, totpStep(timeMs, options.step), options)
}

/**
 * Checks a code against the current step and one step either side (clock drift). Returns the matching step,
 * or `undefined`. Pass the last accepted step so a code can never be used twice.
 */
export function verifyTotp(
  secret: Uint8Array,
  code: string,
  timeMs: number,
  options: TotpOptions & { readonly window?: number; readonly lastStep?: number } = {},
): number | undefined {
  const digits = options.digits ?? 6
  if (!/^\d+$/.test(code) || code.length !== digits) return undefined
  const current = totpStep(timeMs, options.step)
  const window = options.window ?? 1
  let matched: number | undefined
  for (let step = current - window; step <= current + window; step++) {
    if (step < 0 || (options.lastStep !== undefined && step <= options.lastStep)) continue
    const expected = Buffer.from(hotp(secret, step, options))
    if (timingSafeEqual(expected, Buffer.from(code)) && matched === undefined) matched = step
  }
  return matched
}

/** A new random 160 bit secret, base32 encoded. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

/** The `otpauth://` URI authenticator apps scan as a QR code. */
export function totpUri(secret: string, account: string, issuer = "Canopy"): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
}
