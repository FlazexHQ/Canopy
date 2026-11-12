import { describe, expect, it } from "vitest"
import { encodeLegacyHash, isLegacyHash, verifyLegacyHash } from "../src/legacy-passwords.ts"

const hex = (value: string): string => Buffer.from(value, "hex").toString("base64")
const b64 = (value: string): string => Buffer.from(value).toString("base64")

describe("imported password hashes", () => {
  it("verifies bcrypt with the OpenWall test vector", async () => {
    const stored = encodeLegacyHash({
      algorithm: "bcrypt",
      hash: "$2a$05$CCCCCCCCCCCCCCCCCCCCC.E5YPO9kmyuRGyh0XouQYb4YMJKvyOeW",
    })
    expect(isLegacyHash(stored)).toBe(true)
    expect(await verifyLegacyHash(stored, "U*U")).toBe(true)
    expect(await verifyLegacyHash(stored, "U*V")).toBe(false)
  })

  it("verifies argon2id with the reference implementation's example", async () => {
    const stored = encodeLegacyHash({
      algorithm: "argon2id",
      hash: "$argon2id$v=19$m=65536,t=2,p=4$c29tZXNhbHQ$GpZ3sK/oH9p7VIiV56G/64Zo/8GaUw434IimaPqxwCo",
    })
    expect(await verifyLegacyHash(stored, "password")).toBe(true)
    expect(await verifyLegacyHash(stored, "Password")).toBe(false)
  })

  it("verifies PBKDF2 with the RFC 6070 and RFC 7914 vectors", async () => {
    const sha1 = encodeLegacyHash({
      algorithm: "pbkdf2-sha1",
      iterations: 4096,
      salt: b64("salt"),
      hash: hex("4b007901b765489abead49d926f721d065a429c1"),
    })
    expect(await verifyLegacyHash(sha1, "password")).toBe(true)
    expect(await verifyLegacyHash(sha1, "passwore")).toBe(false)
    const sha256 = encodeLegacyHash({
      algorithm: "pbkdf2-sha256",
      iterations: 1,
      salt: b64("salt"),
      hash: hex("55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc"),
    })
    expect(await verifyLegacyHash(sha256, "passwd")).toBe(true)
  })

  it("verifies Firebase's modified scrypt with the published example", async () => {
    const stored = encodeLegacyHash({
      algorithm: "firebase-scrypt",
      signerKey:
        "jxspr8Ki0RYycVU8zykbdLGjFQ3McFUH0uiiTvC8pVMXAn210wjLNmdZJzxUECKbm0QsEmYUSDzZvpjeJ9WmXA==",
      saltSeparator: "Bw==",
      rounds: 8,
      memCost: 14,
      salt: "42xEC+ixf3L2lw==",
      hash: "lSrfV15cpx95/sZS2W9c9Kp6i/LVgQNDNC/qzrCnh1SAyZvqmZqAjTdn3aoItz+VHjoZilo78198JAdRuid5lQ==",
    })
    expect(await verifyLegacyHash(stored, "user1password")).toBe(true)
    expect(await verifyLegacyHash(stored, "user2password")).toBe(false)
  })

  it("refuses malformed input when encoding and never matches a malformed stored value", async () => {
    expect(() => encodeLegacyHash({ algorithm: "bcrypt", hash: "plain" })).toThrow(/bcrypt/)
    expect(() => encodeLegacyHash({ algorithm: "argon2id", hash: "$argon2i$x" })).toThrow(/PHC/)
    expect(() =>
      encodeLegacyHash({ algorithm: "pbkdf2-sha256", iterations: 0, salt: "", hash: "" }),
    ).toThrow(/iterations/)
    expect(() =>
      encodeLegacyHash({
        algorithm: "firebase-scrypt",
        signerKey: "not base64!",
        saltSeparator: "",
        rounds: 8,
        memCost: 14,
        salt: "",
        hash: "",
      }),
    ).toThrow(/signerKey/)
    expect(await verifyLegacyHash("canopy-legacy$pbkdf2-sha256$1", "x")).toBe(false)
    expect(await verifyLegacyHash("canopy-legacy$md5$abc", "x")).toBe(false)
    expect(
      await verifyLegacyHash("$2a$05$CCCCCCCCCCCCCCCCCCCCC.E5YPO9kmyuRGyh0XouQYb4YMJKvyOeW", "U*U"),
    ).toBe(false)
  })
})
