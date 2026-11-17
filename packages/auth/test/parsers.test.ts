import { CanopyError, ErrorCode, ValidationError } from "@canopy/protocol"
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT } from "jose"
import { describe, expect, it } from "vitest"
import { parseImportedPasswordHash, parseJsonWebKeySet } from "../src/index.ts"

function configError(run: () => unknown): CanopyError {
  try {
    run()
  } catch (error: unknown) {
    if (error instanceof CanopyError) return error
    throw error
  }
  throw new Error("expected a configuration error")
}

describe("parseJsonWebKeySet", () => {
  it("keeps the standard parameters of every key and verifies tokens with them", async () => {
    const pair = await generateKeyPair("ES256")
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }
    const parsed = parseJsonWebKeySet({ keys: [{ ...jwk, comment: "not a JWK parameter" }] })
    expect(parsed).toEqual({ keys: [jwk] })
    const token = await new SignJWT({ sub: "u1" })
      .setProtectedHeader({ alg: "ES256", kid: "k1" })
      .sign(pair.privateKey)
    const { payload } = await jwtVerify(token, createLocalJWKSet(parsed))
    expect(payload.sub).toBe("u1")
  })

  it("keeps the array and boolean parameters", () => {
    const key = {
      kty: "RSA",
      n: "AQAB",
      e: "AQAB",
      ext: true,
      key_ops: ["verify"],
      x5c: ["MIIB"],
      oth: [{ r: "a", d: "b", t: "c" }],
    }
    expect(parseJsonWebKeySet({ keys: [key] })).toEqual({ keys: [key] })
  })

  it.each([
    ["no object", "keys"],
    ["no keys array", {}],
    ["keys that are an object", { keys: { kty: "EC" } }],
    ["a key that is a string", { keys: ["k1"] }],
    ["a key without kty", { keys: [{ kid: "k1" }] }],
    ["a numeric kid", { keys: [{ kty: "EC", kid: 1 }] }],
    ["ext as a string", { keys: [{ kty: "EC", ext: "true" }] }],
    ["key_ops with a number", { keys: [{ kty: "EC", key_ops: ["verify", 1] }] }],
    ["oth that is not an array", { keys: [{ kty: "RSA", oth: {} }] }],
    ["an oth prime with a number", { keys: [{ kty: "RSA", oth: [{ r: 1 }] }] }],
  ])("refuses %s", (_label, value) => {
    expect(configError(() => parseJsonWebKeySet(value)).code).toBe(ErrorCode.ConfigInvalid)
  })
})

describe("parseImportedPasswordHash", () => {
  it("accepts every algorithm with its fields", () => {
    const hashes = [
      { algorithm: "bcrypt", hash: "$2b$10$abc" },
      { algorithm: "argon2id", hash: "$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA" },
      { algorithm: "pbkdf2-sha256", iterations: 310_000, salt: "c2FsdA==", hash: "aGFzaA==" },
      {
        algorithm: "firebase-scrypt",
        signerKey: "a2V5",
        saltSeparator: "",
        rounds: 8,
        memCost: 14,
        salt: "c2FsdA==",
        hash: "aGFzaA==",
      },
    ]
    for (const hash of hashes) expect(parseImportedPasswordHash(hash)).toEqual(hash)
  })

  it("drops fields the algorithm does not use", () => {
    expect(parseImportedPasswordHash({ algorithm: "bcrypt", hash: "h", salt: "extra" })).toEqual({
      algorithm: "bcrypt",
      hash: "h",
    })
  })

  it.each([
    ["not an object", "bcrypt:h", "must be an object"],
    [
      "an unknown algorithm",
      { algorithm: "md5", hash: "x" },
      'Unknown password hash algorithm "md5"',
    ],
    ["no algorithm", { hash: "x" }, "Unknown password hash algorithm undefined"],
    ["a numeric hash", { algorithm: "bcrypt", hash: 1 }, "needs hash"],
    ["an empty hash", { algorithm: "argon2id", hash: "" }, "needs hash"],
    [
      "iterations as a string",
      { algorithm: "pbkdf2-sha1", iterations: "1000", salt: "s", hash: "h" },
      "needs iterations",
    ],
    [
      "a missing signer key",
      {
        algorithm: "firebase-scrypt",
        saltSeparator: "",
        rounds: 8,
        memCost: 14,
        salt: "s",
        hash: "h",
      },
      "needs signerKey",
    ],
    [
      "fractional rounds",
      {
        algorithm: "firebase-scrypt",
        signerKey: "k",
        saltSeparator: "",
        rounds: 8.5,
        memCost: 14,
        salt: "s",
        hash: "h",
      },
      "needs rounds",
    ],
  ])("refuses %s", (_label, value, message) => {
    expect(() => parseImportedPasswordHash(value)).toThrow(ValidationError)
    expect(() => parseImportedPasswordHash(value)).toThrow(message)
  })
})
