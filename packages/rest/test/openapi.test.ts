import { Authenticator } from "@canopy/auth"
import { allow, auth, collection, createPolicySet } from "@canopy/policy"
import { MONGODB_URI, testPolicyEngine } from "@canopy/testing"
import { Validator } from "@seriousme/openapi-schema-validator"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { type Db, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createRestHandler, loadSchema, type RestHandler, SchemaCache } from "../src/index.ts"

const ISSUER = "https://idp.example.test/"
const PUBLISHABLE = "canopy_pk_test"
const SECRET = "canopy_sk_test"

const todos = collection("todos", {
  exposed: true,
  policies: [
    allow
      .read("authenticated")
      .where({ ownerId: auth("sub") })
      .named("read own todos"),
    allow
      .insert("authenticated")
      .check({ ownerId: auth("sub") })
      .named("create own todos"),
  ],
  fields: {
    read: { default: { omit: ["internalNotes"] } },
    write: { default: { only: ["title", "ownerId"] } },
  },
})
const posts = collection("posts", {
  exposed: true,
  policies: [allow.read("public").where({ published: true }).named("published posts")],
})
const hidden = collection("hidden", { exposed: false, policies: [allow.read("authenticated")] })

type Doc = { _id: string; [key: string]: unknown }

const suite = MONGODB_URI === undefined ? describe.skip : describe

