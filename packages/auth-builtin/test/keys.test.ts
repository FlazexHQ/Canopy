import { Authenticator } from "@canopy/auth"
import { decodeJwt, decodeProtectedHeader, exportJWK, generateKeyPair } from "jose"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, expect, it } from "vitest"
import {
  type KeyMaterial,
  KeyRing,
  type LeaseDocument,
  type SigningKeyDocument,
} from "../src/index.ts"
import {
  describeMongo,
  type Harness,
  MONGODB_URI,
  signUpVerified,
  startAuth,
  tokenFor,
} from "./support.ts"

async function mintEd25519(): Promise<KeyMaterial> {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", {
    crv: "Ed25519",
    extractable: true,
  })
  return {
    publicKey: JSON.stringify(await exportJWK(publicKey)),
    privateKey: JSON.stringify(await exportJWK(privateKey)),
    alg: "EdDSA",
    crv: "Ed25519",
  }
}

describeMongo("signing key rotation", () => {
  let h: Harness

  beforeAll(async () => {
    h = await startAuth()
  })
  afterAll(async () => {
    await h?.close()
  })

  it("lets a remote verifier that cached the JWKS before a rotation accept the next key at once", async () => {
    const client = h.client()
    await signUpVerified(h, client, "rot@example.com", "rotate password")
    const before = (await tokenFor(client)).token ?? ""
    const remote = new Authenticator({
      jwksUrl: `${h.url}/.well-known/jwks.json`,
      issuer: `${h.url}/auth/v1`,
      audience: h.url,
      algorithms: ["EdDSA"],
      rolesClaim: "roles",
    })
    await expect(remote.authenticate("", before)).resolves.toBeDefined()
    const published = (await (await fetch(`${h.url}/.well-known/jwks.json`)).json()) as {
      keys: { kid: string }[]
    }
    const standby = h.auth.keys.list().find((key) => key.state === "standby")?.kid
    expect(published.keys.map((key) => key.kid)).toContain(standby)
    await h.auth.keys.rotate()
    const after = (await tokenFor(client)).token ?? ""
    const oldKid = decodeProtectedHeader(before).kid
    expect(decodeProtectedHeader(after).kid).toBe(standby)
    expect(decodeProtectedHeader(after).kid).not.toBe(oldKid)
    await expect(remote.authenticate("", after)).resolves.toBeDefined()
    await expect(remote.authenticate("", before)).resolves.toBeDefined()
    await expect(h.auth.verifyAccessToken(before)).resolves.toBeDefined()
    const states = Object.fromEntries(h.auth.keys.list().map((key) => [key.kid, key.state]))
    expect(states[String(oldKid)]).toBe("retired")
    expect(Object.values(states).filter((state) => state === "standby")).toHaveLength(1)
  })

  it("revokes a key at once: it leaves the JWKS and its tokens stop verifying", async () => {
    const client = h.client()
    await signUpVerified(h, client, "rev@example.com", "revoke password")
    const token = (await tokenFor(client)).token ?? ""
    const kid = String(decodeProtectedHeader(token).kid)
    expect(await h.auth.keys.revoke(kid)).toBe(true)
    const jwks = (await (await fetch(`${h.url}/auth/v1/jwks`)).json()) as {
      keys: { kid: string }[]
    }
    expect(jwks.keys.map((key) => key.kid)).not.toContain(kid)
    await expect(h.auth.verifyAccessToken(token)).rejects.toMatchObject({
      code: "CANOPY_UNAUTHORIZED",
    })
    const fresh = (await tokenFor(client)).token ?? ""
    expect(decodeProtectedHeader(fresh).kid).not.toBe(kid)
    await expect(h.auth.verifyAccessToken(fresh)).resolves.toBeDefined()
    expect(await h.auth.keys.revoke(kid)).toBe(false)
    expect(h.auth.keys.list().filter((key) => key.state === "active")).toHaveLength(1)
  })

  it("signs with ES256 when configured, which an EdDSA pinned verifier refuses", async () => {
    const es = await startAuth(() => ({ algorithm: "ES256" }))
    try {
      const client = es.client()
      await signUpVerified(es, client, "es@example.com", "es256 password")
      const token = (await tokenFor(client)).token ?? ""
      expect(decodeProtectedHeader(token).alg).toBe("ES256")
      const options = {
        jwksUrl: `${es.url}/.well-known/jwks.json`,
        issuer: `${es.url}/auth/v1`,
        audience: es.url,
      }
      await expect(
        new Authenticator({ ...options, algorithms: ["ES256"] }).authenticate("", token),
      ).resolves.toBeDefined()
      await expect(
        new Authenticator({ ...options, algorithms: ["EdDSA"] }).authenticate("", token),
      ).rejects.toMatchObject({
        code: "CANOPY_UNAUTHORIZED",
      })
      expect(decodeJwt(token).iss).toBe(`${es.url}/auth/v1`)
    } finally {
      await es.close()
    }
  })
})

