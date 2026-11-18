import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { allow, auth, collection, createPolicySet, restrict } from "@canopy/policy"
import { DIFF_RUNS, MONGODB_URI, TEST_ENV } from "@canopy/testing"
import fc from "fast-check"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { type Db, MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import WebSocket from "ws"
import { type Canopy, createCanopy, defineConfig } from "../src/index.ts"

const ISSUER = "https://idp.equivalence.test/"
const AUDIENCE = "https://api.equivalence.test"
const KEY = "pk_equivalence"
const RUNS = Math.max(10, Math.round(DIFF_RUNS / 10))

/**
 * One policy set exercising permissive and restrictive policies, a role scoped policy, an anon policy,
 * `check` clauses on insert and update, and a field rule. The same callers and data go through REST,
 * GraphQL and realtime; every entry point must show the same documents and make the same decisions.
 */
const items = collection("items", {
  exposed: true,
  realtime: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub") }),
    allow.read("reviewer").where({ status: { $in: ["open", "closed"] }, level: { $lte: 3 } }),
    allow.read("anon").where({ status: "open", level: 0 }),
    restrict.read("authenticated").where({ status: { $ne: "archived" } }),
    allow.insert("authenticated").check({ ownerId: auth("sub"), level: { $lte: 3 } }),
    allow
      .update("authenticated")
      .where({ ownerId: auth("sub") })
      .check({ level: { $lte: 4 } }),
  ],
  fields: { read: { default: { omit: ["secret"] } } },
})

interface Item {
  _id: string
  ownerId: string
  status: string
  level: number
  secret: string
}

interface Caller {
  readonly name: string
  readonly sub?: string
  readonly roles?: readonly string[]
}

const CALLERS: readonly Caller[] = [
  { name: "anon" },
  { name: "u1", sub: "u1", roles: [] },
  { name: "u2 reviewer", sub: "u2", roles: ["reviewer"] },
  { name: "u3 reviewer", sub: "u3", roles: ["reviewer"] },
]

const FILTERS: readonly Record<string, unknown>[] = [
  {},
  { status: "open" },
  { level: { $gte: 2 } },
  { ownerId: { $in: ["u1", "u2"] } },
  { $or: [{ level: 0 }, { status: "closed" }] },
]

const fields = {
  ownerId: fc.constantFrom("u1", "u2", "u3"),
  status: fc.constantFrom("open", "closed", "archived"),
  level: fc.integer({ min: 0, max: 5 }),
  secret: fc.constantFrom("s1", "s2"),
}

/**
 * A write decision normalized across entry points: the write took effect, was refused with this code, or
 * matched nothing (REST answers 404 where GraphQL and realtime report zero matches).
 */
type Outcome = "applied" | `refused ${string}` | "no match"

const suite = MONGODB_URI === undefined ? describe.skip : describe