suite("OpenAPI and schemas against MongoDB", () => {
  const dbName = `canopy_rest_openapi_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let client: MongoClient
  let db: Db
  let rest: RestHandler
  let token: string

  beforeAll(async () => {
    client = new MongoClient(MONGODB_URI ?? "")
    await client.connect()
    db = client.db(dbName)
    await db.collection<Doc>("todos").insertMany([
      { _id: "t1", ownerId: "a", title: "x", done: false, internalNotes: "n" },
      { _id: "t2", ownerId: "a", title: "y", internalNotes: "n" },
    ])
    await db.createCollection("posts", {
      validator: {
        $jsonSchema: {
          bsonType: "object",
          required: ["title", "published"],
          properties: {
            title: { bsonType: "string" },
            published: { bsonType: "bool" },
            createdAt: { bsonType: "date" },
          },
        },
      },
    })
    await db.collection<Doc>("hidden").insertOne({ _id: "h", secretField: 1 })
    const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" })
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "EdDSA", use: "sig" }
    token = await new SignJWT({ sub: "a" })
      .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(pair.privateKey)
    rest = createRestHandler({
      client,
      database: dbName,
      policies: testPolicyEngine(createPolicySet([todos, posts, hidden])),
      authenticator: new Authenticator(
        { jwks: { keys: [jwk] }, issuer: ISSUER },
        { publishable: [PUBLISHABLE], secret: [SECRET] },
      ),
    })
  })

  afterAll(async () => {
    await db.dropDatabase()
    await client.close()
  })

  const document = async (as: "anon" | "user" | "service"): Promise<Record<string, unknown>> => {
    const response = await rest.fetch(
      new Request("http://canopy.test/rest/v1/openapi.json", {
        headers: {
          apikey: as === "service" ? SECRET : PUBLISHABLE,
          ...(as === "user" ? { authorization: `Bearer ${token}` } : {}),
        },
      }),
    )
    expect(response.status).toBe(200)
    return (await response.json()) as Record<string, unknown>
  }

  const schemaOf = (doc: Record<string, unknown>, name: string): Record<string, unknown> =>
    ((doc["components"] as Record<string, unknown>)["schemas"] as Record<string, unknown>)[
      name
    ] as Record<string, unknown>

  it("serves a valid OpenAPI 3.1 document for every role", async () => {
    for (const as of ["anon", "user", "service"] as const) {
      const doc = await document(as)
      const result = await new Validator().validate(doc)
      expect(result.errors, as).toBeUndefined()
      expect(result.valid, as).toBe(true)
      expect(doc["openapi"]).toBe("3.1.0")
    }
  })

  it("describes only what each role can reach", async () => {
    const paths = (doc: Record<string, unknown>) => Object.keys(doc["paths"] as object)
    const anon = await document("anon")
    expect(paths(anon).filter((path) => path.includes("todos"))).toEqual([])
    expect(paths(anon)).toContain("/rest/v1/posts")
    expect(paths(anon)).not.toContain("/rest/v1/_batch")
    expect(Object.keys((anon["paths"] as Record<string, object>)["/rest/v1/posts"] ?? {})).toEqual([
      "get",
    ])
    const user = await document("user")
    expect(Object.keys((user["paths"] as Record<string, object>)["/rest/v1/todos"] ?? {})).toEqual([
      "get",
      "post",
    ])
    expect(paths(user)).toContain("/rest/v1/_batch")
    expect(paths(user).some((path) => path.includes("hidden"))).toBe(false)
    expect(paths(await document("service"))).toContain("/rest/v1/hidden")
  })

  it("leaves unreadable fields out of documents and unwritable fields out of inserts", async () => {
    const user = await document("user")
    const stored = schemaOf(user, "todos.Document")
    expect(Object.keys(stored["properties"] as object).sort()).toEqual([
      "_id",
      "done",
      "ownerId",
      "title",
    ])
    expect(stored["required"]).toEqual(["_id", "ownerId", "title"])
    const insert = schemaOf(user, "todos.Insert")
    expect(Object.keys(insert["properties"] as object).sort()).toEqual(["_id", "ownerId", "title"])
    expect(insert["required"]).toEqual(["ownerId", "title"])
    expect(JSON.stringify(user)).not.toContain("internalNotes")
    const service = await document("service")
    expect(Object.keys(schemaOf(service, "todos.Document")["properties"] as object)).toContain(
      "internalNotes",
    )
    expect(Object.keys(schemaOf(service, "hidden.Document")["properties"] as object)).toContain(
      "secretField",
    )
  })

  it("names the applying policies but never their filters", async () => {
    const user = await document("user")
    const get = (user["paths"] as Record<string, Record<string, Record<string, unknown>>>)[
      "/rest/v1/todos"
    ]?.["get"]
    expect(get?.["x-canopy-policies"]).toEqual(["read own todos"])
    const text = JSON.stringify(user)
    expect(text).not.toContain("$auth")
    expect(text).not.toContain('"using"')
  })

  it("prefers the collection validator over inference", async () => {
    const posts = await loadSchema(db, "posts")
    expect(posts.source).toBe("validator")
    expect(Object.keys(posts.shape.fields).sort()).toEqual(["createdAt", "published", "title"])
    const anon = await document("anon")
    expect(schemaOf(anon, "posts.Document")["required"]).toEqual(["published", "title"])
  })

  it("infers from the newest documents deterministically and caches with a TTL", async () => {
    const first = await loadSchema(db, "todos", { sampleSize: 1 })
    expect(first).toMatchObject({ source: "inferred", sampled: 1 })
    expect(first.shape.fields["done"]).toBeUndefined()
    expect(await loadSchema(db, "todos", { sampleSize: 1 })).toEqual(first)
    expect((await loadSchema(db, "todos")).shape.fields["done"]?.required).toBe(false)
    const overridden = await loadSchema(db, "todos", {
      overrides: { todos: { type: "object", properties: { x: { type: "string" } } } },
    })
    expect(overridden.source).toBe("config")
    let now = 0
    const cache = new SchemaCache(db, { ttlMs: 1000, now: () => now })
    const a = await cache.get("todos")
    expect(await cache.get("todos")).toBe(a)
    now = 1000
    expect(await cache.get("todos")).not.toBe(a)
    const version = cache.version
    cache.invalidate()
    expect(cache.version).toBeGreaterThan(version)
  })
})
