import { describe, expect, it } from "vitest"
import {
  checkPasswordStrength,
  DUMMY_PASSWORD_HASH,
  hashPassword,
  verifyPassword,
} from "../src/admin/passwords.ts"
import { lockoutMs, RateLimiter } from "../src/admin/rate-limit.ts"
import { ADMIN_ROLES, type AdminRole, can, type Permission } from "../src/admin/rbac.ts"
import { SecretBox } from "../src/admin/secrets.ts"
import {
  base32Decode,
  base32Encode,
  hotp,
  type TotpAlgorithm,
  totp,
  totpUri,
  verifyTotp,
} from "../src/admin/totp.ts"

const ascii = (text: string) => new TextEncoder().encode(text)

describe("HOTP and TOTP", () => {
  it("matches the HOTP test vectors of RFC 4226 appendix D", () => {
    const secret = ascii("12345678901234567890")
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((counter) => hotp(secret, counter))).toEqual([
      "755224",
      "287082",
      "359152",
      "969429",
      "338314",
      "254676",
      "287922",
      "162583",
      "399871",
      "520489",
    ])
  })

  it("matches the TOTP test vectors of RFC 6238 appendix B", () => {
    const secrets: Record<TotpAlgorithm, Uint8Array> = {
      sha1: ascii("12345678901234567890"),
      sha256: ascii("12345678901234567890123456789012"),
      sha512: ascii("1234567890123456789012345678901234567890123456789012345678901234"),
    }
    const vectors: [number, TotpAlgorithm, string][] = [
      [59, "sha1", "94287082"],
      [59, "sha256", "46119246"],
      [59, "sha512", "90693936"],
      [1111111109, "sha1", "07081804"],
      [1111111109, "sha256", "68084774"],
      [1111111109, "sha512", "25091201"],
      [1111111111, "sha1", "14050471"],
      [1111111111, "sha256", "67062674"],
      [1111111111, "sha512", "99943326"],
      [1234567890, "sha1", "89005924"],
      [1234567890, "sha256", "91819424"],
      [1234567890, "sha512", "93441116"],
      [2000000000, "sha1", "69279037"],
      [2000000000, "sha256", "90698825"],
      [2000000000, "sha512", "38618901"],
      [20000000000, "sha1", "65353130"],
      [20000000000, "sha256", "77737706"],
      [20000000000, "sha512", "47863826"],
    ]
    for (const [seconds, algorithm, code] of vectors) {
      expect(totp(secrets[algorithm], seconds * 1000, { digits: 8, algorithm })).toBe(code)
    }
  })

  it("accepts one step of drift, refuses more, and never accepts a step twice", () => {
    const secret = ascii("12345678901234567890")
    const now = 1_111_111_111_000
    const code = totp(secret, now)
    expect(verifyTotp(secret, code, now)).toBe(Math.floor(now / 30_000))
    expect(verifyTotp(secret, code, now + 30_000)).toBe(Math.floor(now / 30_000))
    expect(verifyTotp(secret, code, now - 30_000)).toBe(Math.floor(now / 30_000))
    expect(verifyTotp(secret, code, now + 60_000)).toBeUndefined()
    const step = Math.floor(now / 30_000)
    expect(verifyTotp(secret, code, now, { lastStep: step })).toBeUndefined()
    expect(verifyTotp(secret, code, now, { lastStep: step - 1 })).toBe(step)
    for (const bad of ["", "12345", "1234567", "abcdef", ` ${code.slice(1)}`])
      expect(verifyTotp(secret, bad, now)).toBeUndefined()
  })

  it("round trips base32 and matches RFC 4648 test vectors", () => {
    const vectors: [string, string][] = [
      ["", ""],
      ["f", "MY"],
      ["fo", "MZXQ"],
      ["foo", "MZXW6"],
      ["foob", "MZXW6YQ"],
      ["fooba", "MZXW6YTB"],
      ["foobar", "MZXW6YTBOI"],
    ]
    for (const [plain, encoded] of vectors) {
      expect(base32Encode(ascii(plain))).toBe(encoded)
      expect(new TextDecoder().decode(base32Decode(`${encoded.toLowerCase()}===`))).toBe(plain)
    }
    expect(() => base32Decode("MZ1")).toThrow(TypeError)
    expect(totpUri("ABC", "a@b.c")).toBe(
      "otpauth://totp/Canopy:a%40b.c?secret=ABC&issuer=Canopy&algorithm=SHA1&digits=6&period=30",
    )
  })
})

describe("admin passwords", () => {
  it("hashes with scrypt and a random salt, and verifies only the right password", async () => {
    const first = await hashPassword("correct horse battery")
    const second = await hashPassword("correct horse battery")
    expect(first).toMatch(/^scrypt\$15\$8\$1\$[\w-]{22}\$[\w-]{43}$/)
    expect(first).not.toBe(second)
    expect(await verifyPassword("correct horse battery", first)).toBe(true)
    expect(await verifyPassword("correct horse batterY", first)).toBe(false)
    expect(await verifyPassword("", first)).toBe(false)
  })

  it("never matches malformed or hostile hashes", async () => {
    for (const stored of [
      "",
      "plain$secret",
      "scrypt$15$8$1$salt",
      "scrypt$30$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "scrypt$15$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAA",
      `${DUMMY_PASSWORD_HASH}$extra`,
    ])
      expect(await verifyPassword("anything at all", stored)).toBe(false)
    expect(await verifyPassword("anything at all", DUMMY_PASSWORD_HASH)).toBe(false)
  })

  it("refuses short and huge passwords", () => {
    expect(() => checkPasswordStrength("short")).toThrow(/at least 12/)
    expect(() => checkPasswordStrength("x".repeat(1025))).toThrow(/at most 1024/)
    expect(() => checkPasswordStrength("twelve chars")).not.toThrow()
  })
})