describeMongo("KeyRing", () => {
  let client: MongoClient
  const db = `t_keys_${process.pid}_${Math.floor(Math.random() * 1e9)}`
  let clock = Date.UTC(2026, 10, 7)

  beforeAll(async () => {
    client = new MongoClient(MONGODB_URI ?? "")
    await client.connect()
  })
  afterAll(async () => {
    await client?.db(db).dropDatabase()
    await client?.close()
  })

  const ring = (owner: string): KeyRing =>
    new KeyRing({
      keys: client.db(db).collection<SigningKeyDocument>("signing_keys"),
      leases: client.db(db).collection<LeaseDocument>("leases"),
      mint: mintEd25519,
      algorithm: "EdDSA",
      intervalMs: 60_000,
      graceMs: 30_000,
      owner,
      now: () => clock,
    })

  it("creates one active and one standby key when several nodes start at once", async () => {
    const nodes = [ring("a"), ring("b"), ring("c"), ring("d")]
    await Promise.all(nodes.map((node) => node.tick()))
    const keys = await client
      .db(db)
      .collection<SigningKeyDocument>("signing_keys")
      .find({})
      .toArray()
    expect(keys).toHaveLength(2)
    for (const node of nodes) await node.reload()
    const first = nodes[0]
    if (first === undefined) throw new Error("no node")
    expect(
      first
        .list()
        .map((key) => key.state)
        .sort(),
    ).toEqual(["active", "standby"])
    expect(first.signingKeys()).toHaveLength(1)
    expect(first.jwks().keys).toHaveLength(2)
    for (const node of nodes) await node.close()
  })

  it("hands over to the standby when the active key expires and keeps the old key for the grace period", async () => {
    const node = ring("a")
    await node.tick()
    const [active] = node.signingKeys()
    const standby = node.list().find((key) => key.state === "standby")
    clock = (active?.expiresAt.getTime() ?? 0) + 1
    await node.tick()
    expect(node.signingKeys().map((key) => key.id)).toEqual([standby?.kid])
    expect(node.list().filter((key) => key.state === "standby")).toHaveLength(1)
    expect(node.jwks().keys.map((key) => key.kid)).toContain(active?.id)
    clock += 30_000
    expect(node.jwks().keys.map((key) => key.kid)).not.toContain(active?.id)
    await node.close()
  })

  it("resolves only published keys and refuses an algorithm that does not match the key", async () => {
    const node = ring("a")
    await node.tick()
    const [active] = node.signingKeys()
    await expect(
      node.resolve({ alg: "EdDSA", kid: active?.id ?? "" }, {
        payload: "",
        signature: "",
      } as never),
    ).resolves.toBeDefined()
    await expect(
      node.resolve({ alg: "ES256", kid: active?.id ?? "" }, {
        payload: "",
        signature: "",
      } as never),
    ).rejects.toThrow()
    await expect(
      node.resolve({ alg: "EdDSA", kid: "unknown" }, { payload: "", signature: "" } as never),
    ).rejects.toThrow()
    await node.close()
  })
})
