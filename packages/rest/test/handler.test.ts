import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { Authenticator } from "@canopy/auth"
import { compileSort } from "@canopy/matcher"
import { allow, auth, collection, createPolicySet, PolicyEngine } from "@canopy/policy"
import { ctToBigInt, ErrorCode, toCt } from "@canopy/protocol"
import { MONGODB_URI } from "@canopy/testing"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { BSON, type Db, type Document, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createRestHandler, type RestHandler, toNodeListener } from "../src/index.ts"

const ISSUER = "https://idp.example.test/"
const PUBLISHABLE = "canopy_pk_test"
const SECRET = "canopy_sk_test"
const BASE = "http://canopy.test/rest/v1"

const todos = collection("todos", {
  exposed: true,
  realtime: true,
  policies: [
    allow
      .read("authenticated")
      .where({ ownerId: auth("sub") })
      .named("read own"),
    allow.insert("authenticated").check({ ownerId: auth("sub") }),
  ],
  fields: { read: { default: { omit: ["internalNotes"] } } },
})

const posts = collection("posts", {
  exposed: true,
  policies: [allow.read("public").where({ published: true })],
})

const hidden = collection("hidden", { exposed: false, policies: [allow.read("authenticated")] })

type StringIdDoc = { _id: string; [key: string]: unknown }

const suite = MONGODB_URI === undefined ? describe.skip : describe

const oid = (n: number): BSON.ObjectId => new BSON.ObjectId(n.toString(16).padStart(24, "0"))

/** Alice owns 0 to 11, Bob owns 12 to 14. `rank` mixes types, nulls and missing values on purpose. */
function seed(): Document[] {
  const ranks: unknown[] = [
    3,
    "b",
    null,
    undefined,
    1.5,
    "a",
    true,
    3,
    undefined,
    new Date(5),
    0,
    "b",
  ]
  const out: Document[] = []
  for (let n = 0; n < 15; n += 1) {
    const doc: Document = {
      _id: oid(n + 1),
      ownerId: n < 12 ? "alice" : "bob",
      title: `todo ${n}`,
      status: n % 3 === 0 ? "done" : "active",
      priority: n % 4,
      createdAt: new Date(Date.UTC(2026, 0, 1 + n)),
      internalNotes: `secret ${n}`,
    }
    const rank = ranks[n % ranks.length]
    if (rank !== undefined) doc["rank"] = rank
    out.push(doc)
  }
  return out
}

