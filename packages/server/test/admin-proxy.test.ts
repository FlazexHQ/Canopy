import { MONGODB_URI } from "@canopy/testing"
import { type Db, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type Canopy, createCanopy, defineConfig } from "../src/index.ts"

const suite = MONGODB_URI === undefined ? describe.skip : describe

suite("admin IP allowlist behind a trusted proxy", () => {
  const dbName = `canopy_admin_proxy_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let mongo: MongoClient
  let meta: Db
  let canopy: Canopy

  const setup = (peer: string, forwardedFor?: string): Promise<Response> =>
    canopy.fetch(
      new Request("http://canopy.test/admin/v1/setup", {
        headers: forwardedFor === undefined ? {} : { "x-forwarded-for": forwardedFor },
      }),
      undefined,
      { ip: peer },
    )

  beforeAll(async () => {
    mongo = new MongoClient(MONGODB_URI ?? "")
    await mongo.connect()
    meta = mongo.db(`${dbName}_meta`)
    canopy = await createCanopy(
      defineConfig({
        mongodb: { uri: MONGODB_URI ?? "", database: dbName, metaDatabase: `${dbName}_meta` },
        keys: { publishable: ["pk_proxy_test"] },
        realtime: false,
        server: { trustedProxies: ["10.0.0.0/8", "fd00::/8"] },
      }),
      { env: {}, onSetupToken: () => {} },
    )
    await meta
      .collection<{ _id: string; adminAllowlist: string[] }>("settings")
      .updateOne(
        { _id: "settings" },
        { $set: { adminAllowlist: ["203.0.113.0/24"] } },
        { upsert: true },
      )
    await canopy.admin.settings.refresh()
  })

  afterAll(async () => {
    await canopy.close()
    await mongo.db(dbName).dropDatabase()
    await meta.dropDatabase()
    await mongo.close()
  })

  it("checks the client address a trusted proxy forwards", async () => {
    expect((await setup("10.0.0.1", "203.0.113.5")).status).toBe(200)
    expect((await setup("fd00::1", "203.0.113.5")).status).toBe(200)
    expect((await setup("10.0.0.1", "203.0.113.5, 10.0.0.7")).status).toBe(200)
    expect((await setup("10.0.0.1", "198.51.100.1")).status).toBe(403)
    expect((await setup("10.0.0.1")).status).toBe(403)
  })

  it("ignores a spoofed X-Forwarded-For from an untrusted peer", async () => {
    const spoofed = await setup("198.51.100.9", "203.0.113.5")
    expect(spoofed.status).toBe(403)
    expect(await spoofed.json()).toMatchObject({ code: "CANOPY_FORBIDDEN" })
    expect((await setup("::ffff:198.51.100.9", "203.0.113.5")).status).toBe(403)
    expect((await setup("fe00::1", "203.0.113.5")).status).toBe(403)
  })

  it("ignores hops a client prepends before the address the proxy saw", async () => {
    expect((await setup("10.0.0.1", "203.0.113.5, 198.51.100.1")).status).toBe(403)
    expect((await setup("10.0.0.1", "198.51.100.1, 203.0.113.5")).status).toBe(200)
  })

  it("records the forwarded client address in the audit log", async () => {
    const response = await canopy.fetch(
      new Request("http://canopy.test/admin/v1/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.44" },
        body: JSON.stringify({ email: "nobody@example.com", password: "wrong password here" }),
      }),
      undefined,
      { ip: "10.0.0.1" },
    )
    expect(response.status).toBe(401)
    const entry = await meta
      .collection("audit_log")
      .findOne({ action: "session.login" }, { sort: { at: -1 } })
    expect(entry?.["origin"]).toMatchObject({ ip: "203.0.113.44" })
  })
})