suite("DLS is the same through REST, GraphQL and realtime", () => {
  const dbName = `canopy_equiv_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  const metaName = `${dbName}_meta`
  let mongo: MongoClient
  let db: Db
  let canopy: Canopy
  let server: Server
  let base: string
  let sign: (caller: Caller) => Promise<string | undefined>
  let run = 0
  const seen = {
    reads: new Set<string>(),
    inserts: new Set<Outcome>(),
    updates: new Set<Outcome>(),
  }

  beforeAll(async () => {
    mongo = new MongoClient(MONGODB_URI ?? "")
    await mongo.connect()
    db = mongo.db(dbName)
    await db.createCollection("items", {
      validator: {
        $jsonSchema: {
          bsonType: "object",
          required: ["_id", "ownerId", "status", "level"],
          properties: {
            _id: { bsonType: "string" },
            ownerId: { bsonType: "string" },
            status: { bsonType: "string" },
            level: { bsonType: "int" },
            secret: { bsonType: "string" },
          },
        },
      },
    })
    const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" })
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "EdDSA", use: "sig" }
    sign = async (caller) =>
      caller.sub === undefined
        ? undefined
        : new SignJWT({ roles: [...(caller.roles ?? [])] })
            .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
            .setIssuer(ISSUER)
            .setAudience(AUDIENCE)
            .setSubject(caller.sub)
            .setIssuedAt()
            .setExpirationTime("10m")
            .sign(pair.privateKey)
    canopy = await createCanopy(
      defineConfig({
        mongodb: { uri: MONGODB_URI ?? "", database: dbName, metaDatabase: metaName },
        auth: {
          kind: "external",
          jwks: { keys: [jwk] },
          issuer: ISSUER,
          audience: AUDIENCE,
          rolesClaim: "roles",
        },
        keys: { publishable: [KEY] },
        realtime: { checkpoints: "off", drainWindow: "1s" },
        rateLimits: false,
      }),
      { env: TEST_ENV, policies: createPolicySet([items]), onSetupToken: false },
    )
    server = createServer(canopy.node())
    await canopy.attach(server)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await canopy?.close()
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    await db?.dropDatabase()
    await mongo?.db(metaName).dropDatabase()
    await mongo?.close()
  })

  const headers = async (caller: Caller): Promise<Record<string, string>> => {
    const token = await sign(caller)
    return {
      apikey: KEY,
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    }
  }

  const byId = (docs: readonly Record<string, unknown>[]) =>
    [...docs].sort((a, b) => String(a["_id"]).localeCompare(String(b["_id"])))

  const restRead = async (caller: Caller, filter: Record<string, unknown>) => {
    const query = new URLSearchParams({ filter: JSON.stringify(filter), limit: "100" })
    const response = await fetch(`${base}/rest/v1/items?${query}`, {
      headers: await headers(caller),
    })
    const body = (await response.json()) as { data?: Record<string, unknown>[]; code?: string }
    return response.ok ? byId(body.data ?? []) : `refused ${body.code}`
  }

  const graphql = async (
    caller: Caller,
    query: string,
    variables: Record<string, unknown> = {},
  ) => {
    const response = await fetch(`${base}/graphql/v1`, {
      method: "POST",
      headers: await headers(caller),
      body: JSON.stringify({ query, variables }),
    })
    const body = (await response.json()) as {
      data?: Record<string, unknown> | null
      errors?: { message: string; extensions?: { code?: string } }[]
    }
    return body
  }

  /**
   * GraphQL leaves operations a caller may not perform out of that caller's schema (the mutation, its input
   * type, or the whole mutation root), so asking for one fails validation; that is the GraphQL form of
   * `CANOPY_FORBIDDEN`.
   */
  const graphqlResult = (body: Awaited<ReturnType<typeof graphql>>): string => {
    const error = body.errors?.[0]
    if (error === undefined) return "ok"
    if (
      (error.extensions?.code === "GRAPHQL_VALIDATION_FAILED" ||
        error.extensions?.code === "CANOPY_INVALID_QUERY") &&
      /^(Cannot query field "\w+" on type "Mutation"|Unknown type "\w+"|Schema is not configured)/.test(
        error.message,
      )
    )
      return "error CANOPY_FORBIDDEN"
    return `error ${error.extensions?.code} ${error.message}`
  }

  const graphqlRead = async (caller: Caller, filter: Record<string, unknown>) => {
    const body = await graphql(
      caller,
      "query ($f: JSON) { items(filter: { raw: $f }, limit: 100) { nodes { _id ownerId status level } } }",
      { f: filter },
    )
    if (body.errors !== undefined)
      return `refused ${body.errors[0]?.extensions?.code} ${body.errors[0]?.message}`
    const page = body.data?.["items"] as { nodes: Record<string, unknown>[] }
    return byId(page.nodes)
  }

  /** Opens a realtime session, runs `use` and closes the session. */
  const session = async <T>(
    caller: Caller,
    use: (
      send: (message: Record<string, unknown>) => void,
      next: (test: (m: Record<string, unknown>) => boolean) => Promise<Record<string, unknown>>,
      all: Record<string, unknown>[],
    ) => Promise<T>,
  ): Promise<T> => {
    const socket = new WebSocket(`${base.replace("http", "ws")}/realtime/v1`, "canopy.v1+json")
    const messages: Record<string, unknown>[] = []
    const waiters = new Set<() => void>()
    socket.on("message", (data) => {
      messages.push(JSON.parse(data.toString()) as Record<string, unknown>)
      for (const wake of waiters) wake()
    })
    const next = (test: (m: Record<string, unknown>) => boolean) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(check)
          reject(new Error(`timed out: ${JSON.stringify(messages)}`))
        }, 10_000)
        const check = (): void => {
          const found = messages.find(test)
          if (found === undefined) return
          clearTimeout(timer)
          waiters.delete(check)
          resolve(found)
        }
        waiters.add(check)
        check()
      })
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve())
      socket.once("error", reject)
    })
    const send = (message: Record<string, unknown>) => socket.send(JSON.stringify(message))
    const token = await sign(caller)
    try {
      send({ t: "hello", v: 1, key: KEY, ...(token === undefined ? {} : { token }) })
      await next((m) => m["t"] === "welcome")
      return await use(send, next, messages)
    } finally {
      send({ t: "bye" })
      socket.close()
    }
  }

  const realtimeRead = (caller: Caller, filter: Record<string, unknown>) =>
    session(caller, async (send, next, all) => {
      send({ t: "sub", id: "s", c: "items", q: { filter } })
      const end = await next((m) => (m["t"] === "ready" || m["t"] === "nosub") && m["s"] === "s")
      if (end["t"] === "nosub")
        return `refused ${(end["err"] as { code?: string } | undefined)?.code}`
      return byId(
        all.filter((m) => m["t"] === "added").map((m) => m["d"] as Record<string, unknown>),
      )
    })

  const realtimeWrite = (caller: Caller, op: string, args: Record<string, unknown>) =>
    session(caller, async (send, next) => {
      send({ t: "mut", id: crypto.randomUUID(), c: "items", op, args })
      const ack = await next((m) => m["t"] === "ack")
      return ack["ok"] === true
        ? "ok"
        : `error ${(ack["err"] as { code?: string } | undefined)?.code}`
    })

  const classify = async (
    id: string,
    expected: Partial<Item>,
    result: string,
  ): Promise<Outcome> => {
    const stored = await db.collection<Item>("items").findOne({ _id: id })
    const applied =
      stored !== null &&
      Object.entries(expected).every(([name, value]) => stored[name as keyof Item] === value)
    if (applied) return "applied"
    const code = /CANOPY_[A-Z_]+/.exec(result)?.[0]
    return code === undefined || code === "CANOPY_NOT_FOUND" ? "no match" : `refused ${code}`
  }

  it("shows the same documents and makes the same write decisions for every caller", async () => {
    const own = { ownerId: "u1", status: "open", level: 0, secret: "s1" } as const
    const u1 = CALLERS[1] as Caller
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.record(fields), {
          maxLength: 18,
          selector: (doc) => JSON.stringify(doc),
        }),
        fc.constantFrom(...CALLERS),
        fc.constantFrom(...FILTERS),
        fc.record(fields),
        fc.nat(),
        fc.integer({ min: 1, max: 5 }),
        async (seed, caller, userFilter, candidate, pick, step) => {
          run += 1
          const docs: Item[] = seed.map((doc, index) => ({ _id: `r${run}d${index}`, ...doc }))
          const coll = db.collection<Item>("items")
          await coll.deleteMany({})
          if (docs.length > 0) await coll.insertMany(docs)

          const filter = { $and: [userFilter, { _id: { $ne: `unused${run}` } }] }
          const rest = await restRead(caller, filter)
          const live = await realtimeRead(caller, filter)
          const gql = await graphqlRead(caller, filter)
          expect(live, `realtime vs REST for ${caller.name}`).toEqual(rest)
          const pickFields = (value: typeof rest) =>
            typeof value === "string"
              ? value
              : value.map(({ _id, ownerId, status, level }) => ({ _id, ownerId, status, level }))
          expect(gql, `GraphQL vs REST for ${caller.name}`).toEqual(pickFields(rest))
          if (typeof rest !== "string") {
            expect(rest.every((doc) => !("secret" in doc))).toBe(true)
            seen.reads.add(rest.length === 0 ? "empty" : "documents")
          }

          const inserted: Record<string, Outcome> = {}
          for (const via of ["rest", "graphql", "realtime"] as const) {
            const doc = { _id: `r${run}i-${via}`, ...candidate }
            let result: string
            if (via === "rest") {
              const response = await fetch(`${base}/rest/v1/items`, {
                method: "POST",
                headers: await headers(caller),
                body: JSON.stringify(doc),
              })
              result = response.ok
                ? "ok"
                : `error ${((await response.json()) as { code?: string }).code}`
            } else if (via === "graphql") {
              const body = await graphql(
                caller,
                "mutation ($doc: ItemInsert!) { insertItem(doc: $doc) { _id } }",
                { doc },
              )
              result = graphqlResult(body)
            } else result = await realtimeWrite(caller, "insert", { doc })
            inserted[via] = await classify(doc._id, candidate, result)
          }
          expect(inserted["graphql"], `GraphQL insert vs REST for ${caller.name}`).toBe(
            inserted["rest"],
          )
          expect(inserted["realtime"], `realtime insert vs REST for ${caller.name}`).toBe(
            inserted["rest"],
          )
          seen.inserts.add(inserted["rest"] ?? "no match")

          const target = docs[pick % Math.max(1, docs.length)]
          if (target === undefined) return
          const level = (target.level + step) % 6
          const updated: Record<string, Outcome> = {}
          for (const via of ["rest", "graphql", "realtime"] as const) {
            const id = `${target._id}-${via}`
            await coll.insertOne({ ...target, _id: id })
            let result: string
            if (via === "rest") {
              const response = await fetch(`${base}/rest/v1/items/${id}`, {
                method: "PATCH",
                headers: await headers(caller),
                body: JSON.stringify({ $set: { level } }),
              })
              result = response.ok
                ? "ok"
                : `error ${((await response.json()) as { code?: string }).code}`
            } else if (via === "graphql") {
              const body = await graphql(
                caller,
                "mutation ($f: JSON, $u: JSON) { updateItems(filter: { raw: $f }, update: { raw: $u }) { matched } }",
                { f: { _id: id }, u: { $set: { level } } },
              )
              result = graphqlResult(body)
            } else
              result = await realtimeWrite(caller, "update", { id, update: { $set: { level } } })
            updated[via] = await classify(id, { level }, result)
          }
          expect(updated["graphql"], `GraphQL update vs REST for ${caller.name}`).toBe(
            updated["rest"],
          )
          expect(updated["realtime"], `realtime update vs REST for ${caller.name}`).toBe(
            updated["rest"],
          )
          seen.updates.add(updated["rest"] ?? "no match")
        },
      ),
      {
        numRuns: RUNS,
        examples: [
          [[{ ...own, level: 0 }], u1, {}, { ...own, level: 0 }, 0, 1],
          [[{ ...own, ownerId: "u2" }], u1, {}, { ...own, ownerId: "u2" }, 0, 1],
          [[{ ...own, status: "closed", level: 3 }], u1, {}, { ...own, level: 4 }, 0, 2],
        ],
      },
    )
    expect(seen.reads).toEqual(new Set(["empty", "documents"]))
    expect([...seen.inserts]).toEqual(
      expect.arrayContaining(["applied", "refused CANOPY_POLICY_VIOLATION"]),
    )
    expect([...seen.updates]).toEqual(
      expect.arrayContaining(["applied", "refused CANOPY_POLICY_VIOLATION", "no match"]),
    )
  }, 600_000)
})
