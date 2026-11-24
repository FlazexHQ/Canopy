import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { allow, auth, collection, createPolicySet } from "@canopy/policy"
import { type Canopy, createCanopy, defineConfig } from "@canopy/server"
import { MONGODB_URI, TEST_ENV } from "@canopy/testing"
import {
  Decimal128,
  type DocumentSchema,
  InvalidQueryError,
  isCanopyError,
  Long,
  NotFoundError,
  ObjectId,
} from "canopy.js"
import { createRestClient, type RestClient } from "canopy.js/rest"
import { collection as defineCollection, t } from "canopy.js/schema"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import {
  Decimal128 as DriverDecimal,
  Long as DriverLong,
  ObjectId as DriverObjectId,
  MongoClient,
} from "mongodb"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  seedSplitPolicy,
  splitAudience,
  splitDatabase,
  splitIssuer,
  splitSigningKey,
  splitUrl,
} from "./split.ts"

const suite = MONGODB_URI === undefined ? describe.skip : describe
const KEY = "pk_rest_reader"
const ISSUER = "https://idp.rest-reader.test/"
const AUDIENCE = "https://api.rest-reader.test"

interface Item {
  _id: ObjectId
  ownerId: string
  title: string
  rank: number
  at: Date
  price: Decimal128
  big: number | Long
}

type Db = DocumentSchema<{ items: Item }>

const items = collection("items", {
  exposed: true,
  realtime: true,
  policies: [allow.read("authenticated").where({ ownerId: auth("sub") })],
})

const totals = defineCollection("totals", { _id: t.string(), n: t.int() })

