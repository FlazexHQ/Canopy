import { allow, auth, collection, createPolicySet } from "@canopy/policy"
import { CanopyError, ErrorCode, Long, toCt } from "@canopy/protocol"
import { MONGODB_URI, testPolicyEngine } from "@canopy/testing"
import { BSON, type ChangeStreamDocument, type Db, type Document, MongoClient } from "mongodb"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { type Caller, WritePath, type WriteRequest } from "../src/index.ts"

const owned = collection("owned", {
  exposed: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub"), hidden: { $ne: true } }),
    allow.insert("authenticated").check({ ownerId: auth("sub") }),
    allow.update("authenticated").where({ ownerId: auth("sub") }),
  ],
  fields: { read: { default: { omit: ["secret"] } } },
})

const tiered = collection("tiered", {
  exposed: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub") }),
    allow
      .update("authenticated")
      .where({ ownerId: auth("sub") })
      .check({ ownerId: auth("sub"), n: { $lt: 10 }, status: { $in: ["open", "closed"] } }),
    allow.read("admin"),
    allow.update("admin").check({ n: { $gte: 0 } }),
  ],
})

const clocked = collection("clocked", {
  exposed: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub") }),
    allow
      .update("authenticated")
      .where({ ownerId: auth("sub") })
      .check({ ownerId: auth("sub"), $expr: { $lte: ["$createdAt", "$$NOW"] } }),
  ],
})

const validated = collection("validated", {
  exposed: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub") }),
    allow.update("authenticated").where({ ownerId: auth("sub") }),
  ],
})

const unique = collection("unique", {
  exposed: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub") }),
    allow.update("authenticated").where({ ownerId: auth("sub") }),
  ],
})

const folded = collection("folded", {
  exposed: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub") }),
    allow.insert("authenticated").check({ ownerId: auth("sub"), tag: { $ne: "A" } }),
    allow
      .update("authenticated")
      .where({ ownerId: auth("sub") })
      .check({ ownerId: auth("sub"), tag: { $ne: "A" } }),
  ],
})

const open = collection("open", {
  exposed: true,
  policies: [allow.read("editor"), allow.update("editor")],
})

const NAMES = ["owned", "tiered", "clocked", "validated", "unique", "folded", "open"] as const

const suite = MONGODB_URI === undefined ? describe.skip : describe

function user(sub: string, ...roles: string[]): Caller {
  return {
    context: { roles: new Set(["authenticated", ...roles]), claims: { sub }, now: new Date() },
    subject: sub,
  }
}

const service: Caller = {
  context: { roles: new Set(["service"]), claims: null, now: new Date() },
  subject: "service",
}

/** Canonical EJSON: exact BSON types and field order, so any difference between two documents shows. */
function exact(value: unknown): string {
  return BSON.EJSON.stringify(value, { relaxed: false })
}

/** A deterministic generator, so a failing case can be replayed from its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const COMMANDS = new Set([
  "insert",
  "update",
  "find",
  "aggregate",
  "commitTransaction",
  "abortTransaction",
])

/** What a write did, as a string: its outcome or its error, with everything a caller can observe. */
interface Seen {
  readonly text: string
  readonly kind: string
}

function describeResult(outcome: { result: unknown } | { error: unknown }): Seen {
  if ("error" in outcome) {
    const error = outcome.error
    if (!(error instanceof CanopyError)) throw error
    return {
      kind: error.code,
      text: exact({ code: error.code, message: error.message, details: error.details ?? null }),
    }
  }
  const { ct: _ct, ...rest } = outcome.result as Document
  const kind =
    (rest["upsertedId"] as unknown) !== undefined
      ? "upserted"
      : rest["matched"] === 0
        ? "unmatched"
        : rest["modified"] === 0
          ? "unchanged"
          : "replaced"
  return { kind, text: exact(rest) }
}

