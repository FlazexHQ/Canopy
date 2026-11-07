import { Authenticator } from "@canopy/auth"
import { allow, collection, createPolicySet, PolicyEngine } from "@canopy/policy"
import { ctToBigInt } from "@canopy/protocol"
import { MONGODB_URI } from "@canopy/testing"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createRestHandler, type RestHandler } from "../src/index.ts"

const suite = MONGODB_URI === undefined ? describe.skip : describe

suite("reads before the app database exists", () => {
  const dbName = `canopy_rest_empty_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let client: MongoClient
  let rest: RestHandler

  beforeAll(async () => {
    client = new MongoClient(MONGODB_URI ?? "")
    await client.connect()
    rest = createRestHandler({
      client,
      database: dbName,
      metaDatabase: `${dbName}_meta`,
      policies: new PolicyEngine(
        createPolicySet([collection("items", { exposed: true, policies: [allow.read("anon")] })]),
      ),
      authenticator: new Authenticator(undefined, { publishable: ["pk"] }),
    })
  })

  afterAll(async () => {
    await client.db(dbName).dropDatabase()
    await client.close()
  })

  const get = async (path: string, body?: unknown): Promise<Record<string, unknown>> => {
    const response = await rest.fetch(
      new Request(`http://canopy.test/rest/v1${path}`, {
        headers: { apikey: "pk", "content-type": "application/json" },
        ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
      }),
    )
    expect(response.status).toBe(200)
    return (await response.json()) as Record<string, unknown>
  }

  it("answers an empty page and count with a cluster time, then sees later writes", async () => {
    const names = await client.db().admin().listDatabases({ nameOnly: true })
    expect(names.databases.map((db) => db.name)).not.toContain(dbName)
    const empty = await get("/items")
    expect(empty["data"]).toEqual([])
    expect(typeof empty["ct"]).toBe("string")
    const counted = await get("/items/_count", {})
    expect(counted["data"]).toEqual({ count: 0, exact: true })
    await client
      .db(dbName)
      .collection("items")
      .insertOne({ _id: "a" as never })
    const after = await get("/items")
    expect(after["data"]).toEqual([{ _id: "a" }])
    expect(ctToBigInt(after["ct"] as string) >= ctToBigInt(empty["ct"] as string)).toBe(true)
  })
})
