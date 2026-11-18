import { allow, auth, collection, createPolicySet } from "@canopy/policy"
import { MONGODB_URI } from "@canopy/testing"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type Canopy, createCanopy, defineConfig } from "../src/index.ts"

const ISSUER = "https://idp.storage.test/"
const AUDIENCE = "https://api.storage.test"
const KEY = "pk_storage_test"

const notes = collection("notes", {
  exposed: true,
  policies: [allow.read("authenticated").where({ ownerId: auth("sub") })],
})
const objects = collection("storage.objects", {
  exposed: true,
  policies: [
    allow.read("authenticated").where({ owner: auth("sub") }),
    allow.insert("authenticated").check({ bucket: "files", owner: auth("sub") }),
  ],
})

const suite = MONGODB_URI === undefined ? describe.skip : describe

suite("storage in the server", () => {
  const dbName = `canopy_server_storage_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let mongo: MongoClient
  let canopy: Canopy
  let plain: Canopy
  let token: string

  beforeAll(async () => {
    mongo = new MongoClient(MONGODB_URI ?? "")
    await mongo.connect()
    const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" })
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "EdDSA", use: "sig" }
    token = await new SignJWT({})
      .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject("alice")
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(pair.privateKey)
    const base = {
      auth: {
        kind: "external" as const,
        jwks: { keys: [jwk] },
        issuer: ISSUER,
        audience: AUDIENCE,
      },
      keys: { publishable: [KEY] },
      realtime: { checkpoints: "off" as const, drainWindow: "1s" },
    }
    canopy = await createCanopy(
      defineConfig({
        ...base,
        mongodb: { uri: MONGODB_URI ?? "", database: dbName, metaDatabase: `${dbName}_meta` },
        storage: {
          buckets: {
            files: { maxFileSize: 100 },
            logos: { public: true, allowedTypes: ["image/*"] },
          },
        },
      }),
      { env: {}, policies: createPolicySet([notes, objects]), onSetupToken: false },
    )
    plain = await createCanopy(
      defineConfig({
        ...base,
        mongodb: { uri: MONGODB_URI ?? "", database: `${dbName}_p`, metaDatabase: `${dbName}_pm` },
      }),
      { env: {}, policies: createPolicySet([notes]), onSetupToken: false },
    )
  })

  afterAll(async () => {
    await canopy.close()
    await plain.close()
    for (const name of [dbName, `${dbName}_meta`, `${dbName}_p`, `${dbName}_pm`])
      await mongo.db(name).dropDatabase()
    await mongo.close()
  })

  const request = (target: Canopy, method: string, path: string, body?: string, type?: string) =>
    target.fetch(
      new Request(`http://canopy.test${path}`, {
        method,
        headers: {
          apikey: KEY,
          authorization: `Bearer ${token}`,
          ...(type === undefined ? {} : { "content-type": type }),
        },
        ...(body === undefined ? {} : { body }),
      }),
    )

  it("stores and serves files under the storage.objects policies", async () => {
    const upload = await request(
      canopy,
      "POST",
      "/storage/v1/object/files/a.txt",
      "hello",
      "text/plain",
    )
    expect(upload.status).toBe(201)
    const read = await request(canopy, "GET", "/storage/v1/object/files/a.txt")
    expect(await read.text()).toBe("hello")
    expect(
      (
        await request(
          canopy,
          "POST",
          "/storage/v1/object/files/big.txt",
          "x".repeat(101),
          "text/plain",
        )
      ).status,
    ).toBe(413)
    expect(
      (await request(canopy, "POST", "/storage/v1/object/logos/a.png", "png", "image/png")).status,
    ).toBe(403)
    const stored = await mongo.db(`${dbName}_meta`).collection("storage_objects").findOne({})
    expect(stored).toMatchObject({ bucket: "files", path: "a.txt", owner: "alice", size: 5 })
    expect(await mongo.db(`${dbName}_meta`).collection("storage.files").countDocuments()).toBe(1)
    expect((await mongo.db(dbName).listCollections().toArray()).map((c) => c.name)).toEqual([])
  })

  it("never serves storage.objects as an app collection", async () => {
    const listed = (await (await request(canopy, "GET", "/rest/v1")).json()) as {
      data: { name: string }[]
    }
    expect(listed.data.map((c) => c.name)).toEqual(["notes"])
    expect((await request(canopy, "GET", "/rest/v1/storage.objects")).status).toBe(404)
  })

  it("answers 404 for storage when no bucket is configured", async () => {
    expect(plain.storage).toBeUndefined()
    expect((await request(plain, "GET", "/storage/v1/list/files")).status).toBe(404)
  })

  it("creates the storage collections and indexes in the meta database", async () => {
    const indexes = await mongo.db(`${dbName}_meta`).collection("storage_objects").indexes()
    expect(indexes.find((index) => index.name === "bucket_path")?.unique).toBe(true)
    expect(
      (await mongo.db(`${dbName}_meta`).listCollections({ name: "storage_uploads" }).toArray())
        .length,
    ).toBe(1)
  })
})