suite("the REST reader against the composed server", () => {
  const name = splitUrl
    ? splitDatabase
    : `canopy_rest_reader_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let mongo: MongoClient
  let canopy: Canopy
  let server: Server
  let url: string
  const tokens = new Map<string, string>()
  const ids = new Map<string, DriverObjectId>()
  const bodies: unknown[] = []

  /** A fetch that keeps the raw response bodies, to compare with what the reader returns. */
  const recording = (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await fetch(input, init)
    bodies.push(JSON.parse(await response.clone().text()))
    return response
  }) as typeof fetch

  const reader = (sub: string): RestClient<Db> =>
    createRestClient<Db>({
      url,
      publishableKey: KEY,
      fetch: recording,
      token: () => tokens.get(sub),
    })

  beforeAll(async () => {
    const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" })
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "EdDSA" }
    for (const sub of ["alice", "bob"])
      tokens.set(
        sub,
        await new SignJWT({})
          .setProtectedHeader({ alg: "EdDSA", kid: splitUrl ? "dev" : "k1" })
          .setIssuer(splitUrl ? splitIssuer : ISSUER)
          .setAudience(splitUrl ? splitAudience : AUDIENCE)
          .setSubject(sub)
          .setExpirationTime("10m")
          .sign(splitUrl ? await splitSigningKey() : pair.privateKey),
      )
    mongo = new MongoClient(MONGODB_URI ?? "")
    await mongo.connect()
    if (splitUrl) {
      await seedSplitPolicy(mongo, items, {
        apikey: KEY,
        authorization: `Bearer ${tokens.get("alice")}`,
      })
      url = splitUrl
    }
    const docs = [
      ["a1", "alice", 1],
      ["a2", "alice", 2],
      ["a3", "alice", 3],
      ["b1", "bob", 1],
      ["b2", "bob", 2],
      ["b3", "bob", 3],
    ] as const
    await mongo
      .db(name)
      .collection("items")
      .insertMany(
        docs.map(([title, ownerId, rank]) => {
          const _id = new DriverObjectId()
          ids.set(title, _id)
          return {
            _id,
            ownerId,
            title,
            rank,
            at: new Date(Date.UTC(2026, 0, rank)),
            price: DriverDecimal.fromString(`${rank}.10`),
            big: DriverLong.fromString("9007199254740993"),
          }
        }),
      )
    if (splitUrl) return
    canopy = await createCanopy(
      defineConfig({
        mongodb: { uri: MONGODB_URI ?? "", database: name, metaDatabase: `${name}_meta` },
        auth: { kind: "external", jwks: { keys: [jwk] }, issuer: ISSUER, audience: AUDIENCE },
        keys: { publishable: [KEY] },
        realtime: { checkpoints: "off", drainWindow: "1s" },
        rateLimits: false,
      }),
      { env: TEST_ENV, policies: createPolicySet([items]), onSetupToken: false },
    )
    server = createServer(canopy.node())
    await canopy.attach(server)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }, 120_000)

  afterAll(async () => {
    if (splitUrl) {
      await mongo?.close()
      return
    }
    await canopy?.close()
    server?.closeAllConnections()
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    await mongo?.db(name).dropDatabase()
    await mongo?.db(`${name}_meta`).dropDatabase()
    await mongo?.close()
  })

  it("pages through only the caller's documents and follows the cursor", async () => {
    const query = reader("alice").from("items").sort({ rank: 1 }).limit(2).fields({ title: 1 })
    bodies.length = 0
    const first = await query.page({ count: "exact" })
    expect(first.data).toEqual([
      { _id: new ObjectId(ids.get("a1")?.toHexString()), title: "a1" },
      { _id: new ObjectId(ids.get("a2")?.toHexString()), title: "a2" },
    ])
    expect(first.page.total).toBe(3)
    expect(first.ct).toBe((bodies[0] as { ct: unknown }).ct)
    const next = first.page.next
    expect(typeof next).toBe("string")
    const second = await query.page({ after: next ?? "" })
    expect(second.data.map((doc) => doc.title)).toEqual(["a3"])
    expect(second.page.next).toBeNull()
    expect(second.ct).toBe((bodies[1] as { ct: unknown }).ct)

    const bobQuery = reader("bob").from("items").sort({ rank: 1 }).limit(2).fields({ title: 1 })
    const bob = await bobQuery.page()
    expect(bob.data.map((doc) => doc.title)).toEqual(["b1", "b2"])
    const bobNext = bob.page.next
    expect(typeof bobNext).toBe("string")
    const bobSecond = await bobQuery.page({ after: bobNext ?? "" })
    expect(bobSecond.data.map((doc) => doc.title)).toEqual(["b3"])
    expect(bobSecond.page.next).toBeNull()
  })

  it("round trips BSON values", async () => {
    const page = await reader("alice").from("items").find({ title: "a2" }).page()
    const [doc] = page.data
    expect(doc?.at).toEqual(new Date(Date.UTC(2026, 0, 2)))
    expect(doc?.price).toEqual(new Decimal128("2.10"))
    expect(doc?.big).toEqual(new Long(9007199254740993n))
    expect(doc?._id).toBeInstanceOf(ObjectId)
  })

  it("counts what each caller may read", async () => {
    expect((await reader("alice").from("items").count()).data).toEqual({ count: 3, exact: true })
    expect(
      (
        await reader("bob")
          .from("items")
          .count({ rank: { $gte: 1 } })
      ).data,
    ).toEqual({
      count: 3,
      exact: true,
    })
  })

  it("reads by id, and gives a typed 404 for a document the caller may not read", async () => {
    const id = new ObjectId(ids.get("a3")?.toHexString())
    const own = await reader("alice")
      .from("items")
      .findById(id, { fields: { rank: 1 } })
    expect(own.data).toEqual({ _id: id, rank: 3 })
    const other = await reader("bob")
      .from("items")
      .findById(id)
      .catch((reason: unknown) => reason)
    expect(other).toBeInstanceOf(NotFoundError)
    expect(typeof (other as NotFoundError).details?.["requestId"]).toBe("string")
  })

  it("reads distinct values and aggregates only the caller's documents", async () => {
    const ranks = await reader("alice").from("items").distinct("rank")
    expect([...ranks.data].sort()).toEqual([1, 2, 3])
    const titles = await reader("bob").from("items").distinct("title")
    expect([...titles.data].sort()).toEqual(["b1", "b2", "b3"])
    const total = await reader("alice")
      .from("items")
      .aggregate([{ $group: { _id: "$ownerId", n: { $sum: 1 } } }], {
        decode: totals,
      })
    expect(total.data).toEqual([{ _id: "alice", n: 3 }])
  })

  it("keeps the server's typed error for an invalid query", async () => {
    const error = await reader("alice")
      .from("items")
      .find({ $where: "true" } as never)
      .page()
      .catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(InvalidQueryError)
    expect(isCanopyError(error, "CANOPY_INVALID_QUERY")).toBe(true)
  })
})