describe("RBAC", () => {
  const all: Permission[] = [
    "session",
    "collections.read",
    "collections.write",
    "documents.read",
    "documents.write",
    "documents.viewAs",
    "documents.writeAs",
    "policies.read",
    "policies.simulate",
    "policies.publish",
    "keys.read",
    "keys.publishable",
    "keys.secret",
    "realtime.stats",
    "realtime.inspect",
    "ops.doctor",
    "ops.audit",
    "settings.read",
    "settings.write",
    "admins.read",
    "admins.manage",
    "admins.manageOwners",
  ]
  const granted = (role: AdminRole, environment: "development" | "production") =>
    all.filter((permission) => can(role, permission, environment))

  it("gives owners everything and admins everything but managing owners, in every environment", () => {
    for (const environment of ["development", "production"] as const) {
      expect(granted("owner", environment)).toEqual(all)
      expect(granted("admin", environment)).toEqual(
        all.filter((permission) => permission !== "admins.manageOwners"),
      )
    }
  })

  it("lets developers publish and edit data only outside production, and never touch secret keys", () => {
    expect(granted("developer", "development")).toEqual([
      "session",
      "collections.read",
      "collections.write",
      "documents.read",
      "documents.write",
      "documents.viewAs",
      "documents.writeAs",
      "policies.read",
      "policies.simulate",
      "policies.publish",
      "keys.read",
      "keys.publishable",
      "realtime.stats",
      "realtime.inspect",
      "ops.doctor",
    ])
    expect(granted("developer", "production")).toEqual([
      "session",
      "collections.read",
      "documents.read",
      "documents.viewAs",
      "policies.read",
      "policies.simulate",
      "keys.read",
      "keys.publishable",
      "realtime.stats",
      "realtime.inspect",
      "ops.doctor",
    ])
  })

  it("keeps viewers read only", () => {
    for (const environment of ["development", "production"] as const)
      expect(granted("viewer", environment)).toEqual([
        "session",
        "collections.read",
        "documents.read",
        "policies.read",
        "realtime.stats",
        "ops.doctor",
      ])
  })

  it("denies unknown roles", () => {
    expect(ADMIN_ROLES).toEqual(["owner", "admin", "developer", "viewer"])
    expect(can("root" as AdminRole, "session", "development")).toBe(false)
  })
})

describe("rate limits and lockout", () => {
  it("allows the limit per window, then reports the wait", () => {
    let now = 0
    const limiter = new RateLimiter({ limit: 3, windowMs: 1000, now: () => now })
    expect([1, 2, 3].map(() => limiter.hit("a"))).toEqual([0, 0, 0])
    now = 400
    expect(limiter.hit("a")).toBe(600)
    expect(limiter.hit("b")).toBe(0)
    now = 1000
    expect(limiter.hit("a")).toBe(0)
    limiter.reset("a")
  })

  it("stays bounded in memory", () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 10 })
    for (let i = 0; i < 1000; i++) limiter.hit(`k${i}`)
    expect(
      (limiter as unknown as { windows: Map<string, unknown> }).windows.size,
    ).toBeLessThanOrEqual(10)
  })

  it("locks accounts for a doubling delay after five failures, capped at 15 minutes", () => {
    expect([0, 4, 5, 6, 7, 10, 40].map((failures) => lockoutMs(failures))).toEqual([
      0, 0, 1000, 2000, 4000, 32_000, 900_000,
    ])
  })
})

describe("secret box", () => {
  it("encrypts with the master key and refuses another key or context", () => {
    const box = new SecretBox("a".repeat(44))
    const sealed = box.seal("JBSWY3DPEHPK3PXP", "totp:a@b.c")
    expect(sealed).toMatch(/^v1\./)
    expect(sealed).not.toContain("JBSWY3DPEHPK3PXP")
    expect(box.open(sealed, "totp:a@b.c")).toBe("JBSWY3DPEHPK3PXP")
    expect(() => box.open(sealed, "totp:x@b.c")).toThrow(/cannot be decrypted/)
    expect(() => new SecretBox("b".repeat(44)).open(sealed, "totp:a@b.c")).toThrow(
      /cannot be decrypted/,
    )
    expect(() => new SecretBox(undefined).open(sealed, "totp:a@b.c")).toThrow(/cannot be decrypted/)
  })

  it("marks secrets stored without a master key", () => {
    const box = new SecretBox(undefined)
    expect(box.encrypting).toBe(false)
    expect(box.seal("s", "c")).toBe("plain:s")
    expect(new SecretBox("k").open("plain:s", "c")).toBe("s")
  })
})
