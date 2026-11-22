import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { allow, auth, collection, createPolicySet } from "@canopy/policy"
import { type Canopy, createCanopy, defineConfig } from "@canopy/server"
import { MONGODB_URI, TEST_ENV } from "@canopy/testing"
import { ConflictError, type DocumentSchema, NotFoundError, PolicyViolationError } from "canopy.js"
import { type BatchOperation, createRestClient, type RestClient } from "canopy.js/rest"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

const suite = MONGODB_URI === undefined ? describe.skip : describe
const KEY = "pk_rest_writes"
const ISSUER = "https://idp.rest-writes.test/"
const AUDIENCE = "https://api.rest-writes.test"

interface Note {
  _id: string
  ownerId: string
  title: string
  meta: { color: string; size?: number }
  tags: string[]
  note?: string
}

type Db = DocumentSchema<{ notes: Note }>

const notes = collection("notes", {
  exposed: true,
  realtime: true,
  policies: [
    allow.read("authenticated").where({ ownerId: auth("sub") }),
    allow.insert("authenticated").check({ ownerId: auth("sub") }),
    allow
      .update("authenticated")
      .where({ ownerId: auth("sub") })
      .check({ ownerId: auth("sub") }),
    allow.delete("authenticated").where({ ownerId: auth("sub") }),
  ],
})

