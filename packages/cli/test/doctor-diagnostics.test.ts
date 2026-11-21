import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { MONGODB_URI } from "@canopy/testing"
import { type Db, MongoClient, MongoNetworkError, ObjectId } from "mongodb"
import { describe, expect, it, vi } from "vitest"
import { run } from "../src/cli.ts"
import { doctor, sampledPaths } from "../src/commands.ts"

async function runDoctor(
  mongodbUri: string,
  extra: { database?: string; dir?: string } = {},
): Promise<{ code: number; lines: string[]; errors: string[] }> {
  const lines: string[] = []
  const errors: string[] = []
  const code = await doctor(
    {
      mongodbUri,
      database: extra.database ?? "canopy_doctor_diagnostics",
      ...(extra.dir === undefined ? {} : { dir: extra.dir }),
    },
    {
      log: (line) => lines.push(...line.split("\n")),
      error: (line) => errors.push(...line.split("\n")),
    },
  )
  return { code, lines, errors }
}

describe("canopy doctor diagnostics", () => {
  it.each([
    {
      probe: "available",
      lines: [
        "ok    search: 1 collections, 1 indexes ready",
        "warn  search index notes.vector is BUILDING",
      ],
    },
    { probe: "failed", lines: ["warn  search: could not be checked: MongoDB is unavailable"] },
  ])("reports the configured search probe when $probe", async ({ probe, lines }) => {
    const dir = await mkdtemp(join(tmpdir(), "canopy-doctor-"))
    const collection = vi.fn(() => ({
      aggregate: () => ({
        toArray: async () => {
          if (probe === "failed") throw new MongoNetworkError("private driver details")
          return [
            { name: "text", type: "search", status: "READY", queryable: true },
            { name: "vector", type: "vectorSearch", status: "BUILDING", queryable: false },
          ]
        },
        [Symbol.asyncDispose]: async () => {},
      }),
    }))
    try {
      await writeFile(
        join(dir, "config.mjs"),
        `export default {
        mongodb: { uri: "mongodb://localhost/test" },
        collections: { notes: { search: true }, photos: { search: false } }
      }`,
      )
      using _connect = vi
        .spyOn(MongoClient.prototype, "connect")
        .mockImplementation(async function (this: MongoClient) {
          return this
        })
      using _db = vi.spyOn(MongoClient.prototype, "db").mockReturnValue({
        command: async () => ({
          setName: "rs0",
          version: "8.0",
          featureCompatibilityVersion: { version: "8.0" },
        }),
        watch: () => ({ tryNext: async () => null, close: async () => {} }),
        listCollections: () => ({ toArray: async () => [] }),
        collection,
      } as unknown as Db)
      const log = vi.fn()
      const error = vi.fn()
      expect(await run(["doctor", "--config", "config.mjs"], {}, { log, error }, dir)).toBe(0)
      expect(error).not.toHaveBeenCalled()
      expect(collection.mock.calls).toEqual([["notes"]])
      expect(log.mock.calls.flat()).toEqual([
        "ok    connected to MongoDB",
        "ok    topology: replica set rs0",
        "ok    MongoDB 8.0",
        "ok    featureCompatibilityVersion 8.0",
        "ok    change streams can be opened on test",
        "warn  DLS is enforced by Canopy, not inside mongod: clients holding MongoDB credentials bypass it",
        ...lines,
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("explains an unreachable host with its fix", async () => {
    const result = await runDoctor("mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=300")
    expect(result.code).toBe(1)
    expect(result.errors).toEqual([
      "error CANOPY_UNAVAILABLE: cannot reach MongoDB",
      "  MongoDB at 127.0.0.1:1 did not accept a connection: the host is wrong or mongod is not running.",
      "  Fix: check that mongod is running and that the host and port of the connection string are right.",
      "       In Docker, use the service name instead of localhost.",
      "  Docs: errors/mongodb-unreachable",
    ])
  })

  const withMongo = MONGODB_URI === undefined ? it.skip : it

  withMongo("explains rejected credentials without printing them", async () => {
    const uri = new URL((MONGODB_URI ?? "").replace(/^mongodb:/, "http:"))
    uri.username = "nobody"
    uri.password = "not-the-password"
    uri.searchParams.set("serverSelectionTimeoutMS", "3000")
    const result = await runDoctor(uri.toString().replace(/^http:/, "mongodb:"))
    expect(result.code).toBe(1)
    expect(result.errors[0]).toBe("error CANOPY_UNAVAILABLE: MongoDB rejected the credentials")
    expect(result.errors.join("\n")).not.toContain("not-the-password")
    expect(result.errors.at(-1)).toBe("  Docs: errors/authentication-failed")
  })

  withMongo("reports the feature compatibility version of a healthy deployment", async () => {
    const result = await runDoctor(MONGODB_URI ?? "")
    expect(result.errors).toEqual([])
    expect(
      result.lines.some((line) => /^ok {4}featureCompatibilityVersion [78]\.\d$/.test(line)),
    ).toBe(true)
    expect(result.lines).toContainEqual(
      expect.stringMatching(
        /^ok {4}search: (0 collections, 0 indexes ready|Search is not available on this MongoDB deployment;)/,
      ),
    )
  })

  withMongo("warns about policy fields no sampled document has", async () => {
    const database = `canopy_doctor_fields_${process.pid}_${Math.floor(Math.random() * 1e6)}`
    const client = new MongoClient(MONGODB_URI ?? "")
    await client.connect()
    try {
      await client
        .db(database)
        .collection("todos")
        .insertOne({ ownerId: "u1", title: "t", done: false, archived: false, tags: ["a"] })
      const result = await runDoctor(MONGODB_URI ?? "", {
        database,
        dir: fileURLToPath(new URL("./fixtures/good", import.meta.url)),
      })
      expect(result.lines.filter((line) => line.includes("unknown-field"))).toEqual([
        "warn  warn   unknown-field  todos: fields.read.default.omit names the field internalNotes, which no sampled document of todos has",
      ])
    } finally {
      await client.db(database).dropDatabase()
      await client.close()
    }
  })
})

describe("sampledPaths", () => {
  it("lists nested and array paths and treats BSON values as leaves", () => {
    expect(
      sampledPaths([
        { _id: new ObjectId(), a: { b: 1, c: [{ d: 2 }, 3] } },
        { e: [[{ f: 1 }]], g: new Date(0) },
      ]),
    ).toEqual(["_id", "a", "a.b", "a.c", "a.c.d", "e", "e.f", "g"])
  })
})
