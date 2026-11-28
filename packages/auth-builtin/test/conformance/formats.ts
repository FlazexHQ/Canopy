import { createHash, createHmac, timingSafeEqual } from "node:crypto"

const MASK = 0xffffffff

function rotate(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0
}

function quarter(state: Uint32Array, a: number, b: number, c: number, d: number): void {
  const at = (index: number): number => state[index] ?? 0
  state[a] = (at(a) + at(b)) & MASK
  state[d] = rotate(at(d) ^ at(a), 16)
  state[c] = (at(c) + at(d)) & MASK
  state[b] = rotate(at(b) ^ at(c), 12)
  state[a] = (at(a) + at(b)) & MASK
  state[d] = rotate(at(d) ^ at(a), 8)
  state[c] = (at(c) + at(d)) & MASK
  state[b] = rotate(at(b) ^ at(c), 7)
}

function rounds(state: Uint32Array): void {
  for (let round = 0; round < 10; round++) {
    quarter(state, 0, 4, 8, 12)
    quarter(state, 1, 5, 9, 13)
    quarter(state, 2, 6, 10, 14)
    quarter(state, 3, 7, 11, 15)
    quarter(state, 0, 5, 10, 15)
    quarter(state, 1, 6, 11, 12)
    quarter(state, 2, 7, 8, 13)
    quarter(state, 3, 4, 9, 14)
  }
}

const SIGMA = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]

function words(bytes: Uint8Array): number[] {
  const view = Buffer.from(bytes)
  return Array.from({ length: bytes.length / 4 }, (_, index) => view.readUInt32LE(index * 4))
}

/** The ChaCha20 block of RFC 8439 for a 32 byte key, a counter and a 12 byte nonce. */
function block(key: Uint8Array, counter: number, nonce: Uint8Array): Buffer {
  const initial = Uint32Array.from([...SIGMA, ...words(key), counter, ...words(nonce)])
  const state = Uint32Array.from(initial)
  rounds(state)
  const out = Buffer.alloc(64)
  for (let index = 0; index < 16; index++)
    out.writeUInt32LE(((state[index] ?? 0) + (initial[index] ?? 0)) >>> 0, index * 4)
  return out
}

/** HChaCha20: derives the XChaCha20 subkey from a key and the first 16 bytes of the nonce. */
function hchacha(key: Uint8Array, nonce: Uint8Array): Buffer {
  const state = Uint32Array.from([...SIGMA, ...words(key), ...words(nonce)])
  rounds(state)
  const out = Buffer.alloc(32)
  for (const [at, index] of [0, 1, 2, 3, 12, 13, 14, 15].entries())
    out.writeUInt32LE(state[index] ?? 0, at * 4)
  return out
}

function chacha(key: Uint8Array, nonce: Uint8Array, data: Uint8Array, counter: number): Buffer {
  const out = Buffer.alloc(data.length)
  for (let offset = 0; offset < data.length; offset += 64) {
    const stream = block(key, counter + offset / 64, nonce)
    for (let index = 0; index < 64 && offset + index < data.length; index++)
      out[offset + index] = (data[offset + index] ?? 0) ^ (stream[index] ?? 0)
  }
  return out
}

function littleEndian(bytes: Uint8Array): bigint {
  let value = 0n
  for (let index = bytes.length - 1; index >= 0; index--)
    value = (value << 8n) | BigInt(bytes[index] ?? 0)
  return value
}

/** Poly1305 of RFC 8439. */
function poly1305(key: Uint8Array, message: Uint8Array): Buffer {
  const r = littleEndian(key.subarray(0, 16)) & 0x0ffffffc0ffffffc0ffffffc0fffffffn
  const s = littleEndian(key.subarray(16, 32))
  const p = (1n << 130n) - 5n
  let accumulator = 0n
  for (let offset = 0; offset < message.length; offset += 16) {
    const chunk = message.subarray(offset, offset + 16)
    accumulator = ((accumulator + littleEndian(chunk) + (1n << BigInt(8 * chunk.length))) * r) % p
  }
  let tag = (accumulator + s) & ((1n << 128n) - 1n)
  const out = Buffer.alloc(16)
  for (let index = 0; index < 16; index++) {
    out[index] = Number(tag & 0xffn)
    tag >>= 8n
  }
  return out
}

function padded(bytes: Uint8Array): Buffer {
  const pad = (16 - (bytes.length % 16)) % 16
  return Buffer.concat([bytes, Buffer.alloc(pad)])
}

/**
 * Decrypts what Better Auth's `symmetricEncrypt` stores, written independently of Better Auth: the key is
 * SHA-256 of the secret's UTF-8 bytes; the value is hex of a 24 byte nonce, the XChaCha20 ciphertext and the
 * 16 byte Poly1305 tag, with no associated data. A `$ba$<version>$` envelope, written when the secret is a
 * versioned set, is accepted too. Throws when the tag does not match.
 */
export function decryptBetterAuth(secret: string, stored: string): string {
  const envelope = /^\$ba\$\d+\$(.*)$/.exec(stored)
  const bytes = Buffer.from(envelope?.[1] ?? stored, "hex")
  const key = createHash("sha256").update(secret, "utf8").digest()
  const nonce = bytes.subarray(0, 24)
  const ciphertext = bytes.subarray(24, bytes.length - 16)
  const tag = bytes.subarray(bytes.length - 16)
  const subkey = hchacha(key, nonce.subarray(0, 16))
  const chachaNonce = Buffer.concat([Buffer.alloc(4), nonce.subarray(16)])
  const polyKey = block(subkey, 0, chachaNonce).subarray(0, 32)
  const lengths = Buffer.alloc(16)
  lengths.writeBigUInt64LE(0n, 0)
  lengths.writeBigUInt64LE(BigInt(ciphertext.length), 8)
  const expected = poly1305(polyKey, Buffer.concat([padded(ciphertext), lengths]))
  if (!timingSafeEqual(expected, tag)) throw new Error("The Poly1305 tag does not match")
  return chacha(subkey, chachaNonce, ciphertext, 1).toString("utf8")
}

/** The session cookie value: the token, a dot and base64 (padded) HMAC-SHA256 of the token under the secret. */
export function signedCookieValue(secret: string, token: string): string {
  return `${token}.${createHmac("sha256", secret).update(token).digest("base64")}`
}