suite("REST merge patches and batches against the composed server", () => {
  const name = `canopy_rest_writes_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let mongo: MongoClient
  let canopy: Canopy
  let server: Server
  let url: string
  const tokens = new Map<string, string>()

  const stored = () => mongo.db(name).collection<Note>("notes")

  const writer = (sub: string, fetcher: typeof fetch = fetch): RestClient<Db> =>
    createRestClient<Db>({ url, publishableKey: KEY, fetch: fetcher, token: () => tokens.get(sub) })

  /** A fetch whose request reaches the server, but whose response the caller never sees. */
  const losing = (async (input: string | URL | Request, init?: RequestInit) => {
    await (await fetch(input, init)).text()
    throw new TypeError("the connection dropped before the response arrived")
  }) as typeof fetch

  beforeAll(async () => {
    const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" })
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "EdDSA" }
    for (const sub of ["alice", "bob"])
      tokens.set(
        sub,
        await new SignJWT({})
          .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
          .setIssuer(ISSUER)
          .setAudience(AUDIENCE)
          .setSubject(sub)
          .setExpirationTime("10m")
          .sign(pair.privateKey),
      )
    mongo = new MongoClient(MONGODB_URI ?? "")
    await mongo.connect()
    canopy = await createCanopy(
      defineConfig({
        mongodb: { uri: MONGODB_URI ?? "", database: name, metaDatabase: `${name}_meta` },
        auth: { kind: "external", jwks: { keys: [jwk] }, issuer: ISSUER, audience: AUDIENCE },
        keys: { publishable: [KEY] },
        realtime: { checkpoints: "off", drainWindow: "1s" },
        rateLimits: false,
      }),
      { env: TEST_ENV, policies: createPolicySet([notes]), onSetupToken: false },
    )
    server = createServer(canopy.node())
    await canopy.attach(server)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }, 120_000)

  beforeEach(async () => {
    await stored().deleteMany({})
    await stored().insertMany([
      {
        _id: "a1",
        ownerId: "alice",
        title: "Plan",
        meta: { color: "red", size: 2 },
        tags: ["x", "y"],
        note: "draft",
      },
      { _id: "b1", ownerId: "bob", title: "Bob's", meta: { color: "blue" }, tags: [] },
    ])
  })

  afterAll(async () => {
    await canopy?.close()
    server?.closeAllConnections()
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    await mongo?.db(name).dropDatabase()
    await mongo?.db(`${name}_meta`).dropDatabase()
    await mongo?.close()
  })

  it("merges subdocuments, replaces arrays and removes fields set to null", async () => {
    const result = await writer("alice")
      .from("notes")
      .patch("a1", { title: "Plan B", meta: { color: "green" }, tags: ["z"], note: null })
    const expected = {
      _id: "a1",
      ownerId: "alice",
      title: "Plan B",
      meta: { color: "green", size: 2 },
      tags: ["z"],
    }
    expect(result.data).toEqual(expected)
    expect(result.replayed).toBe(false)
    expect(typeof result.ct).toBe("string")
    expect(await stored().findOne({ _id: "a1" })).toEqual(expected)
  })

  it("keeps a failed where precondition as a conflict and changes nothing", async () => {
    const refused = await writer("alice")
      .from("notes")
      .patch("a1", { title: "Late" }, { where: { title: "Renamed by someone" } })
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    expect(refused).toBeInstanceOf(ConflictError)
    expect((await stored().findOne({ _id: "a1" }))?.title).toBe("Plan")
  })

  it("answers another user's document as not found", async () => {
    await expect(
      writer("alice").from("notes").patch("b1", { title: "Mine" }),
    ).rejects.toBeInstanceOf(NotFoundError)
    expect((await stored().findOne({ _id: "b1" }))?.title).toBe("Bob's")
  })

  it("replays a patch whose response was lost instead of applying it again", async () => {
    const key = `patch-${crypto.randomUUID()}`
    await expect(
      writer("alice", losing).from("notes").patch("a1", { title: "Once" }, { idempotencyKey: key }),
    ).rejects.toMatchObject({ code: "CANOPY_UNAVAILABLE" })
    expect((await stored().findOne({ _id: "a1" }))?.title).toBe("Once")
    await stored().updateOne({ _id: "a1" }, { $set: { title: "Changed since" } })
    const retry = await writer("alice")
      .from("notes")
      .patch("a1", { title: "Once" }, { idempotencyKey: key })
    expect(retry.replayed).toBe(true)
    expect((await stored().findOne({ _id: "a1" }))?.title).toBe("Changed since")
  })

  it("rolls an atomic batch back when one operation is refused", async () => {
    const refused = await writer("alice")
      .batch(
        [
          {
            op: "insert",
            c: "notes",
            doc: { _id: "a2", ownerId: "alice", title: "New", meta: { color: "red" }, tags: [] },
          },
          {
            op: "insert",
            c: "notes",
            doc: { _id: "a3", ownerId: "bob", title: "Forged", meta: { color: "red" }, tags: [] },
          },
        ],
        { atomic: true },
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    expect(refused).toBeInstanceOf(PolicyViolationError)
    expect(await stored().countDocuments({ _id: { $in: ["a2", "a3"] } })).toBe(0)
  })

  it("applies an atomic batch once, and replays it after a lost response", async () => {
    const key = `batch-${crypto.randomUUID()}`
    const ops: BatchOperation<Db>[] = [
      {
        op: "insert",
        c: "notes",
        doc: { _id: "a2", ownerId: "alice", title: "New", meta: { color: "red" }, tags: [] },
      },
      { op: "update", c: "notes", id: "a1", update: { $set: { title: "Batched" } } },
      { op: "delete", c: "notes", id: "b1" },
    ]
    await expect(
      writer("alice", losing).batch(ops, { atomic: true, idempotencyKey: key }),
    ).rejects.toMatchObject({
      code: "CANOPY_UNAVAILABLE",
    })
    await stored().updateOne({ _id: "a1" }, { $set: { title: "Changed since" } })
    const retry = await writer("alice").batch(ops, { atomic: true, idempotencyKey: key })
    expect(retry.replayed).toBe(true)
    expect(retry.results.map((result) => result.matched)).toEqual([0, 1, 0])
    expect(
      await stored()
        .find({}, { sort: { _id: 1 } })
        .project({ title: 1 })
        .toArray(),
    ).toEqual([
      { _id: "a1", title: "Changed since" },
      { _id: "a2", title: "New" },
      { _id: "b1", title: "Bob's" },
    ])
  })

  it("reports each outcome of a batch that is not atomic", async () => {
    const result = await writer("alice").batch(
      [
        {
          op: "insert",
          c: "notes",
          doc: { _id: "a2", ownerId: "alice", title: "New", meta: { color: "red" }, tags: [] },
        },
        {
          op: "insert",
          c: "notes",
          doc: { _id: "a3", ownerId: "bob", title: "Forged", meta: { color: "red" }, tags: [] },
        },
        {
          op: "update",
          c: "notes",
          id: "a1",
          update: { $set: { title: "Kept" } },
          where: { title: "Plan" },
        },
      ],
      { atomic: false },
    )
    const [inserted, forged, updated] = result.results
    expect(inserted).toMatchObject({ ok: true, data: { _id: "a2", title: "New" } })
    expect(forged?.ok).toBe(false)
    expect(forged?.ok === false ? forged.error : undefined).toBeInstanceOf(PolicyViolationError)
    expect(updated).toMatchObject({ ok: true, matched: 1, data: { title: "Kept" } })
    expect(await stored().countDocuments({ _id: "a2" })).toBe(1)
    expect(await stored().countDocuments({ _id: "a3" })).toBe(0)
  })
})
