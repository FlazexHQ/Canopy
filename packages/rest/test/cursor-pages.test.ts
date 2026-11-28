import { randomUUID } from "node:crypto"
import { Authenticator } from "@canopy/auth"
import { allow, auth, collection, createPolicySet } from "@canopy/policy"
import { describeWithMongo, MONGODB_URI, testPolicyEngine } from "@canopy/testing"
import fc from "fast-check"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { BSON, Collection, type Db, type Document, MongoClient, type Sort } from "mongodb"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { EXACT_BSON, toDriver } from "../src/driver.ts"
import {
  createRestHandler,
  cursorKeys,
  cursorQueryHash,
  decodeCursor,
  encodeCursor,
  keysetFilter,
  positionOf,
  type RestHandler,
} from "../src/index.ts"

const OID_A = new BSON.ObjectId("000000000000000000000001")
const OID_B = new BSON.ObjectId("000000000000000000000002")

/**
 * Sort values from every bracket keyset pagination supports, chosen to collide: numbers of all four types that
 * are equal, NaN of both floating point types, negative zero, strings and symbols that compare equal, and
 * values on both sides of every bracket border.
 */
const POOL: readonly unknown[] = [
  new BSON.Double(Number.NaN),
  BSON.Decimal128.fromString("NaN"),
  new BSON.Double(Number.NEGATIVE_INFINITY),
  BSON.Decimal128.fromString("-Infinity"),
  new BSON.Double(Number.POSITIVE_INFINITY),
  new BSON.Int32(-3),
  new BSON.Double(-0),
  new BSON.Int32(0),
  new BSON.Double(0.5),
  new BSON.Int32(1),
  BSON.Long.fromNumber(1),
  new BSON.Double(1),
  BSON.Decimal128.fromString("1.0"),
  BSON.Long.fromBigInt(2n ** 60n),
  new BSON.Double(2 ** 60),
  "",
  "a",
  "b",
  "ab",
  "B",
  "é",
  new BSON.BSONSymbol(""),
  new BSON.BSONSymbol("a"),
  new BSON.BSONSymbol("ab"),
  new BSON.BSONSymbol("é"),
  null,
  true,
  false,
  new Date(-5),
  new Date(0),
  new Date(1000),
  OID_A,
  OID_B,
  { x: 1 },
  { x: 2 },
  { y: 1 },
  {},
  { x: { z: 1 } },
  new BSON.Binary(Buffer.from([1])),
  new BSON.Binary(Buffer.from([1, 2])),
  new BSON.Binary(Buffer.from([2])),
  new BSON.MinKey(),
  new BSON.MaxKey(),
]

const FIELDS = ["a", "b", "n.v"] as const

const sortValue: fc.Arbitrary<unknown> = fc.oneof(
  { weight: 1, arbitrary: fc.constant(undefined) },
  { weight: 6, arbitrary: fc.integer({ min: 0, max: POOL.length - 1 }).map((i) => POOL[i]) },
)

interface Scenario {
  readonly docs: readonly {
    readonly a: unknown
    readonly b: unknown
    readonly nv: unknown
    readonly kind: number
  }[]
  readonly sort: readonly (readonly [string, 1 | -1])[]
  readonly limit: number
}

const scenario: fc.Arbitrary<Scenario> = fc.record({
  docs: fc.array(
    fc.record({ a: sortValue, b: sortValue, nv: sortValue, kind: fc.integer({ min: 0, max: 6 }) }),
    { maxLength: 30 },
  ),
  sort: fc
    .uniqueArray(fc.constantFrom<string>(...FIELDS, "_id"), { maxLength: 3 })
    .chain((paths) =>
      fc
        .array(fc.constantFrom<1 | -1>(1, -1), { minLength: paths.length, maxLength: paths.length })
        .map((directions) => paths.map((path, i) => [path, directions[i] ?? 1] as const)),
    ),
  limit: fc.integer({ min: 1, max: 7 }),
})

/** Ids of every type that compares distinct from the others, so any mix is a valid collection. */
function mixedId(kind: number, seq: number): unknown {
  switch (kind) {
    case 0:
      return new BSON.Int32(seq)
    case 1:
      return BSON.Long.fromNumber(1000 + seq)
    case 2:
      return seq + 0.5
    case 3:
      return `s${seq}`
    case 4:
      return new BSON.ObjectId(seq.toString(16).padStart(24, "0"))
    case 5:
      return new Date(100_000 + seq)
    default:
      return new BSON.Binary(Buffer.from([seq]))
  }
}

