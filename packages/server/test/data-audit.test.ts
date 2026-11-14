import { allow, auth, collection, createPolicySet } from "@canopy/policy"
import { MONGODB_URI } from "@canopy/testing"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { MongoClient } from "mongodb"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { type Canopy, createCanopy, defineConfig } from "../src/index.ts"

const ISSUER = "https://idp.audit.test/"
const AUDIENCE = "https://api.audit.test"
const KEY = "pk_audit_test"

const todos = collection("todos", {
  exposed: true,
  realtime: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub") }),
    allow.insert("authenticated").check({ ownerId: auth("sub") }),
    allow.delete("authenticated").where({ ownerId: auth("sub") }),
  ],
})

const suite = MONGODB_URI === undefined ? describe.skip : describe

suite("audit of data plane writes", () => {
  const dbName = `canopy_server_audit_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  const metaName = `${dbName}_meta`
  let token: string
  let mongo: MongoClient
  const running: Canopy[] = []

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
    for (const dataWrites of [true, false])
      running.push(
        await createCanopy(
          defineConfig({
            mongodb: {
              uri: MONGODB_URI ?? "",
              database: `${dbName}_${dataWrites}`,
              metaDatabase: `${metaName}_${dataWrites}`,
            },
            auth: { kind: "external", jwks: { keys: [jwk] }, issuer: ISSUER, audience: AUDIENCE },
            keys: { publishable: [KEY] },
            realtime: { checkpoints: "off", drainWindow: "1s" },
            audit: { dataWrites },
          }),
          { env: {}, policies: createPolicySet([todos]), onSetupToken: false },
        ),
      )
  })

  afterEach(async () => {
    for (const dataWrites of [true, false])
      await mongo.db(`${metaName}_${dataWrites}`).collection("audit_log").deleteMany({})
  })

  afterAll(async () => {
    for (const canopy of running) await canopy.close()
    for (const dataWrites of [true, false]) {
      await mongo.db(`${dbName}_${dataWrites}`).dropDatabase()
      await mongo.db(`${metaName}_${dataWrites}`).dropDatabase()
    }
    await mongo.close()
  })

  const call = (canopy: Canopy, method: string, path: string, body?: unknown) =>
    canopy.fetch(
      new Request(`http://canopy.test/rest/v1/${path}`, {
        method,
        headers: {
          apikey: KEY,
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )

  /** The data entries of the audit log, waiting up to a second for `count` of them (they are written after the commit). */
  const entries = async (dataWrites: boolean, count = 0) => {
    const read = () =>
      mongo
        .db(`${metaName}_${dataWrites}`)
        .collection("audit_log")
        .find({ action: /^data\./ })
        .sort({ _id: 1 })
        .toArray()
    let found = await read()
    for (let attempt = 0; found.length < count && attempt < 50; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      found = await read()
    }
    return found
  }

  it("records who wrote what, without the document, when turned on", async () => {
    const [on] = running as [Canopy, Canopy]
    expect(
      (await call(on, "POST", "todos", { _id: "t1", ownerId: "alice", title: "secret" })).status,
    ).toBe(201)
    expect((await call(on, "DELETE", "todos/t1")).status).toBe(200)
    const found = await entries(true, 2)
    expect(found.map((entry) => entry["action"])).toEqual(["data.insert", "data.delete"])
    expect(found[0]).toMatchObject({
      actor: { type: "user", id: "alice" },
      outcome: "ok",
      target: { collection: "todos", ids: ["t1"] },
      details: { roles: ["authenticated"] },
    })
    expect(JSON.stringify(found)).not.toContain("secret")
  })

  it("records nothing by default, or for a refused write", async () => {
    const [on, off] = running as [Canopy, Canopy]
    expect((await call(off, "POST", "todos", { _id: "t2", ownerId: "alice" })).status).toBe(201)
    expect((await call(on, "POST", "todos", { _id: "t3", ownerId: "bob" })).status).toBe(403)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(await entries(false)).toEqual([])
    expect(await entries(true)).toEqual([])
  })
})
