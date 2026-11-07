import { createHash } from "node:crypto"
import { Role } from "@canopy/policy"
import { ErrorCode } from "@canopy/protocol"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { describe, expect, it } from "vitest"
import {
  type ApiKeyRecord,
  type ApiKeyStore,
  Authenticator,
  apiKeyDisplayPrefix,
  apiKeyKind,
  generateApiKey,
  hashApiKey,
} from "../src/index.ts"

describe("API key format", () => {
  it("generates prefixed keys of 32 base62 characters", () => {
    const keys = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const pk = generateApiKey("publishable")
      const sk = generateApiKey("secret")
      expect(pk).toMatch(/^canopy_pk_[0-9A-Za-z]{32}$/)
      expect(sk).toMatch(/^canopy_sk_[0-9A-Za-z]{32}$/)
      keys.add(pk)
      keys.add(sk)
    }
    expect(keys.size).toBe(400)
  })

  it("uses every base62 character with roughly even frequency", () => {
    const counts = new Map<string, number>()
    for (let i = 0; i < 2000; i++) {
      for (const char of generateApiKey("secret").slice(10)) {
        counts.set(char, (counts.get(char) ?? 0) + 1)
      }
    }
    expect(counts.size).toBe(62)
    const expected = (2000 * 32) / 62
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(expected * 0.8)
      expect(count).toBeLessThan(expected * 1.2)
    }
  })

  it("recognizes only well formed keys", () => {
    expect(apiKeyKind(`canopy_pk_${"a".repeat(32)}`)).toBe("publishable")
    expect(apiKeyKind(`canopy_sk_${"Z9".repeat(16)}`)).toBe("secret")
    for (const bad of [
      `canopy_sk_${"a".repeat(31)}`,
      `canopy_sk_${"a".repeat(33)}`,
      `canopy_sk_${"a".repeat(31)}-`,
      `canopy_xk_${"a".repeat(32)}`,
      ` canopy_pk_${"a".repeat(32)}`,
      "pk_server_test",
      "",
    ])
      expect(apiKeyKind(bad)).toBeUndefined()
  })

  it("hashes with SHA-256 and shows only an 8 character prefix", () => {
    const key = "canopy_sk_0123456789abcdefghijABCDEFGHIJkl"
    expect(hashApiKey(key)).toBe(`sha256:${createHash("sha256").update(key).digest("hex")}`)
    expect(apiKeyDisplayPrefix(key)).toBe("01234567")
    expect(() => apiKeyDisplayPrefix("nope")).toThrow(TypeError)
  })
})

class MemoryStore implements ApiKeyStore {
  readonly lookups: string[] = []
  readonly usedIds: string[] = []
  private readonly records: Map<string, ApiKeyRecord>
  constructor(records: Map<string, ApiKeyRecord>) {
    this.records = records
  }
  async find(key: string): Promise<ApiKeyRecord | undefined> {
    this.lookups.push(key)
    return this.records.get(hashApiKey(key))
  }
  used(record: ApiKeyRecord): void {
    this.usedIds.push(record.id)
  }
}

describe("Authenticator with a key store", () => {
  const secret = generateApiKey("secret")
  const publishable = generateApiKey("publishable")
  const revoked = generateApiKey("secret")
  const revokedPublishable = generateApiKey("publishable")
  const store = () =>
    new MemoryStore(
      new Map([
        [hashApiKey(secret), { id: "k_secret", kind: "secret", revoked: false }],
        [hashApiKey(publishable), { id: "k_pub", kind: "publishable", revoked: false }],
        [hashApiKey(revoked), { id: "k_rev", kind: "secret", revoked: true }],
        [hashApiKey(revokedPublishable), { id: "k_revpub", kind: "publishable", revoked: true }],
      ]),
    )

  it("maps a stored secret key to service and records its id", async () => {
    const keys = store()
    const auth = new Authenticator(undefined, { publishable: [], secret: [] }, { store: keys })
    const principal = await auth.authenticate(secret, undefined)
    expect([...principal.context.roles]).toEqual([Role.Service])
    expect(principal.keyId).toBe("k_secret")
    expect(keys.usedIds).toEqual(["k_secret"])
  })

  it("maps a stored publishable key to anon", async () => {
    const auth = new Authenticator(undefined, { publishable: [], secret: [] }, { store: store() })
    const principal = await auth.authenticate(publishable, undefined)
    expect([...principal.context.roles]).toEqual([Role.Anon])
    expect(principal.keyId).toBe("k_pub")
  })

  it("refuses revoked keys as forbidden, not as unknown", async () => {
    const auth = new Authenticator(undefined, { publishable: [], secret: [] }, { store: store() })
    for (const key of [revoked, revokedPublishable]) {
      await expect(auth.authenticate(key, undefined)).rejects.toMatchObject({
        code: ErrorCode.Forbidden,
      })
    }
  })

  it("refuses unknown keys and keeps the config keys working", async () => {
    const keys = store()
    const auth = new Authenticator(
      undefined,
      { publishable: ["pk_config"], secret: ["sk_config"] },
      { store: keys },
    )
    await expect(auth.authenticate(generateApiKey("publishable"), undefined)).rejects.toMatchObject(
      { code: ErrorCode.Unauthorized },
    )
    await expect(auth.authenticate(generateApiKey("secret"), undefined)).rejects.toMatchObject({
      code: ErrorCode.Unauthorized,
    })
    expect([...(await auth.authenticate("sk_config", undefined)).context.roles]).toEqual([
      Role.Service,
    ])
    const anon = await auth.authenticate("pk_config", undefined)
    expect([...anon.context.roles]).toEqual([Role.Anon])
    expect(anon.keyId).toBeUndefined()
    expect(keys.lookups).not.toContain("pk_config")
  })

  it("keeps the key id for user tokens sent with a stored publishable key", async () => {
    const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" })
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "EdDSA" }
    const auth = new Authenticator(
      { jwks: { keys: [jwk] }, issuer: "https://idp.test/" },
      { publishable: [] },
      { store: store() },
    )
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
      .setIssuer("https://idp.test/")
      .setSubject("alice")
      .setExpirationTime("5m")
      .sign(pair.privateKey)
    const principal = await auth.authenticate(publishable, token)
    expect(principal.subject).toBe("alice")
    expect(principal.keyId).toBe("k_pub")
    await expect(auth.authenticate(revokedPublishable, token)).rejects.toMatchObject({
      code: ErrorCode.Forbidden,
    })
  })
})