function documentsOf(
  docs: Scenario["docs"],
  idOf: (kind: number, seq: number) => unknown,
): Document[] {
  return docs.map((doc, seq) => {
    const out: Document = { _id: idOf(doc.kind, seq), seq }
    if (doc.a !== undefined) out["a"] = doc.a
    if (doc.b !== undefined) out["b"] = doc.b
    if (doc.nv !== undefined) out["n"] = { v: doc.nv }
    return out
  })
}

const sequence = (docs: readonly Document[]): number[] => docs.map((doc) => Number(doc["seq"]))

/**
 * Reads pages the way the read path does: one more document than the limit to know whether there is a next
 * page, the next position through a cursor, and the filter the keyset builder returns converted for the driver.
 */
async function walk(
  coll: Collection<Document>,
  spec: Readonly<Record<string, 1 | -1>>,
  limit: number,
): Promise<number[]> {
  const keys = cursorKeys(spec)
  const sort = Object.fromEntries(keys.map((key) => [key.path, key.direction])) as Sort
  const hash = cursorQueryHash(coll.collectionName, {}, keys)
  const seen: number[] = []
  let after: unknown[] | undefined
  for (let pages = 0; pages < 100; pages += 1) {
    const filter = after === undefined ? {} : toDriver(keysetFilter(keys, after))
    const raw = await coll.find(filter, { sort, limit: limit + 1, ...EXACT_BSON }).toArray()
    const page = raw.slice(0, limit)
    seen.push(...sequence(page))
    const last = page.at(-1)
    if (raw.length <= limit || last === undefined) return seen
    after = decodeCursor(encodeCursor({ values: positionOf(last, keys) }, hash), keys, hash)
  }
  throw new Error("The walk did not end")
}

const reference = async (coll: Collection<Document>, spec: Readonly<Record<string, 1 | -1>>) => {
  const keys = cursorKeys(spec)
  const sort = Object.fromEntries(keys.map((key) => [key.path, key.direction])) as Sort
  return sequence(await coll.find({}, { sort, ...EXACT_BSON }).toArray())
}

describeWithMongo("keyset pages against MongoDB's own sort order", (mongo) => {
  const walkEqualsFind = async (
    docs: readonly Document[],
    spec: Readonly<Record<string, 1 | -1>>,
    limit: number,
  ): Promise<void> => {
    const coll = mongo().collection<Document>("pages")
    await coll.deleteMany({})
    if (docs.length > 0) await coll.insertMany([...docs])
    const expected = await reference(coll, spec)
    expect(expected.length).toBe(docs.length)
    expect(await walk(coll, spec, limit)).toEqual(expected)
  }

  it("walks every page of generated collections with mixed types, in the order of one find", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async ({ docs, sort, limit }) => {
        await walkEqualsFind(documentsOf(docs, mixedId), Object.fromEntries(sort), limit)
      }),
      { numRuns: 150 },
    )
  }, 300_000)

  it("walks NaN, negative zero, equal numbers of every type, null and missing in both directions", async () => {
    const values: unknown[] = [
      new BSON.Double(Number.NaN),
      BSON.Decimal128.fromString("NaN"),
      new BSON.Double(Number.NEGATIVE_INFINITY),
      new BSON.Int32(-1),
      new BSON.Double(-0),
      new BSON.Int32(0),
      BSON.Long.fromNumber(0),
      new BSON.Int32(5),
      new BSON.Double(5),
      BSON.Decimal128.fromString("5"),
      new BSON.Double(Number.POSITIVE_INFINITY),
      null,
      undefined,
      "s",
      new Date(0),
    ]
    const docs = values.map((a, kind) => ({ a, b: undefined, nv: undefined, kind: kind % 7 }))
    for (const direction of [1, -1] as const)
      for (const limit of [1, 2, 3, 20])
        await walkEqualsFind(documentsOf(docs, mixedId), { a: direction }, limit)
  }, 60_000)

  it("selects nothing past the last document and every document before the first", async () => {
    const docs = documentsOf(
      POOL.map((a, kind) => ({ a, b: undefined, nv: undefined, kind: kind % 7 })),
      mixedId,
    )
    const coll = mongo().collection<Document>("bounds")
    await coll.deleteMany({})
    await coll.insertMany(docs)
    for (const direction of [1, -1] as const) {
      const keys = cursorKeys({ a: direction })
      const sort = Object.fromEntries(keys.map((key) => [key.path, key.direction])) as Sort
      const ordered = await coll.find({}, { sort, ...EXACT_BSON }).toArray()
      for (const [index, doc] of ordered.entries()) {
        const filter = toDriver(keysetFilter(keys, positionOf(doc, keys)))
        const rest = await coll.find(filter, { sort, ...EXACT_BSON }).toArray()
        expect(sequence(rest), `after document ${index}`).toEqual(
          sequence(ordered.slice(index + 1)),
        )
      }
    }
  }, 120_000)
})