suite("replace without a transaction, against MongoDB", () => {
  const dbName = `canopy_replace_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  const oracleName = `${dbName}_oracle`
  let client: MongoClient
  let db: Db
  let oracleDb: Db
  let writes: WritePath
  let oracle: WritePath
  const alice = user("alice")
  const bob = user("bob")
  const admin = user("carol", "admin")
  const editor = user("ed", "editor")

  async function commands<T>(
    body: () => Promise<T>,
    database = dbName,
  ): Promise<{ value: T; names: string[] }> {
    const names: string[] = []
    const listener = (event: { commandName: string; databaseName: string }): void => {
      if (
        COMMANDS.has(event.commandName) &&
        (event.databaseName === database || event.commandName.endsWith("Transaction"))
      )
        names.push(event.commandName)
    }
    client.on("commandStarted", listener)
    try {
      return { value: await body(), names }
    } finally {
      client.off("commandStarted", listener)
    }
  }

  const replace = (
    id: unknown,
    doc: Document,
    name = "owned",
    extra: Document = {},
  ): WriteRequest => ({ op: "replace", collection: name, id, doc, ...extra }) as WriteRequest

  let sequence = 0
  /** The transactional path of the same write: a mutation ID always runs a transaction. */
  const inTransaction = (caller: Caller, request: WriteRequest) =>
    oracle.execute(caller, request, { mutationId: `oracle-${process.pid}-${sequence++}` })

  beforeAll(async () => {
    client = new MongoClient(MONGODB_URI ?? "", { monitorCommands: true })
    await client.connect()
    db = client.db(dbName)
    oracleDb = client.db(oracleName)
    const engine = testPolicyEngine(
      createPolicySet([owned, tiered, clocked, validated, unique, folded, open]),
    )
    writes = new WritePath({
      client,
      database: dbName,
      metaDatabase: `${dbName}_meta`,
      policies: engine,
    })
    oracle = new WritePath({
      client,
      database: oracleName,
      metaDatabase: `${dbName}_oracle_meta`,
      policies: engine,
    })
    for (const target of [db, oracleDb]) {
      for (const name of NAMES) {
        if (name === "folded")
          await target.createCollection(name, { collation: { locale: "en", strength: 2 } })
        else if (name === "validated")
          await target.createCollection(name, {
            validator: { $jsonSchema: { properties: { label: { bsonType: "string" } } } },
          })
        else await target.createCollection(name)
      }
      await target.collection("unique").createIndex({ email: 1 }, { unique: true, sparse: true })
    }
  })

  afterAll(async () => {
    await db.dropDatabase()
    await oracleDb.dropDatabase()
    await client.db(`${dbName}_meta`).dropDatabase()
    await client.db(`${dbName}_oracle_meta`).dropDatabase()
    await client.close()
  })

  beforeEach(async () => {
    for (const target of [db, oracleDb])
      for (const name of NAMES) await target.collection(name).deleteMany({})
  })

  const seedBoth = async (name: string, docs: Document[]): Promise<void> => {
    await db.collection(name).insertMany(docs.map((doc) => ({ ...doc })))
    await oracleDb.collection(name).insertMany(docs.map((doc) => ({ ...doc })))
  }

  describe("commands", () => {
    it("replaces under the owner policy with a check and the write, no transaction", async () => {
      await seedBoth("owned", [{ _id: 1, ownerId: "alice", n: 1, secret: "s" }])
      const { value, names } = await commands(() =>
        writes.execute(alice, replace(1, { ownerId: "alice", n: 2, secret: "t" })),
      )
      expect(names).toEqual(["aggregate", "update"])
      expect(value.matched).toBe(1)
      expect(value.modified).toBe(1)
      expect(value.changedIds).toEqual([1])
      expect(JSON.parse(exact(value.documents))).toEqual([
        { _id: { $numberInt: "1" }, ownerId: "alice", n: { $numberInt: "2" } },
      ])
      expect(exact(await db.collection("owned").findOne({ _id: 1 as never }))).toBe(
        exact({ _id: 1, ownerId: "alice", n: 2, secret: "t" }),
      )
    })

    it("keeps the transaction in a mutation ID, and says why in the commands", async () => {
      await seedBoth("owned", [{ _id: 1, ownerId: "alice", n: 1 }])
      const { names } = await commands(() =>
        writes.execute(alice, replace(1, { ownerId: "alice", n: 2 }), {
          mutationId: "mutation-0001",
        }),
      )
      expect(names).toEqual(["update", "aggregate", "commitTransaction"])
    })

    it("refuses a replacement that fails the check without storing anything", async () => {
      await seedBoth("owned", [{ _id: 1, ownerId: "alice", n: 1 }])
      const { value, names } = await commands(() =>
        writes.execute(alice, replace(1, { ownerId: "bob", n: 2 })).then(
          () => undefined,
          (error: unknown) => error,
        ),
      )
      expect(value).toBeInstanceOf(CanopyError)
      expect((value as CanopyError).code).toBe(ErrorCode.PolicyViolation)
      expect(names).toEqual(["aggregate", "update", "aggregate", "abortTransaction"])
      expect(await db.collection("owned").findOne({ _id: 1 as never })).toEqual({
        _id: 1,
        ownerId: "alice",
        n: 1,
      })
    })

    it("reports a missing target as not found, even when the replacement would fail the check", async () => {
      await seedBoth("owned", [{ _id: 1, ownerId: "alice" }])
      const gone = await writes.execute(alice, replace(9, { ownerId: "bob" }))
      expect(gone.matched).toBe(0)
      expect(gone.changedIds).toEqual([])
      const foreign = await writes.execute(bob, replace(1, { ownerId: "alice" }))
      expect(foreign.matched).toBe(0)
      expect(await db.collection("owned").countDocuments()).toBe(1)
    })

    it("accepts a replacement identical to a stored document that fails the check", async () => {
      await seedBoth("tiered", [{ _id: 1, ownerId: "alice", n: 50, status: "open" }])
      const result = await writes.execute(
        alice,
        replace(1, { _id: 1, ownerId: "alice", n: 50, status: "open" }, "tiered"),
      )
      expect(result.matched).toBe(1)
      expect(result.modified).toBe(0)
      expect(result.changedIds).toEqual([])
      await expect(
        writes.execute(
          alice,
          replace(1, { _id: 1, ownerId: "alice", n: 51, status: "open" }, "tiered"),
        ),
      ).rejects.toMatchObject({ code: ErrorCode.PolicyViolation })
    })

    it("returns the cluster time of the write, the one of its change event", async () => {
      await seedBoth("owned", [{ _id: 1, ownerId: "alice", n: 1 }])
      const stream = db.collection("owned").watch([])
      try {
        await stream.tryNext()
        const result = await writes.execute(alice, replace(1, { ownerId: "alice", n: 2 }))
        const event = (await stream.next()) as ChangeStreamDocument
        expect(event.operationType).toBe("replace")
        expect(result.ct).toBe(toCt(event.clusterTime))
      } finally {
        await stream.close()
      }
    })

    it("stores the replacement as a transaction would: _id first, as the target's type", async () => {
      await seedBoth("owned", [{ _id: new BSON.Int32(7), ownerId: "alice" }])
      const result = await writes.execute(
        alice,
        replace(new Long(7), { n: 1, ownerId: "alice", _id: new Long(7) }),
      )
      expect(result.matched).toBe(1)
      expect(exact(result.documents)).toBe(
        exact([{ _id: BSON.Long.fromNumber(7), n: 1, ownerId: "alice" }]),
      )
      expect(exact(await db.collection("owned").findOne({}, { promoteValues: false }))).toBe(
        exact({ _id: BSON.Long.fromNumber(7), n: 1, ownerId: "alice" }),
      )
    })
  })

  describe("where it keeps the transaction", () => {
    const keeps = async (caller: Caller, request: WriteRequest): Promise<string[]> => {
      await writes.execute(caller, request)
      const { names } = await commands(() => writes.execute(caller, request))
      return names
    }

    it("for an upsert, a replacement too large to check twice, and a check that reads the clock", async () => {
      await seedBoth("owned", [{ _id: 1, ownerId: "alice" }])
      const upsert = await commands(() =>
        writes.execute(alice, replace(2, { ownerId: "alice" }, "owned", { upsert: true })),
      )
      expect(upsert.names).toContain("commitTransaction")
      expect(upsert.value.upsertedId).toBe(2)

      const large = await commands(() =>
        writes.execute(alice, replace(1, { ownerId: "alice", big: "x".repeat(9 * 1024 * 1024) })),
      )
      expect(large.names).toContain("commitTransaction")

      await seedBoth("clocked", [{ _id: 1, ownerId: "alice", createdAt: new Date(0) }])
      const clock = await commands(() =>
        writes.execute(alice, replace(1, { ownerId: "alice", createdAt: new Date(1) }, "clocked")),
      )
      expect(clock.names).toEqual(["update", "aggregate", "commitTransaction"])
      await expect(
        writes.execute(
          alice,
          replace(1, { ownerId: "alice", createdAt: new Date(Date.now() + 3_600_000) }, "clocked"),
        ),
      ).rejects.toMatchObject({ code: ErrorCode.PolicyViolation })
    })

    it("checks a replacement with the collection's collation before writing it", async () => {
      await seedBoth("folded", [{ _id: 1, ownerId: "alice", tag: "x" }])
      const names = await keeps(alice, replace(1, { ownerId: "alice", tag: "y" }, "folded"))
      expect(names).toEqual(["aggregate", "update"])
      await expect(
        writes.execute(alice, replace(1, { ownerId: "alice", tag: "a" }, "folded")),
      ).rejects.toMatchObject({ code: ErrorCode.PolicyViolation })
      expect(await db.collection("folded").findOne({})).toMatchObject({ tag: "y" })
    })

    it("does not insert a document that a collation makes fail the check", async () => {
      await expect(
        writes.execute(alice, {
          op: "insert",
          collection: "folded",
          doc: { _id: 5, ownerId: "alice", tag: "a" },
        }),
      ).rejects.toMatchObject({ code: ErrorCode.PolicyViolation })
      expect(await db.collection("folded").countDocuments()).toBe(0)
      const fine = await commands(() =>
        writes.execute(alice, {
          op: "insert",
          collection: "folded",
          doc: { _id: 6, ownerId: "alice", tag: "b" },
        }),
      )
      expect(fine.names).toEqual(["aggregate", "insert"])
      expect(await db.collection("folded").countDocuments()).toBe(1)
    })

    it("takes the fast path of a role whose check is empty, and of service", async () => {
      await seedBoth("open", [{ _id: 1 }])
      const asEditor = await commands(() => writes.execute(editor, replace(1, { a: 1 }, "open")))
      expect(asEditor.names).toEqual(["update", "find"])
      const asService = await commands(() => writes.execute(service, replace(1, { a: 2 }, "open")))
      expect(asService.names).toEqual(["update", "find"])
    })
  })

  describe("against the transactional path", () => {
    it("decides every generated replacement as the transaction does", async () => {
      const callers = [alice, bob, admin]
      const names = ["owned", "tiered", "validated", "unique"] as const
      const runs = Number(process.env["CANOPY_DIFF_RUNS"] ?? 60)
      const kinds = new Map<string, number>()
      let direct = 0
      let transactional = 0
      for (let seed = 1; seed <= runs; seed++) {
        const next = random(seed)
        const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T
        for (const target of [db, oracleDb])
          for (const name of NAMES) await target.collection(name).deleteMany({})
        for (const name of names) {
          const seeded: Document[] = []
          for (let id = 1; id <= 8; id++)
            seeded.push({
              _id: id,
              ownerId: pick(["alice", "alice", "bob", "carol"]),
              n: Math.floor(next() * 16),
              status: pick(["open", "closed", "archived"]),
              secret: "s",
              ...(next() < 0.2 ? { hidden: true } : {}),
              ...(name === "unique" ? { email: `e${id}` } : {}),
              ...(name === "validated" ? { label: pick(["a", "b"]) } : {}),
            })
          await seedBoth(name, seeded)
        }
        for (let step = 0; step < 8; step++) {
          const caller = pick(callers)
          const name = pick(names)
          const id: unknown = pick([
            1,
            2,
            3,
            4,
            5,
            6,
            7,
            8,
            9,
            new Long(1 + Math.floor(next() * 8)),
            2.0,
          ])
          const stored = await oracleDb
            .collection(name)
            .findOne({ _id: typeof id === "number" ? id : Number(String(id)) } as Document)
          const same = stored !== null && next() < 0.3
          const doc: Document =
            same && stored !== null
              ? { ...stored }
              : {
                  ownerId: pick(["alice", "bob", "carol"]),
                  n: Math.floor(next() * 16),
                  status: pick(["open", "closed", "archived"]),
                  ...(next() < 0.3 ? { secret: "t" } : {}),
                  ...(next() < 0.2 ? { hidden: true } : {}),
                  ...(name === "unique" ? { email: pick(["e1", "e2", "e3", "e9"]) } : {}),
                  ...(name === "validated" ? { label: pick(["ok", "ok", 7]) } : {}),
                }
          if (!same && next() < 0.2) doc["_id"] = id
          const request = replace(
            same && stored !== null ? stored["_id"] : id,
            doc,
            name,
            next() < 0.15 ? { where: { n: { $gte: 8 } } } : {},
          )
          const outcome = await commands(() =>
            writes.execute(caller, request).then(
              (result) => ({ result }),
              (error: unknown) => ({ error }),
            ),
          )
          const expected = await inTransaction(caller, request).then(
            (result) => ({ result }),
            (error: unknown) => ({ error }),
          )
          const got = describeResult(outcome.value)
          const want = describeResult(expected)
          expect(got.text, `seed ${seed} step ${step} ${name}`).toBe(want.text)
          kinds.set(got.kind, (kinds.get(got.kind) ?? 0) + 1)
          if (outcome.names.some((command) => command.endsWith("Transaction"))) transactional += 1
          else direct += 1
          for (const collectionName of names) {
            const a = await db.collection(collectionName).find({}).sort({ _id: 1 }).toArray()
            const b = await oracleDb.collection(collectionName).find({}).sort({ _id: 1 }).toArray()
            expect(exact(a), `seed ${seed} step ${step} ${collectionName}`).toBe(exact(b))
          }
        }
      }
      for (const kind of [
        "replaced",
        "unchanged",
        "unmatched",
        ErrorCode.PolicyViolation,
        ErrorCode.Conflict,
        ErrorCode.DuplicateKey,
        ErrorCode.ValidationFailed,
      ])
        expect(kinds.get(kind) ?? 0, kind).toBeGreaterThan(0)
      expect(direct).toBeGreaterThan(40)
      expect(transactional).toBeGreaterThan(5)
    }, 1_800_000)
  })
})
