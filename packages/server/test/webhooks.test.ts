import { createServer, type IncomingHttpHeaders, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { resolveConfig } from "@canopy/config"
import { verifyWebhook } from "@canopy/protocol"
import { silentLogger } from "@canopy/realtime"
import { MONGODB_URI } from "@canopy/testing"
import { BSON, type Db, MongoClient } from "mongodb"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { base32Decode, totp } from "../src/admin/totp.ts"
import { type Canopy, createCanopy, defineConfig } from "../src/index.ts"
import { migrateMeta } from "../src/migrations.ts"
import { Dispatcher } from "../src/webhooks/dispatcher.ts"
import { DeliveryQueue } from "../src/webhooks/queue.ts"
import { Scheduler } from "../src/webhooks/scheduler.ts"
import { compileTriggers, triggerDeliveries } from "../src/webhooks/triggers.ts"
import { startWebhooks, type Webhooks } from "../src/webhooks/webhooks.ts"

const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"
const PASSWORD = "correct horse battery staple"

interface Received {
  readonly path: string
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

/** An endpoint that records requests and answers from a script (200 once the script is used up). */
class Receiver {
  readonly received: Received[] = []
  answers: { status: number; headers?: Record<string, string>; hang?: boolean }[] = []
  private server: Server | undefined
  url = ""

  async start(): Promise<void> {
    const server = createServer((request, response) => {
      let body = ""
      request.setEncoding("utf8")
      request.on("data", (chunk: string) => {
        body += chunk
      })
      request.on("end", () => {
        this.received.push({ path: request.url ?? "", headers: request.headers, body })
        const answer = this.answers.shift() ?? { status: 200 }
        if (answer.hang === true) return
        response.writeHead(answer.status, answer.headers ?? {})
        response.end("ok")
      })
    })
    this.server = server
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address() as AddressInfo
    this.url = `http://127.0.0.1:${address.port}`
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections()
    await new Promise<void>((resolve) => this.server?.close(() => resolve()))
  }

  for(path: string): Received[] {
    return this.received.filter((item) => item.path === path)
  }
}

/** The time of a date field of a stored document, failing the test when it is missing. */
function dateOf(document: Record<string, unknown> | null, field: string): number {
  const value = document?.[field]
  if (!(value instanceof Date)) throw new Error(`${field} is not a date`)
  return value.getTime()
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const started = Date.now()
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for a condition")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe("trigger matching", () => {
  const event = (
    op: "insert" | "update" | "replace" | "delete",
    post: Record<string, unknown> | null | undefined,
    pre: Record<string, unknown> | null | undefined = op === "insert" ? null : undefined,
    token = `82${op}`,
  ) => ({
    ct: "7000000000000000001",
    token: { _data: token },
    wallTime: undefined,
    coll: "orders",
    op,
    id: "o1",
    key: "orders/o1",
    pre,
    post,
    diff: op === "update" ? { set: { status: "placed" }, unset: ["draft"] } : undefined,
  })

  it("selects by collection, operation and filter, against the document before a delete", () => {
    const triggers = compileTriggers({
      placed: {
        collection: "orders",
        operations: ["insert", "update"],
        filter: { status: "placed" },
        url: "http://example.com/a",
      },
      removed: {
        collection: "orders",
        operations: ["delete"],
        filter: { status: "placed" },
        url: "http://example.com/b",
      },
      all: {
        collection: "orders",
        operations: ["insert", "update", "replace", "delete"],
        filter: undefined,
        url: "http://example.com/c",
      },
      other: {
        collection: "users",
        operations: ["insert"],
        filter: undefined,
        url: "http://example.com/d",
      },
    })
    const deliveries = triggerDeliveries(triggers, [
      event("insert", { _id: "o1", status: "draft" }),
      event("update", { _id: "o1", status: "placed" }),
      event("delete", null, { _id: "o1", status: "placed" }),
      event("delete", null, undefined, "82delete2"),
    ])
    expect(deliveries.map((d) => d.hook)).toEqual(["all", "placed", "all", "removed", "all", "all"])
    expect(new Set(deliveries.map((d) => d.id)).size).toBe(deliveries.length)
    const update = BSON.EJSON.parse(deliveries[1]?.body ?? "") as Record<string, unknown>
    expect(update).toEqual({
      type: "trigger",
      trigger: "placed",
      collection: "orders",
      operation: "update",
      documentId: "o1",
      document: { _id: "o1", status: "placed" },
      updateDescription: { updatedFields: { status: "placed" }, removedFields: ["draft"] },
      clusterTime: "7000000000000000001",
    })
    const removed = BSON.EJSON.parse(deliveries[3]?.body ?? "") as Record<string, unknown>
    expect(removed["document"]).toBeNull()
    expect(removed["before"]).toEqual({ _id: "o1", status: "placed" })
    expect(deliveries[3]?.id).toBe("trigger:removed:82delete")
  })

  it("refuses a filter the matcher cannot evaluate, naming the trigger", () => {
    expect(() =>
      compileTriggers({
        geo: {
          collection: "places",
          operations: ["insert"],
          filter: { at: { $near: [0, 0] } },
          url: "http://example.com/a",
        },
      }),
    ).toThrow(/The filter of the trigger geo cannot be evaluated/)
  })
})

const suite = MONGODB_URI === undefined ? describe.skip : describe

suite("webhook deliveries", () => {
  const name = `canopy_webhooks_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  let mongo: MongoClient
  let meta: Db
  let queue: DeliveryQueue
  const receiver = new Receiver()
  const dispatchers: Dispatcher[] = []

  const dispatcher = (overrides: Partial<ConstructorParameters<typeof Dispatcher>[0]> = {}) => {
    const created = new Dispatcher({
      queue,
      secret: SECRET,
      endpoint: (hook) => (hook === "gone" ? undefined : `${receiver.url}/${hook}`),
      maxAttempts: 3,
      timeoutMs: 2000,
      node: "n1",
      logger: silentLogger,
      pollMs: 20,
      retryBaseMs: 20,
      ...overrides,
    })
    dispatchers.push(created)
    return created
  }

  beforeAll(async () => {
    mongo = new MongoClient(MONGODB_URI ?? "")
    await mongo.connect()
    meta = mongo.db(`${name}_meta`)
    await receiver.start()
  })

  afterAll(async () => {
    await receiver.stop()
    await meta.dropDatabase()
    await mongo.close()
  })

  beforeEach(async () => {
    await meta.dropDatabase()
    await migrateMeta(meta)
    queue = new DeliveryQueue(meta)
    receiver.received.length = 0
    receiver.answers = []
  })

  afterEach(async () => {
    for (const created of dispatchers.splice(0)) await created.stop()
  })

  const stored = (id: string) => meta.collection("webhook_deliveries").findOne({ _id: id as never })

  it("stores a delivery once and sends it signed, then keeps it as delivered", async () => {
    const item = { id: "d1", hook: "orders", kind: "trigger" as const, body: '{"n":1}' }
    expect(await queue.enqueue([item])).toBe(1)
    expect(await queue.enqueue([item, { ...item, id: "d2" }])).toBe(1)
    dispatcher().start()
    await until(async () => (await stored("d1"))?.["status"] === "delivered")
    await until(async () => (await stored("d2"))?.["status"] === "delivered")
    const request = receiver.for("/orders").find((r) => r.headers["webhook-id"] === "d1")
    expect(request?.body).toBe('{"n":1}')
    expect(request?.headers["content-type"]).toBe("application/json")
    expect(
      await verifyWebhook(SECRET, request?.headers as Record<string, string>, request?.body ?? ""),
    ).toBe(true)
    const delivered = await stored("d1")
    expect(delivered?.["attempts"]).toBe(1)
    expect(delivered?.["lastStatus"]).toBe(200)
    const expires = dateOf(delivered, "expiresAt") - Date.now()
    expect(expires).toBeGreaterThan(6.9 * 86_400_000)
    expect(expires).toBeLessThanOrEqual(7 * 86_400_000)
  })

  it("retries a failing endpoint with the same id until it answers 2xx", async () => {
    receiver.answers = [{ status: 500 }, { status: 302, headers: { location: "/elsewhere" } }]
    await queue.enqueue([{ id: "d1", hook: "orders", kind: "trigger", body: "{}" }])
    dispatcher().start()
    await until(async () => (await stored("d1"))?.["status"] === "delivered")
    expect(receiver.for("/orders").map((r) => r.headers["webhook-id"])).toEqual(["d1", "d1", "d1"])
    expect(receiver.for("/elsewhere")).toEqual([])
    expect((await stored("d1"))?.["attempts"]).toBe(3)
  })

  it("dead letters after the last attempt, and a retried dead letter is delivered", async () => {
    receiver.answers = [{ status: 503 }, { status: 503 }, { status: 410 }]
    await queue.enqueue([{ id: "d1", hook: "orders", kind: "trigger", body: "{}" }])
    dispatcher().start()
    await until(
      async () => (await queue.deadLetters()).length === 1 && (await stored("d1")) === null,
    )
    const [letter] = await queue.deadLetters({ hook: "orders" })
    expect(letter).toMatchObject({
      _id: "d1",
      hook: "orders",
      attempts: 3,
      lastStatus: 410,
      lastError: "The endpoint answered 410",
    })
    expect(await stored("d1")).toBeNull()
    expect((await queue.counts()).get("orders")).toEqual({ pending: 0, deadLetters: 1 })

    expect(await queue.requeue("d1")).toBe(true)
    expect(await queue.requeue("d1")).toBe(false)
    await until(async () => (await stored("d1"))?.["status"] === "delivered")
    expect(await queue.deadLetters()).toEqual([])
    expect(receiver.for("/orders")).toHaveLength(4)
  })

  it("dead letters a delivery whose hook is no longer configured, without calling anything", async () => {
    await queue.enqueue([{ id: "d1", hook: "gone", kind: "schedule", body: "{}" }])
    dispatcher().start()
    await until(async () => (await queue.deadLetters()).length === 1)
    expect((await queue.deadLetters())[0]?.lastError).toBe("The hook is no longer configured")
    expect(receiver.received).toEqual([])
    expect(await queue.discard("d1")).toBe(true)
    expect(await queue.discard("d1")).toBe(false)
  })

  it("backs off exponentially with jitter and honors Retry-After", async () => {
    const sender = dispatcher({ retryBaseMs: 1000, maxAttempts: 8 })
    const now = Date.now()
    const waits: number[] = []
    for (const attempts of [1, 3]) {
      await meta.collection("webhook_deliveries").deleteMany({})
      await queue.enqueue([{ id: "d1", hook: "orders", kind: "trigger", body: "{}" }])
      await meta
        .collection("webhook_deliveries")
        .updateOne({ _id: "d1" as never }, { $set: { attempts: attempts - 1 } })
      receiver.answers = [{ status: 500 }]
      const claimed = await queue.claim(new Date(), 60_000, "n1")
      if (claimed === undefined) throw new Error("nothing claimed")
      await sender.attempt(claimed)
      waits.push(dateOf(await stored("d1"), "nextAt") - now)
    }
    expect(waits[0]).toBeGreaterThanOrEqual(800)
    expect(waits[0]).toBeLessThanOrEqual(1200 + 1000)
    expect(waits[1]).toBeGreaterThanOrEqual(3200)
    expect(waits[1]).toBeLessThanOrEqual(4800 + 1000)

    await meta.collection("webhook_deliveries").deleteMany({})
    await queue.enqueue([{ id: "d1", hook: "orders", kind: "trigger", body: "{}" }])
    receiver.answers = [{ status: 429, headers: { "retry-after": "30" } }]
    const claimed = await queue.claim(new Date(), 60_000, "n1")
    if (claimed === undefined) throw new Error("nothing claimed")
    await sender.attempt(claimed)
    const after: Record<string, unknown> = (await stored("d1")) ?? {}
    expect((after["nextAt"] as Date).getTime() - Date.now()).toBeGreaterThan(28_000)
    expect(after["lastStatus"]).toBe(429)
    expect(after["status"]).toBe("pending")
  })

  it("gives up on an endpoint that does not answer in time", async () => {
    receiver.answers = [{ status: 200, hang: true }]
    await queue.enqueue([{ id: "d1", hook: "orders", kind: "trigger", body: "{}" }])
    const sender = dispatcher({ timeoutMs: 200 })
    const claimed = await queue.claim(new Date(), 60_000, "n1")
    if (claimed === undefined) throw new Error("nothing claimed")
    await sender.attempt(claimed)
    expect((await stored("d1"))?.["lastError"]).toBe("The endpoint did not answer within 200 ms")
  })

  it("leases a delivery to one server and ignores a late outcome after a reclaim", async () => {
    await queue.enqueue([{ id: "d1", hook: "orders", kind: "trigger", body: "{}" }])
    const now = new Date()
    const first = await queue.claim(now, 1000, "n1")
    expect(first?.attempts).toBe(1)
    expect(await queue.claim(now, 1000, "n2")).toBeUndefined()
    const second = await queue.claim(new Date(now.getTime() + 1001), 1000, "n2")
    expect(second?.attempts).toBe(2)
    expect(second?.node).toBe("n2")
    if (first === undefined || second === undefined) throw new Error("nothing claimed")
    await queue.delivered(first, new Date(), 200)
    expect((await stored("d1"))?.["status"]).toBe("delivering")
    await queue.retry(second, new Date(), "boom", 500)
    expect((await stored("d1"))?.["status"]).toBe("pending")
  })

  it("fires a schedule once across servers and catches up the last missed fire only", async () => {
    const schedules = { nightly: { cron: "0 3 * * *", url: "http://x", body: { kind: "daily" } } }
    let fired = 0
    const make = (now: number) =>
      new Scheduler({
        meta,
        schedules,
        queue,
        logger: silentLogger,
        onEnqueued: () => {
          fired += 1
        },
        now: () => now,
      })
    const day = Date.UTC(2026, 10, 18, 12, 0)
    await make(day).catchUp(new Date(day))
    expect(await meta.collection("webhook_deliveries").countDocuments()).toBe(0)
    expect(
      (await meta.collection("webhook_schedules").findOne({ _id: "nightly" as never }))?.["lastAt"],
    ).toEqual(new Date(Date.UTC(2026, 10, 18, 3, 0)))

    const at = new Date(Date.UTC(2026, 10, 19, 3, 0))
    const results = await Promise.all([
      make(day).fire("nightly", at),
      make(day).fire("nightly", at),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(fired).toBe(1)
    const delivery = await stored(`schedule:nightly:${at.toISOString()}`)
    expect(BSON.EJSON.parse(String(delivery?.["body"]))).toEqual({
      type: "schedule",
      schedule: "nightly",
      scheduledAt: "2026-11-19T03:00:00.000Z",
      body: { kind: "daily" },
    })

    const later = Date.UTC(2026, 10, 23, 12, 0)
    await make(later).catchUp(new Date(later))
    const ids = (await meta.collection("webhook_deliveries").find().toArray()).map((d) => d._id)
    expect(ids.sort()).toEqual([
      "schedule:nightly:2026-11-19T03:00:00.000Z",
      "schedule:nightly:2026-11-23T03:00:00.000Z",
    ])
    await make(later).catchUp(new Date(later))
    expect(await meta.collection("webhook_deliveries").countDocuments()).toBe(2)
  })
})

suite("triggers and schedules in a server", () => {
  const dbName = `canopy_hooks_${process.pid}_${Math.floor(Math.random() * 1e6)}`
  const receiver = new Receiver()
  let mongo: MongoClient
  let canopy: Canopy
  let second: Webhooks | undefined
  let base: string
  let server: Server

  const config = () =>
    defineConfig({
      mongodb: { uri: MONGODB_URI ?? "", database: dbName, metaDatabase: `${dbName}_meta` },
      keys: { publishable: ["pk_hooks_test"] },
      realtime: { checkpoints: "off", drainWindow: "1s" },
      webhooks: {
        secret: SECRET,
        triggers: {
          placed: {
            collection: "orders",
            operations: ["insert", "update"],
            filter: { status: "placed" },
            url: `${receiver.url}/placed`,
          },
          removed: { collection: "orders", operations: ["delete"], url: `${receiver.url}/removed` },
        },
        schedules: { nightly: { cron: "0 3 * * *", url: `${receiver.url}/nightly` } },
      },
    })

  beforeAll(async () => {
    await receiver.start()
    mongo = new MongoClient(MONGODB_URI ?? "")
    await mongo.connect()
    canopy = await createCanopy(config(), { env: {}, onSetupToken: false })
    second = await startWebhooks({
      config: resolveConfig(config(), {
        env: { CANOPY_NODE_ID: "n2" },
        baseDir: ".",
        cwd: ".",
        command: "start",
      }).config,
      client: mongo,
      logger: silentLogger,
      dispatch: { pollMs: 50 },
    })
    server = createServer(canopy.node())
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await second?.stop()
    await canopy.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await receiver.stop()
    await mongo.db(dbName).dropDatabase()
    await mongo.db(`${dbName}_meta`).dropDatabase()
    await mongo.close()
  })

  it("delivers each matching change once although two servers capture it", async () => {
    const orders = mongo.db(dbName).collection("orders")
    await orders.insertOne({ _id: "o1" as never, status: "draft" })
    await orders.insertOne({ _id: "o2" as never, status: "placed" })
    await orders.updateOne({ _id: "o1" as never }, { $set: { status: "placed" } })
    await orders.deleteOne({ _id: "o2" as never })
    await until(() => receiver.for("/placed").length >= 2 && receiver.for("/removed").length >= 1)
    await new Promise((resolve) => setTimeout(resolve, 500))
    const placed = receiver
      .for("/placed")
      .map((r) => BSON.EJSON.parse(r.body) as Record<string, unknown>)
    expect(placed.map((p) => [p["operation"], p["documentId"]])).toEqual(
      expect.arrayContaining([
        ["insert", "o2"],
        ["update", "o1"],
      ]),
    )
    expect(placed).toHaveLength(2)
    const removed = receiver.for("/removed")
    expect(removed).toHaveLength(1)
    expect(BSON.EJSON.parse(removed[0]?.body ?? "")).toMatchObject({
      operation: "delete",
      documentId: "o2",
      document: null,
    })
    for (const request of receiver.received)
      expect(
        await verifyWebhook(SECRET, request.headers as Record<string, string>, request.body),
      ).toBe(true)
    expect(canopy.renderMetrics()).toContain("# TYPE canopy_webhook_deliveries_total counter")
    const delivered = (hook: string): number =>
      [canopy.webhooks, second].reduce(
        (sum, hooks) => sum + (hooks?.metrics.deliveries.get({ hook, outcome: "delivered" }) ?? 0),
        0,
      )
    expect([delivered("placed"), delivered("removed")]).toEqual([2, 1])
  })

  it("lists, runs and manages hooks through the admin API for an owner only", async () => {
    const token = await canopy.admin.accounts.createSetupToken()
    if (token === undefined) throw new Error("no setup token")
    const claimed = await canopy.admin.accounts.claim(
      { token, email: "owner@example.com", password: PASSWORD },
      {},
    )
    const login = await fetch(`${base}/admin/v1/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "owner@example.com",
        password: PASSWORD,
        totp: totp(base32Decode(claimed.totp.secret), Date.now()),
        transport: "bearer",
      }),
    })
    const session = ((await login.json()) as { token: string }).token
    const call = (method: string, path: string, auth = session) =>
      fetch(`${base}/admin/v1${path}`, { method, headers: { authorization: `Bearer ${auth}` } })

    const listed = (await (await call("GET", "/webhooks")).json()) as {
      data: { name: string; kind: string; endpoint: string; nextFire?: { $date: string } }[]
    }
    expect(listed.data.map((h) => [h.name, h.kind])).toEqual([
      ["placed", "trigger"],
      ["removed", "trigger"],
      ["nightly", "schedule"],
    ])
    expect(listed.data[0]?.endpoint).toBe(receiver.url)
    expect(new Date(listed.data[2]?.nextFire?.$date ?? "").getUTCHours()).toBe(3)

    const run = await call("POST", "/webhooks/nightly/run")
    expect(run.status).toBe(202)
    const { id } = (await run.json()) as { id: string }
    expect(id).toMatch(/^schedule:nightly:run:/)
    await until(() => receiver.for("/nightly").length === 1)
    expect(receiver.for("/nightly")[0]?.headers["webhook-id"]).toBe(id)
    expect((await call("POST", "/webhooks/placed/run")).status).toBe(404)

    const meta = mongo.db(`${dbName}_meta`)
    await meta.collection("webhook_dead_letters").insertOne({
      _id: "letter1" as never,
      hook: "nightly",
      kind: "schedule",
      body: "{}",
      attempts: 8,
      createdAt: new Date(),
      failedAt: new Date(),
      lastError: "The endpoint answered 500",
    })
    const letters = (await (await call("GET", "/webhooks/dead-letters?hook=nightly")).json()) as {
      data: { _id: string }[]
    }
    expect(letters.data.map((l) => l._id)).toEqual(["letter1"])
    expect((await call("POST", "/webhooks/dead-letters/letter1/retry")).status).toBe(200)
    await until(() => receiver.for("/nightly").some((r) => r.headers["webhook-id"] === "letter1"))
    expect((await call("DELETE", "/webhooks/dead-letters/letter1")).status).toBe(404)
    expect((await call("GET", "/webhooks", "canopy_admin_forged")).status).toBe(401)
    const audit = await meta
      .collection("audit_log")
      .find({ action: { $in: ["webhooks.run", "webhooks.retry"] } })
      .toArray()
    expect(audit.map((entry) => entry["action"]).sort()).toEqual(["webhooks.retry", "webhooks.run"])
  })
})