suite("REST read endpoints against MongoDB", () => {
  const dbName = `canopy_rest_http_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let client: MongoClient
  let db: Db
  let rest: RestHandler
  let errors: unknown[]
  let tokens: Record<"alice" | "bob", string>
  const data = seed()

  beforeAll(async () => {
    client = new MongoClient(MONGODB_URI ?? "")
    await client.connect()
    db = client.db(dbName)
    await db.collection("todos").insertMany(data)
    await db.collection<StringIdDoc>("posts").insertMany([
      { _id: "p1", published: true, title: "hello" },
      { _id: "p2", published: false, title: "draft" },
    ])
    await db.collection<StringIdDoc>("hidden").insertOne({ _id: "h1" })
    await db.collection<StringIdDoc>("raw").insertOne({ _id: "r1" })
    const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" })
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "EdDSA", use: "sig" }
    const sign = (sub: string): Promise<string> =>
      new SignJWT({ sub })
        .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
        .setIssuer(ISSUER)
        .setIssuedAt()
        .setExpirationTime("10m")
        .sign(pair.privateKey)
    tokens = { alice: await sign("alice"), bob: await sign("bob") }
    errors = []
    rest = createRestHandler({
      client,
      database: dbName,
      policies: new PolicyEngine(createPolicySet([todos, posts, hidden])),
      authenticator: new Authenticator(
        { jwks: { keys: [jwk] }, issuer: ISSUER },
        { publishable: [PUBLISHABLE], secret: [SECRET] },
      ),
      idTypes: { posts: "string" },
      maxBodyBytes: 4096,
      cors: { origins: ["https://app.example.test"] },
      onError: (error) => errors.push(error),
    })
  })

  afterAll(async () => {
    await db.dropDatabase()
    await client.close()
  })

  type As = "alice" | "bob" | "anon" | "service"

  const call = (
    path: string,
    init: { as?: As; method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Response> => {
    const as = init.as ?? "alice"
    const headers: Record<string, string> = {
      apikey: as === "service" ? SECRET : PUBLISHABLE,
      ...(as === "alice" || as === "bob" ? { authorization: `Bearer ${tokens[as]}` } : {}),
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    }
    return rest.fetch(
      new Request(`${BASE}${path}`, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers,
        ...(init.body === undefined
          ? {}
          : { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) }),
      }),
    )
  }

  const json = async (response: Response): Promise<Record<string, unknown>> =>
    (await response.json()) as Record<string, unknown>

  const ids = (body: Record<string, unknown>): string[] =>
    (body["data"] as { _id: { $oid: string } }[]).map((doc) => doc._id.$oid)

  const hex = (doc: Document): string => (doc["_id"] as BSON.ObjectId).toHexString()

  const aliceDocs = data.filter((doc) => doc["ownerId"] === "alice")

  /** Checks a Problem Details response and returns its body. */
  const problem = async (
    response: Response,
    status: number,
    code: string,
  ): Promise<Record<string, unknown>> => {
    expect(response.status).toBe(status)
    expect(response.headers.get("content-type")).toBe("application/problem+json")
    const body = await json(response)
    expect(body).toMatchObject({
      status,
      code,
      type: `urn:canopy:error:${code.slice("CANOPY_".length).toLowerCase().replaceAll("_", "-")}`,
    })
    expect(typeof body["detail"]).toBe("string")
    expect(body["requestId"]).toBe(response.headers.get("x-request-id"))
    return body
  }

  describe("GET /", () => {
    it("lists the collections each caller can reach with the granted operations", async () => {
      expect((await json(await call("/")))["data"]).toEqual([
        { name: "posts", operations: ["read"], realtime: false },
        { name: "todos", operations: ["read", "insert"], realtime: true },
      ])
      expect((await json(await call("/", { as: "anon" })))["data"]).toEqual([
        { name: "posts", operations: ["read"], realtime: false },
      ])
      const names = (
        (await json(await call("/", { as: "service" })))["data"] as { name: string }[]
      ).map((info) => info.name)
      expect(names).toEqual(["hidden", "posts", "raw", "todos"])
    })
  })

  describe("GET /{coll}", () => {
    it("returns only visible documents, without unreadable fields, with a cluster time", async () => {
      const response = await call("/todos")
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8")
      const body = await json(response)
      expect(ids(body).sort()).toEqual(aliceDocs.map(hex).sort())
      for (const doc of body["data"] as Record<string, unknown>[]) {
        expect(doc).not.toHaveProperty("internalNotes")
        expect(doc["ownerId"]).toBe("alice")
      }
      expect(body["page"]).toEqual({ limit: 100, next: null })
      expect(typeof body["ct"]).toBe("string")
    })

    it("validates pages by content, so an unchanged result answers 304 to If-None-Match", async () => {
      const first = await call("/todos?sort=_id")
      const tag = first.headers.get("etag")
      expect(tag).toMatch(/^W\/"[0-9a-f]{32}"$/)
      const same = await call("/todos?sort=_id", { headers: { "if-none-match": `"x", ${tag}` } })
      expect(same.status).toBe(304)
      expect(same.headers.get("etag")).toBe(tag)
      expect(await same.text()).toBe("")
      expect((await call("/todos?sort=-_id")).headers.get("etag")).not.toBe(tag)
      expect((await call("/todos?sort=_id", { as: "bob" })).headers.get("etag")).not.toBe(tag)
      const canonical = await call("/todos?sort=_id", {
        headers: { accept: "application/ejson", "if-none-match": tag ?? "" },
      })
      expect(canonical.status).toBe(200)
      const target = aliceDocs[0]?.["_id"]
      await db.collection("todos").updateOne({ _id: target }, { $set: { etagProbe: 1 } })
      try {
        const changed = await call("/todos?sort=_id", { headers: { "if-none-match": tag ?? "" } })
        expect(changed.status).toBe(200)
        expect(changed.headers.get("etag")).not.toBe(tag)
      } finally {
        await db.collection("todos").updateOne({ _id: target }, { $unset: { etagProbe: "" } })
      }
    })

    it("reports a snapshot that includes earlier writes", async () => {
      const session = client.startSession()
      try {
        await db.collection("posts").updateOne(
          { _id: "p1" } as Document,
          { $set: { v: 1 } },
          {
            session,
          },
        )
        const written = toCt(session.operationTime)
        const body = await json(await call("/posts", { as: "anon" }))
        expect(written).toBeDefined()
        expect(ctToBigInt(body["ct"] as string) >= ctToBigInt(written ?? "0")).toBe(true)
        expect(body["data"]).toEqual([{ _id: "p1", published: true, title: "hello", v: 1 }])
      } finally {
        await session.endSession()
      }
    })

    it("applies shorthand filters, sort with the _id tie breaker, and fields", async () => {
      const body = await json(
        await call("/todos?status=eq.active&priority=gte.2&sort=-priority&fields=title,priority"),
      )
      const expected = aliceDocs
        .filter((doc) => doc["status"] === "active" && Number(doc["priority"]) >= 2)
        .sort(compileSort({ priority: -1 }))
      expect(body["data"]).toEqual(
        expected.map((doc) => ({
          _id: { $oid: hex(doc) },
          title: doc["title"],
          priority: doc["priority"],
        })),
      )
    })

    it("combines the filter parameter with shorthand filters", async () => {
      const filter = encodeURIComponent(
        JSON.stringify({ createdAt: { $gte: { $date: "2026-01-06T00:00:00Z" } } }),
      )
      const body = await json(await call(`/todos?filter=${filter}&status=eq.done`))
      const expected = aliceDocs.filter(
        (doc) =>
          doc["status"] === "done" &&
          (doc["createdAt"] as Date) >= new Date("2026-01-06T00:00:00Z"),
      )
      expect(ids(body).sort()).toEqual(expected.map(hex).sort())
      expect(expected.length).toBeGreaterThan(0)
    })

    it("pages through every sort with cursors and returns each visible document once, in order", async () => {
      const sorts: [string, Record<string, 1 | -1>][] = [
        ["", {}],
        ["-rank", { rank: -1 }],
        ["rank,-priority", { rank: 1, priority: -1 }],
        ["-createdAt", { createdAt: -1 }],
        ["status,-_id", { status: 1, _id: -1 }],
      ]
      for (const [text, spec] of sorts) {
        for (const limit of [1, 2, 5]) {
          const seen: string[] = []
          let next: string | null = null
          let pages = 0
          do {
            const query: string = `limit=${limit}${text === "" ? "" : `&sort=${text}`}${next === null ? "" : `&after=${next}`}&fields=title`
            const response = await call(`/todos?${query}`)
            expect(response.status).toBe(200)
            const body = await json(response)
            seen.push(...ids(body))
            next = (body["page"] as { next: string | null }).next
            pages += 1
            expect(pages).toBeLessThan(20)
          } while (next !== null)
          expect(seen).toEqual([...aliceDocs].sort(compileSort(spec)).map(hex))
        }
      }
    })

    it("rejects a cursor used with another filter, sort or collection", async () => {
      const first = await json(await call("/todos?limit=2&sort=-priority"))
      const next = (first["page"] as { next: string }).next
      for (const path of [
        `/todos?limit=2&sort=priority&after=${next}`,
        `/todos?limit=2&sort=-priority&status=eq.done&after=${next}`,
        `/posts?limit=2&sort=-priority&after=${next}`,
      ]) {
        const body = await problem(await call(path), 400, ErrorCode.InvalidQuery)
        expect(body["detail"]).toBe("The cursor belongs to a different query")
      }
      await problem(await call("/todos?after=AAAA"), 400, ErrorCode.InvalidQuery)
    })

    it("keeps DLS on every page, even with a cursor from another caller", async () => {
      const bobFirst = await json(await call("/todos?limit=1", { as: "bob" }))
      const cursor = (bobFirst["page"] as { next: string }).next
      const body = await json(await call(`/todos?limit=100&after=${cursor}`))
      for (const doc of body["data"] as Record<string, unknown>[])
        expect(doc["ownerId"]).toBe("alice")
    })

    it("supports skip but not together with after", async () => {
      const all = ids(await json(await call("/todos?sort=createdAt")))
      expect(ids(await json(await call("/todos?sort=createdAt&skip=3&limit=2")))).toEqual(
        all.slice(3, 5),
      )
      const first = await json(await call("/todos?limit=1"))
      const next = (first["page"] as { next: string }).next
      await problem(await call(`/todos?skip=1&after=${next}`), 400, ErrorCode.InvalidQuery)
    })

    it("counts every match on request, through count or Prefer", async () => {
      const body = await json(await call("/todos?status=eq.active&limit=1&count=exact"))
      const total = aliceDocs.filter((doc) => doc["status"] === "active").length
      expect(body["page"]).toMatchObject({ limit: 1, total })
      const preferred = await json(
        await call("/todos?status=eq.active&limit=1", { headers: { prefer: "count=exact" } }),
      )
      expect((preferred["page"] as { total: number }).total).toBe(total)
    })

    it("rejects filters and sorts on unreadable fields", async () => {
      const body = await problem(
        await call("/todos?internalNotes=eq.x"),
        400,
        ErrorCode.InvalidQuery,
      )
      expect(body["detail"]).toMatch(/internalNotes/)
      expect(body["instance"]).toBe("/rest/v1/todos")
      await problem(await call("/todos?sort=internalNotes"), 400, ErrorCode.InvalidQuery)
      const nested = encodeURIComponent(JSON.stringify({ $or: [{ internalNotes: "secret 0" }] }))
      await problem(await call(`/todos?filter=${nested}`), 400, ErrorCode.InvalidQuery)
    })

    it("intersects requested fields with the readable ones", async () => {
      const body = await json(
        await call("/todos?fields=internalNotes,title&limit=1&sort=createdAt"),
      )
      expect(body["data"]).toEqual([{ _id: { $oid: hex(aliceDocs[0] ?? {}) }, title: "todo 0" }])
      const excluded = await json(await call("/todos?fields=-title,-status&limit=1&sort=createdAt"))
      const doc = (excluded["data"] as Record<string, unknown>[])[0]
      expect(Object.keys(doc ?? {}).sort()).toEqual([
        "_id",
        "createdAt",
        "ownerId",
        "priority",
        "rank",
      ])
    })

    it("rejects unknown collections for callers without the service role", async () => {
      await problem(await call("/hidden"), 404, ErrorCode.NotFound)
      await problem(await call("/raw"), 404, ErrorCode.NotFound)
      expect((await json(await call("/raw", { as: "service" })))["data"]).toEqual([{ _id: "r1" }])
    })

    it("returns no documents to roles without a read policy", async () => {
      expect((await json(await call("/todos", { as: "anon" })))["data"]).toEqual([])
    })

    it("rejects write only parameters and bad paging values", async () => {
      await problem(await call("/todos?where=x"), 400, ErrorCode.InvalidQuery)
      await problem(await call("/todos?limit=5000"), 400, ErrorCode.InvalidQuery)
      await problem(await call("/todos?title=like.x"), 400, ErrorCode.InvalidQuery)
    })
  })

  describe("POST /{coll}/_query", () => {
    it("takes the query in the body with EJSON values", async () => {
      const response = await call("/todos/_query", {
        body: {
          filter: { createdAt: { $lt: { $date: "2026-01-04T00:00:00Z" } } },
          sort: { createdAt: -1 },
          fields: "title",
          limit: 2,
        },
      })
      const body = await json(response)
      expect(body["data"]).toEqual([
        { _id: { $oid: hex(aliceDocs[2] ?? {}) }, title: "todo 2" },
        { _id: { $oid: hex(aliceDocs[1] ?? {}) }, title: "todo 1" },
      ])
      expect((body["page"] as { next: unknown }).next).toEqual(expect.any(String))
    })

    it("rejects oversized and malformed bodies", async () => {
      await problem(
        await call("/todos/_query", { body: { filter: { title: "x".repeat(5000) } } }),
        413,
        ErrorCode.PayloadTooLarge,
      )
      await problem(
        await call("/todos/_query", { body: '{"filter":' }),
        400,
        ErrorCode.InvalidQuery,
      )
      await problem(
        await call("/todos/_query", { body: "{}", headers: { "content-type": "text/plain" } }),
        400,
        ErrorCode.InvalidQuery,
      )
      await problem(await call("/todos/_query", { body: { nope: 1 } }), 400, ErrorCode.InvalidQuery)
      await problem(
        await call("/todos/_query", { body: { filter: { $where: "true" } } }),
        400,
        ErrorCode.InvalidQuery,
      )
    })
  })

  describe("GET /{coll}/{id}", () => {
    it("returns a visible document and 404 for invisible and missing ones alike", async () => {
      const own = aliceDocs[0] ?? {}
      const body = await json(await call(`/todos/${hex(own)}?fields=title`))
      expect(body).toMatchObject({ data: { _id: { $oid: hex(own) }, title: "todo 0" } })
      expect(Object.keys(body["data"] as object)).toEqual(["_id", "title"])
      const bobs = data.find((doc) => doc["ownerId"] === "bob") ?? {}
      const invisible = await problem(await call(`/todos/${hex(bobs)}`), 404, ErrorCode.NotFound)
      const missing = await problem(await call(`/todos/${"f".repeat(24)}`), 404, ErrorCode.NotFound)
      expect(invisible["detail"]).toBe(missing["detail"])
      expect((await call(`/todos/${hex(bobs)}`, { as: "bob" })).status).toBe(200)
    })

    it("reads ids by the collection id type or as EJSON", async () => {
      expect((await call("/posts/p1", { as: "anon" })).status).toBe(200)
      await problem(await call("/posts/p2", { as: "anon" }), 404, ErrorCode.NotFound)
      const ejson = encodeURIComponent(JSON.stringify({ $oid: hex(aliceDocs[1] ?? {}) }))
      expect((await call(`/todos/${ejson}`)).status).toBe(200)
      const regex = encodeURIComponent(
        JSON.stringify({ $regularExpression: { pattern: ".", options: "" } }),
      )
      await problem(await call(`/todos/${regex}`), 400, ErrorCode.InvalidQuery)
      await problem(
        await call(`/todos/${hex(aliceDocs[0] ?? {})}?status=eq.done`),
        400,
        ErrorCode.InvalidQuery,
      )
    })
  })

  describe("POST /{coll}/_count and _distinct", () => {
    it("counts exactly whenever DLS restricts the count", async () => {
      const exact = await json(
        await call("/todos/_count", { body: { filter: { status: "done" } } }),
      )
      expect(exact["data"]).toEqual({
        count: aliceDocs.filter((doc) => doc["status"] === "done").length,
        exact: true,
      })
      const estimated = await json(
        await call("/todos/_count", { body: {}, headers: { prefer: "count=estimated" } }),
      )
      expect(estimated["data"]).toEqual({ count: aliceDocs.length, exact: true })
      const service = await json(
        await call("/todos/_count", {
          as: "service",
          body: {},
          headers: { prefer: "count=estimated" },
        }),
      )
      expect(service["data"]).toEqual({ count: data.length, exact: false })
      expect(typeof service["ct"]).toBe("string")
    })

    it("returns distinct values of readable fields among visible documents", async () => {
      const body = await json(await call("/todos/_distinct", { body: { field: "ownerId" } }))
      expect(body["data"]).toEqual(["alice"])
      const statuses = await json(
        await call("/todos/_distinct", { body: { field: "status", filter: { priority: 0 } } }),
      )
      expect((statuses["data"] as string[]).sort()).toEqual(
        [
          ...new Set(aliceDocs.filter((doc) => doc["priority"] === 0).map((doc) => doc["status"])),
        ].sort(),
      )
      await problem(
        await call("/todos/_distinct", { body: { field: "internalNotes" } }),
        400,
        ErrorCode.InvalidQuery,
      )
      await problem(
        await call("/todos/_distinct", { body: { field: 1 } }),
        400,
        ErrorCode.InvalidQuery,
      )
    })
  })

  describe("HTTP behavior", () => {
    it("encodes canonical EJSON when asked", async () => {
      const own = aliceDocs[0] ?? {}
      const response = await call(`/todos/${hex(own)}?fields=priority,createdAt`, {
        headers: { accept: "application/ejson" },
      })
      expect(response.headers.get("content-type")).toBe("application/ejson")
      expect((await json(response))["data"]).toEqual({
        _id: { $oid: hex(own) },
        priority: { $numberInt: "0" },
        createdAt: { $date: { $numberLong: String(Date.UTC(2026, 0, 1)) } },
      })
      const relaxed = await json(await call(`/todos/${hex(own)}?fields=priority,createdAt`))
      expect(relaxed["data"]).toEqual({
        _id: { $oid: hex(own) },
        priority: 0,
        createdAt: { $date: "2026-01-01T00:00:00.000Z" },
      })
    })

    it("rejects bad credentials with a Bearer challenge", async () => {
      const unknownKey = await call("/todos", { headers: { apikey: "canopy_pk_nope" } })
      await problem(unknownKey, 401, ErrorCode.Unauthorized)
      const badToken = await call("/todos", { headers: { authorization: "Bearer x.y.z" } })
      expect(badToken.headers.get("www-authenticate")).toBe("Bearer")
      await problem(badToken, 401, ErrorCode.Unauthorized)
    })

    it("answers unknown paths with 404 and wrong methods with 405 and Allow", async () => {
      const outside = await rest.fetch(new Request("http://canopy.test/other"))
      await problem(outside, 404, ErrorCode.NotFound)
      await problem(await call("/todos/a/b"), 404, ErrorCode.NotFound)
      const wrong = await call("/", { method: "PUT", body: {} })
      expect(wrong.status).toBe(405)
      expect(wrong.headers.get("allow")).toBe("GET")
      expect(((await wrong.json()) as { status: number }).status).toBe(405)
    })

    it("echoes a safe request id and mints one otherwise", async () => {
      const given = await call("/", { headers: { "x-request-id": "req-123" } })
      expect(given.headers.get("x-request-id")).toBe("req-123")
      const minted = await call("/", { headers: { "x-request-id": "bad id\n" } })
      expect(minted.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/)
    })

    it("answers CORS preflights for allowed origins only", async () => {
      const allowed = await rest.fetch(
        new Request(`${BASE}/todos`, {
          method: "OPTIONS",
          headers: { origin: "https://app.example.test", "access-control-request-method": "GET" },
        }),
      )
      expect(allowed.status).toBe(204)
      expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.example.test")
      expect(allowed.headers.get("access-control-allow-headers")).toMatch(/apikey/)
      const denied = await rest.fetch(
        new Request(`${BASE}/todos`, {
          method: "OPTIONS",
          headers: { origin: "https://evil.example.test", "access-control-request-method": "GET" },
        }),
      )
      expect(denied.headers.get("access-control-allow-origin")).toBeNull()
      const simple = await call("/", { headers: { origin: "https://app.example.test" } })
      expect(simple.headers.get("access-control-allow-origin")).toBe("https://app.example.test")
      expect(simple.headers.get("access-control-expose-headers")).toMatch(/x-request-id/)
    })

    it("serves node:http through the Node listener", async () => {
      const server: Server = createServer(toNodeListener(rest))
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
      try {
        const { port } = server.address() as AddressInfo
        const response = await fetch(`http://127.0.0.1:${port}/rest/v1/todos/_query`, {
          method: "POST",
          headers: {
            apikey: PUBLISHABLE,
            authorization: `Bearer ${tokens.alice}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ filter: { status: "done" }, fields: "title", limit: 1 }),
        })
        expect(response.status).toBe(200)
        expect(response.headers.get("x-request-id")).toEqual(expect.any(String))
        const body = (await response.json()) as { data: unknown[] }
        expect(body.data).toHaveLength(1)
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error === undefined ? resolve() : reject(error))),
        )
      }
    })

    it("reported no internal errors", () => {
      expect(errors).toEqual([])
    })
  })
})
