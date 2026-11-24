import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { createServer } from "node:http"
import { allow, collection, createPolicySet } from "@canopy/policy"
import { MONGODB_URI, TEST_ENV } from "@canopy/testing"
import { MongoClient } from "mongodb"
import { describe, expect, it } from "vitest"
import { createEmbeddedCanopy, resolveConfig } from "../src/index.ts"

const suite = MONGODB_URI === undefined ? describe.skip : describe
const key = "pk_embedded_test"

const notes = collection("notes", {
  exposed: true,
  realtime: true,
  policies: [
    allow.read("anon").where({ visible: true }),
    allow.insert("anon").check({ visible: true }),
  ],
})

suite("embedded Canopy on Node HTTP", () => {
  it("shares document policies across REST, GraphQL and realtime", async () => {
    const database = `embedded_${randomUUID().replaceAll("-", "")}`
    const metaDatabase = `${database}_meta`
    const uri = MONGODB_URI ?? ""
    const { config } = resolveConfig(
      {
        mongodb: { uri, database, metaDatabase },
        keys: { publishable: [key] },
        realtime: { checkpoints: "off", transports: ["long-poll"], server: "gateway" },
      },
      { env: TEST_ENV, command: "start", baseDir: process.cwd(), cwd: process.cwd() },
    )
    await using mongo = await new MongoClient(uri).connect()
    try {
      await mongo
        .db(database)
        .collection<{ _id: string; visible: boolean }>("notes")
        .insertOne({ _id: "hidden", visible: false })
      await using embedded = await createEmbeddedCanopy(config, {
        mongo,
        policies: createPolicySet([notes]),
      })
      await using server = createServer(embedded.node)
      server.listen(0, "127.0.0.1")
      await once(server, "listening")
      const address = server.address()
      if (address === null || typeof address === "string") throw new Error("Expected a TCP server")
      const base = `http://127.0.0.1:${address.port}`
      const call = (path: string, body?: unknown) =>
        fetch(base + path, {
          headers: { apikey: key, "content-type": "application/json" },
          signal: AbortSignal.timeout(5_000),
          ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
        })

      const inserted = await call("/rest/v1/notes", { _id: "visible", visible: true })
      expect(inserted.status).toBe(201)
      await inserted.json()
      const found = await call("/rest/v1/notes")
      expect(found.status).toBe(200)
      expect(await found.json()).toMatchObject({ data: [{ _id: "visible", visible: true }] })
      const counted = await call("/rest/v1/notes/_count", {})
      expect(counted.status).toBe(200)
      expect(await counted.json()).toMatchObject({ data: { count: 1, exact: true } })
      const graph = await call("/graphql/v1", { query: "{ notes { nodes { _id } } }" })
      expect(graph.status).toBe(200)
      expect(await graph.json()).toEqual({ data: { notes: { nodes: [{ _id: "visible" }] } } })

      const opened = await call("/realtime/v1/sessions", { v: 1 })
      expect(opened.status).toBe(201)
      const welcome = (await opened.json()) as { t: string; sid: string }
      expect(welcome.t).toBe("welcome")
      const session = `/realtime/v1/sessions/${welcome.sid}`
      const subscribed = await call(`${session}/messages`, [
        { t: "sub", id: "notes", c: "notes", q: {} },
      ])
      expect(subscribed.status).toBe(202)
      await subscribed.text()

      let after = 0
      const frames: { t: string; seq: number; id?: string }[] = []
      const deadline = Date.now() + 5_000
      while (!frames.some((frame) => frame.t === "ready") && Date.now() < deadline) {
        const response = await call(`${session}/poll?after=${after}&wait=1`)
        expect(response.status).toBe(200)
        const batch = (await response.json()) as typeof frames
        frames.push(...batch)
        for (const frame of batch) after = Math.max(after, frame.seq)
      }
      expect(frames.some((frame) => frame.t === "ready")).toBe(true)
      expect(frames.filter((frame) => frame.t === "added").map((frame) => frame.id)).toEqual([
        "visible",
      ])

      for (const path of ["/admin/v1", "/studio", "/auth/v1/jwks", "/.well-known/jwks.json"]) {
        const response = await call(path)
        expect(response.status).toBe(404)
        await response.text()
        expect((await embedded.fetch(new Request(base + path))).status).toBe(404)
      }
    } finally {
      await mongo.db(database).dropDatabase()
      await mongo.db(metaDatabase).dropDatabase()
    }
  }, 15_000)
})