const ISSUER = "https://idp.example.test/"
const PUBLISHABLE = "canopy_pk_test"
const SECRET = "canopy_sk_test"
const BASE = "http://canopy.test/rest/v1"

const items = collection("items", { exposed: true, policies: [allow.read("public")] })
const orders = collection("orders", {
  exposed: true,
  policies: [allow.read("authenticated").where({ ownerId: auth("sub") })],
})

const suite = MONGODB_URI === undefined ? describe.skip : describe

suite("keyset pages through the REST read path", () => {
  const dbName = `canopy_rest_pages_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  const OWNERS = 24
  const PER_OWNER = 800
  const LIMIT = 20
  let client: MongoClient
  let db: Db
  let rest: RestHandler
  const tokens = new Map<string, string>()
  const ordered = new Map<string, Document[]>()

  beforeAll(async () => {
    client = new MongoClient(MONGODB_URI ?? "")
    await client.connect()
    db = client.db(dbName)
    const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" })
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "EdDSA", use: "sig" }
    for (let owner = 0; owner < OWNERS; owner += 1)
      tokens.set(
        `u${owner}`,
        await new SignJWT({ sub: `u${owner}` })
          .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
          .setIssuer(ISSUER)
          .setIssuedAt()
          .setExpirationTime("30m")
          .sign(pair.privateKey),
      )
    let state = 12345
    const random = (): number => {
      state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff
      return state / 0x7fffffff
    }
    const docs: Document[] = []
    for (let owner = 0; owner < OWNERS; owner += 1)
      for (let n = 0; n < PER_OWNER; n += 1)
        docs.push({
          _id: owner * PER_OWNER + n + 1,
          ownerId: `u${owner}`,
          createdAt: new Date(1_700_000_000_000 + Math.floor(random() * 1e9) * 1000),
        })
    await db.collection("orders").insertMany(docs)
    await db.collection("orders").createIndex({ ownerId: 1, createdAt: -1, _id: 1 })
    rest = createRestHandler({
      client,
      database: dbName,
      policies: testPolicyEngine(createPolicySet([items, orders])),
      authenticator: new Authenticator(
        { jwks: { keys: [jwk] }, issuer: ISSUER },
        { publishable: [PUBLISHABLE], secret: [SECRET] },
      ),
    })
  }, 120_000)

  afterAll(async () => {
    await db.dropDatabase()
    await client.close()
  })

  it("walks generated collections page by page through the REST endpoint, in the order of one find", async () => {
    const coll = db.collection<Document>("items")
    await fc.assert(
      fc.asyncProperty(scenario, async ({ docs, sort, limit }) => {
        await coll.deleteMany({})
        const plain = documentsOf(docs, (_kind, seq) => new BSON.Int32(seq + 1))
        if (plain.length > 0) await coll.insertMany(plain)
        const spec = Object.fromEntries(sort)
        const expected = await reference(coll, spec)
        const text = sort
          .map(([path, direction]) => `${direction === -1 ? "-" : ""}${path}`)
          .join(",")
        const seen: number[] = []
        let next: string | null = null
        for (let pages = 0; pages < 100; pages += 1) {
          const query: string = `limit=${limit}${text === "" ? "" : `&sort=${text}`}${next === null ? "" : `&after=${next}`}&fields=seq`
          const response = await rest.fetch(
            new Request(`${BASE}/items?${query}`, { headers: { apikey: PUBLISHABLE } }),
          )
          expect(response.status).toBe(200)
          const body = (await response.json()) as {
            data: { seq: number }[]
            page: { next: string | null }
          }
          seen.push(...body.data.map((doc) => doc.seq))
          next = body.page.next
          if (next === null) break
        }
        expect(seen).toEqual(expected)
      }),
      { numRuns: 40 },
    )
  }, 300_000)

  describe("plans of the owner policy read sorted by -createdAt", () => {
    const keys = cursorKeys({ createdAt: -1 })
    const hash = cursorQueryHash("orders", {}, keys)

    const documentsOfOwner = async (owner: string): Promise<Document[]> => {
      let docs = ordered.get(owner)
      if (docs === undefined) {
        docs = await db
          .collection("orders")
          .find({ ownerId: owner }, { sort: { createdAt: -1, _id: 1 } })
          .toArray()
        ordered.set(owner, docs)
      }
      return docs
    }

    /** One page after `depth` pages of the owner; returns what MongoDB reports it examined. */
    const page = async (owner: string, depth: number) => {
      const docs = await documentsOfOwner(owner)
      const last = docs[depth * LIMIT - 1]
      if (last === undefined) throw new Error("The owner has fewer documents")
      const cursor = encodeCursor({ values: positionOf(last, keys) }, hash)
      const profile = db.collection("system.profile")
      const comment = `cursorPage:${randomUUID()}`
      const find = Collection.prototype.find
      const tagged = vi.spyOn(Collection.prototype, "find").mockImplementation(function (
        this: Collection,
        filter,
        options,
      ) {
        return find.call(
          this,
          filter,
          this.dbName === dbName && this.collectionName === "orders"
            ? { ...options, comment }
            : options,
        )
      })
      let response: Response
      try {
        response = await rest.fetch(
          new Request(`${BASE}/orders?sort=-createdAt&limit=${LIMIT}&after=${cursor}`, {
            headers: { apikey: PUBLISHABLE, authorization: `Bearer ${tokens.get(owner)}` },
          }),
        )
      } finally {
        tagged.mockRestore()
      }
      expect(response.status).toBe(200)
      const body = (await response.json()) as { data: { _id: number }[] }
      expect(body.data.map((doc) => doc._id)).toEqual(
        docs.slice(depth * LIMIT, (depth + 1) * LIMIT).map((doc) => Number(doc["_id"])),
      )
      const ns = `${dbName}.orders`
      const match = {
        ns,
        "command.find": "orders",
        "command.comment": comment,
        errCode: { $exists: false },
      }
      let entry: Document | null = await profile.findOne(match)
      if (entry === null) {
        const { log } = (await client.db("admin").command({ getLog: "global" })) as {
          log: string[]
        }
        for (const line of log) {
          if (!line.includes(comment)) continue
          const event = JSON.parse(line) as {
            msg: string
            attr?: Document & { command?: { find?: string; comment?: string } }
          }
          const query = event.attr
          if (
            event.msg === "Slow query" &&
            query?.["ns"] === ns &&
            query.command?.find === "orders" &&
            query.command.comment === comment &&
            query["errCode"] === undefined
          ) {
            entry = query
            break
          }
        }
      }
      const deadline = performance.now() + 30_000
      while (entry === null && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        entry = await profile.findOne(match)
      }
      if (entry === null)
        throw new Error(`MongoDB recorded no query for ${owner} at depth ${depth} (${comment})`)
      return {
        keys: Number(entry["keysExamined"]),
        docs: Number(entry["docsExamined"]),
        returned: Number(entry["nreturned"]),
        plan: String(entry["planSummary"]),
      }
    }

    beforeAll(async () => {
      await db.command({
        profile: 1,
        filter: { ns: `${dbName}.orders`, "command.comment": /^cursorPage:/ },
      })
    })

    afterAll(async () => {
      await db.command({ profile: 0, filter: "unset" })
    })

    const expectTight = (
      measured: { keys: number; docs: number; returned: number; plan: string },
      label: string,
    ): void => {
      expect(measured.returned, label).toBe(LIMIT + 1)
      expect(measured.plan, label).toContain("IXSCAN")
      expect(measured.keys, `${label}: keys examined`).toBeLessThanOrEqual(measured.returned + 2)
      expect(measured.docs, `${label}: documents examined`).toBeLessThanOrEqual(
        measured.returned + 1,
      )
    }

    it("examines only the page at the second page and at a deep page, with a cold plan cache", async () => {
      for (const depth of [1, 2, 10, 30]) {
        await db.command({ planCacheClear: "orders" })
        expectTight(await page("u3", depth), `depth ${depth}`)
      }
    }, 120_000)

    it("examines only the page at a deep page after shallow pages of the same shape cached their plan", async () => {
      for (const depth of [2, 5, 8, 12, 30, 35]) {
        await db.command({ planCacheClear: "orders" })
        for (let owner = 0; owner < OWNERS; owner += 1) await page(`u${owner}`, 1)
        expectTight(await page("u7", depth), `warm, depth ${depth}`)
      }
    }, 300_000)
  })
})
