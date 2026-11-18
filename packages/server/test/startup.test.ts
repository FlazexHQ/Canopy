import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { allow, auth, collection, createPolicySet } from "@canopy/policy"
import { MONGODB_URI, TEST_ENV } from "@canopy/testing"
import { MongoClient } from "mongodb"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createCanopy, defineConfig } from "../src/index.ts"

const suite = MONGODB_URI === undefined ? describe.skip : describe

function recorder() {
  const lines: { level: string; message: string; fields: Record<string, unknown> }[] = []
  const at =
    (level: string) =>
    (fields: Record<string, unknown>, message?: string): void => {
      lines.push({ level, message: message ?? "", fields })
    }
  return {
    lines,
    logger: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") },
  }
}

describe("startup diagnostics", () => {
  it("explains an unreachable MongoDB with a formatted diagnostic", async () => {
    const { lines, logger } = recorder()
    const failure = await createCanopy(
      defineConfig({
        mongodb: { uri: "mongodb://127.0.0.1:9/?serverSelectionTimeoutMS=300", database: "app" },
        keys: { publishable: ["pk"] },
      }),
      { env: TEST_ENV, logger },
    ).catch((error: unknown) => error)
    expect(failure).toMatchObject({ name: "DiagnosticError", code: "CANOPY_UNAVAILABLE" })
    const message = lines.find((line) => line.level === "error")?.message ?? ""
    expect(message).toMatch(/^error CANOPY_UNAVAILABLE: /)
    expect(message).toContain("127.0.0.1:9")
    expect(message).toContain("Fix: ")
  })
})

const notes = collection("notes", {
  exposed: true,
  policies: [
    allow
      .read("anon")
      .where({ ownerId: auth("sub") })
      .named("by owner"),
  ],
})

suite("variable issue logging", () => {
  const dbName = `canopy_startup_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let mongo: MongoClient

  beforeAll(async () => {
    mongo = new MongoClient(MONGODB_URI ?? "")
    await mongo.connect()
  })

  afterAll(async () => {
    await mongo.db(dbName).dropDatabase()
    await mongo.db(`${dbName}_meta`).dropDatabase()
    await mongo.close()
  })

  for (const [environment, realtime] of [
    ["development", false],
    ["development", true],
    ["production", false],
  ] as const) {
    it(`${environment === "development" ? "reports" : "stays quiet about"} policies that drop out (${environment}, realtime ${realtime ? "on" : "off"})`, async () => {
      const { lines, logger } = recorder()
      const canopy = await createCanopy(
        defineConfig({
          mongodb: { uri: MONGODB_URI ?? "", database: dbName, metaDatabase: `${dbName}_meta` },
          keys: { publishable: ["pk"] },
          environment,
          ...(environment === "production" ? { masterKey: "m".repeat(44) } : {}),
          realtime: realtime ? { checkpoints: "off" } : false,
        }),
        { env: TEST_ENV, logger, policies: createPolicySet([notes]), onSetupToken: () => {} },
      )
      const server: Server = createServer(canopy.node())
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      try {
        for (let i = 0; i < 3; i++) {
          const response = await fetch(`${base}/rest/v1/notes`, { headers: { apikey: "pk" } })
          expect(response.status).toBe(200)
          expect(((await response.json()) as { data: unknown[] }).data).toEqual([])
        }
        const issues = lines.filter((line) =>
          line.message.includes('policy "by owner" on notes did not match'),
        )
        expect(issues).toHaveLength(environment === "development" ? 1 : 0)
      } finally {
        await canopy.close()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    })
  }
})

suite("setup token announcement", () => {
  const dbName = `canopy_setup_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let mongo: MongoClient

  beforeAll(async () => {
    mongo = new MongoClient(MONGODB_URI ?? "")
    await mongo.connect()
  })

  afterAll(async () => {
    await mongo.db(dbName).dropDatabase()
    await mongo.db(`${dbName}_meta`).dropDatabase()
    await mongo.close()
  })

  const start = (onSetupToken?: false) =>
    createCanopy(
      defineConfig({
        mongodb: { uri: MONGODB_URI ?? "", database: dbName, metaDatabase: `${dbName}_meta` },
        keys: { publishable: ["pk"] },
        realtime: false,
      }),
      {
        env: TEST_ENV,
        mongo,
        policies: createPolicySet([notes]),
        ...(onSetupToken === undefined ? {} : { onSetupToken }),
      },
    )

  it("prints the token to standard error without a logger, and stays quiet with onSetupToken: false", async () => {
    await mongo.db(`${dbName}_meta`).dropDatabase()
    const written: string[] = []
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk))
      return true
    })
    try {
      const quiet = await start(false)
      await quiet.close()
      expect(written.join("")).not.toContain("setup token")
      const setup = await mongo
        .db(`${dbName}_meta`)
        .collection<{ _id: string; tokens?: unknown[] }>("settings")
        .findOne({ _id: "setup" })
      expect(setup?.tokens ?? []).toHaveLength(0)

      const loud = await start()
      await loud.close()
      expect(written.join("")).toMatch(/one time setup token canopy_setup_\S+/)
    } finally {
      spy.mockRestore()
    }
  })
})
