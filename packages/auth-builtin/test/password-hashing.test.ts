import { describe, expect, it } from "vitest"
import { hashArgon2id, verifyArgon2id } from "../src/password-hashing.ts"
import { verifyAppPassword } from "../src/passwords.ts"

const PASSWORD = "portable password Ａ"

describe("portable password hashes", () => {
  it.each([
    [
      "Bun",
      "$argon2id$v=19$m=19456,t=2,p=1$gyy/avvOneSIo/ZxP5roGZota0hingqtTopXntGM22c$Y6Uk8gFwxvsHT+YlxxmVupiS+kaEmO6YzKkYWQTVg74",
    ],
    [
      "Node",
      "$argon2id$v=19$m=19456,t=2,p=1$ptbBlROwRyaY6jII6pA/ZQ$tMZT9UYjrCNSLuQjc3ySDq2J09Kk7rb2tLSka+9OIcQ",
    ],
    [
      "Deno",
      "$argon2id$v=19$m=19456,t=2,p=1$kvqvb1hp5+mmcAS3ymkdxw$i/yK8SDwasqT5P4ujbP/yUrfNn3l79Rd7IfNDcD2s3U",
    ],
  ])("verifies the fixed %s fixture", async (_, hash) => {
    expect(await verifyArgon2id(PASSWORD, hash)).toBe(true)
    expect(await verifyArgon2id("portable password B", hash)).toBe(false)
    expect(await verifyArgon2id(PASSWORD, hash.replace("m=19456", "m=999999"))).toBe(false)
  })

  it("encodes the current work factors and verifies freshly generated hashes", async () => {
    const hash = await hashArgon2id(PASSWORD)
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/)
    expect(await verifyArgon2id("portable password A", hash)).toBe(true)
    expect(await hashArgon2id(PASSWORD)).not.toBe(hash)
    expect(await verifyArgon2id("", await hashArgon2id(""))).toBe(true)
  })

  it("verifies an old Better Auth scrypt hash using the original hex text salt and normalization", async () => {
    const hash =
      "000102030405060708090a0b0c0d0e0f:dcc1061d3ddfbc4eb469e4e827729e691ad9af8ab43c62beb4d7ec9c7a7fd29798e1a594f9e8af0b10c8731755a0ef91c99c0f78630e03c118a12a79bab446cf"
    expect(await verifyAppPassword("correct horse Ａattery", hash)).toBe(true)
    expect(await verifyAppPassword("correct horse Battery", hash)).toBe(false)
  })
})
