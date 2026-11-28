import { deepStrictEqual, equal, ok } from "node:assert/strict"
import { createHmac, randomUUID } from "node:crypto"
import { createServer, type IncomingHttpHeaders } from "node:http"
import { ContextResolver } from "@canopy/policy"
import { normalize, silentLogger } from "@canopy/realtime"
import { WritePath } from "@canopy/rest"
import { BSON, type Db, type MongoClient } from "mongodb"
import { createAdminApi } from "../../../src/admin/api.ts"
import { base32Decode, totp } from "../../../src/admin/totp.ts"
import { createCanopy, defineConfig } from "../../../src/index.ts"
import { Dispatcher, WebhookMetrics } from "../../../src/webhooks/dispatcher.ts"
import { DeliveryQueue, type NewDelivery } from "../../../src/webhooks/queue.ts"
import { Scheduler } from "../../../src/webhooks/scheduler.ts"
import { compileTriggers, triggerDeliveries } from "../../../src/webhooks/triggers.ts"
import { type VectorOptions, vectorFile } from "../vector-file.ts"

const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"
const start = Date.parse("2099-01-01T00:00:00Z")
const operations = ["insert", "update", "replace", "delete"] as const
const headerNames = [
  "content-type",
  "user-agent",
  "webhook-id",
  "webhook-timestamp",
  "webhook-signature",
] as const

async function runFromAdmin(
  client: MongoClient,
  app: Db,
  meta: Db,
  scheduler: Scheduler,
  queue: DeliveryQueue,
) {
  await using canopy = await createCanopy(
    defineConfig({
      mongodb: {
        uri: "mongodb://oracle.invalid:37017",
        database: app.databaseName,
        metaDatabase: meta.databaseName,
      },
      keys: { publishable: ["pk_webhook_oracle"] },
      realtime: false,
    }),
    { mongo: client, env: { CANOPY_ENGINE: "ts" }, onSetupToken: false, studio: false },
  )
  const { accounts, audit, policies, settings, tokens } = canopy.admin
  const engine = () => canopy.policies
  const api = createAdminApi({
    config: canopy.config,
    client,
    accounts,
    audit,
    policies,
    settings,
    tokens,
    engine,
    keys: canopy.keys,
    realtime: undefined,
    logger: silentLogger,
    contexts: new ContextResolver({ reader: async () => [] }),
    writes: new WritePath({
      client,
      database: app.databaseName,
      metaDatabase: meta.databaseName,
      policies: engine,
    }),
    webhooks: {
      run: (name) => scheduler.run(name),
      queue,
      metrics: new WebhookMetrics(),
      streaming: true,
      hooks: async () => [],
      deadLetters: (filter) => queue.deadLetters(filter),
      retry: (id) => queue.requeue(id),
      discard: (id) => queue.discard(id),
      stop: async () => scheduler.stop(),
    },
  })
  const token = await accounts.createSetupToken()
  ok(token)
  const email = "owner@example.test"
  const password = "correct horse battery staple"
  const claimed = await accounts.claim({ token, email, password }, {})
  const login = await accounts.login(
    {
      email,
      password,
      totp: totp(base32Decode(claimed.totp.secret), Date.now()),
    },
    {},
    "bearer",
  )
  const target = "/admin/v1/webhooks/nightly/run"
  const response = await api.fetch(
    new Request(`http://canopy.test${target}`, {
      method: "POST",
      headers: { authorization: `Bearer ${login.token}` },
    }),
  )
  equal(response.status, 202)
  const body: unknown = await response.json()
  ok(body && typeof body === "object" && "id" in body && typeof body.id === "string")
  return { method: "POST", target, status: response.status, body: { id: body.id } }
}

async function triggerCases(db: Db, url: string) {
  const orders = await db.createCollection<{ _id: string; active: boolean; draft?: boolean }>(
    "orders",
    { changeStreamPreAndPostImages: { enabled: true } },
  )
  await using stream = orders.watch([], {
    fullDocument: "required",
    fullDocumentBeforeChange: "required",
    maxAwaitTimeMS: 50,
    timeoutMS: 5000,
  })
  equal(await stream.tryNext(), null)
  const triggers = compileTriggers({
    active: { collection: "orders", operations, filter: { active: true }, url },
  })
  const cases = []
  for (const active of [true, false]) {
    const id = active ? "accepted" : "filtered"
    const writes = {
      insert: () => orders.insertOne({ _id: id, active, draft: true }),
      update: () => orders.updateOne({ _id: id }, { $unset: { draft: "" } }),
      replace: () => orders.replaceOne({ _id: id }, { active, draft: false }),
      delete: () => orders.deleteOne({ _id: id }),
    }
    for (const operation of operations) {
      await writes[operation]()
      const raw = await stream.next()
      const normalized = normalize({ ...raw })
      ok(normalized && "op" in normalized)
      equal(normalized.op, operation)
      equal(normalized.id, id)
      ok(normalized.wallTime instanceof Date)
      ok(BigInt(normalized.ct) > 0n)
      ok(normalized.token && typeof normalized.token === "object" && "_data" in normalized.token)
      const event = {
        ...normalized,
        ct: "7000000000000000001",
        token: { _data: `${id}:${operation}` },
        wallTime: new Date(start),
      }
      const deliveries = triggerDeliveries(triggers, [event])
      equal(deliveries.length, active ? 1 : 0)
      cases.push({ operation, event, deliveries })
    }
  }
  return cases
}

/** Captures trigger and schedule requests with their signatures and persisted delivery outcomes. */
export async function recordWebhooks(options: VectorOptions): Promise<string[]> {
  const app = options.client.db(`canopy_oracle_hooks_app_${randomUUID()}`)
  const meta = options.client.db(`canopy_oracle_hooks_meta_${randomUUID()}`)
  let time = start
  const queue = new DeliveryQueue(meta, () => new Date(time))
  const requests: {
    method: string | undefined
    path: string | undefined
    headers: IncomingHttpHeaders
    body: string
  }[] = []
  let answer: number | "timeout" = 204
  const receiver = createServer((request, response) => {
    request.setEncoding("utf8")
    let body = ""
    request.on("data", (chunk: string) => {
      body += chunk
    })
    request.on("end", () => {
      const headers = Object.fromEntries(headerNames.map((name) => [name, request.headers[name]]))
      requests.push({ method: request.method, path: request.url, headers, body })
      if (answer !== "timeout") response.writeHead(answer).end()
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      receiver.once("error", reject)
      receiver.listen(0, "127.0.0.1", resolve)
    })
    const address = receiver.address()
    ok(address && typeof address !== "string")
    const origin = `http://127.0.0.1:${address.port}`
    const path = (hook: string) => `/receiver/${hook}?format=ejson`
    const dispatcher = new Dispatcher({
      queue,
      secret,
      endpoint: (hook) => origin + path(hook),
      maxAttempts: 3,
      timeoutMs: 500,
      node: "oracle",
      logger: silentLogger,
      now: () => time,
      random: () => 0.5,
    })

    async function send(id: string, status: typeof answer) {
      answer = status
      const claimed = await queue.claim(new Date(time), 30_500, "oracle")
      ok(claimed)
      equal(claimed._id, id)
      const count = requests.length
      await dispatcher.attempt(claimed)
      equal(requests.length, count + 1)
      const received = requests[count]
      ok(received)
      equal(received.method, "POST")
      equal(received.path, path(claimed.hook))
      equal(received.headers["webhook-id"], id)
      const timestamp = String(Math.floor(time / 1000))
      equal(received.headers["webhook-timestamp"], timestamp)
      const expected = createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
        .update(`${id}.${timestamp}.${received.body}`)
        .digest("base64")
      equal(received.headers["webhook-signature"], `v1,${expected}`)
      equal(received.body, claimed.body)
      return { answer: status, request: received, state: await queue.find(id) }
    }

    async function deliver(item: NewDelivery) {
      equal(await queue.enqueue([item]), 1)
      const attempt = await send(item.id, 204)
      equal(attempt.state.delivery?.status, "delivered")
      return attempt
    }

    const triggers = []
    for (const { event, deliveries } of await triggerCases(app, origin + path("active"))) {
      const item = deliveries[0]
      triggers.push({ event, outcome: item === undefined ? null : await deliver(item) })
    }

    const scheduler = new Scheduler({
      meta,
      queue,
      schedules: {
        nightly: { cron: "0 3 * * *", url: origin + path("nightly"), body: { type: "daily" } },
      },
      logger: silentLogger,
      onEnqueued: () => {},
      now: () => time,
      uuid: () => "00000000-0000-4000-8000-000000000001",
    })
    await scheduler.catchUp(new Date(time))
    equal(await queue.claim(new Date(time), 1, "oracle"), undefined)
    const next = scheduler.nextFire("nightly")
    ok(next)
    equal(next.toISOString(), "2099-01-01T03:00:00.000Z")
    time = next.getTime()
    equal(await scheduler.fire("nightly", next), true)
    equal(await scheduler.fire("nightly", next), false)
    const scheduled = await send(`schedule:nightly:${next.toISOString()}`, 204)
    time += 3 * 86_400_000
    await scheduler.catchUp(new Date(time))
    const catchUp = await send(`schedule:nightly:${new Date(time).toISOString()}`, 204)
    const adminRequest = await runFromAdmin(options.client, app, meta, scheduler, queue)
    const adminRun = { adminRequest, delivery: await send(adminRequest.body.id, 204) }

    const failures = []
    for (const reason of [500, "timeout", 410] as const) {
      const item = {
        id: `failure:${reason}`,
        hook: "failing",
        kind: "trigger",
        body: "{}",
      } as const
      equal(await queue.enqueue([item]), 1)
      const attempts = []
      for (const delay of [10_000, 20_000, null]) {
        const attempt = await send(item.id, reason)
        attempts.push(attempt)
        if (delay === null) {
          equal(attempt.state.deadLetter?.attempts, 3)
          equal(attempt.state.delivery, undefined)
        } else {
          equal(attempt.state.delivery?.status, "pending")
          equal(attempt.state.delivery?.nextAt.getTime(), time + delay)
          equal(await queue.claim(new Date(time + delay - 1), 1, "oracle"), undefined)
          time += delay
        }
      }
      failures.push({ reason, attempts })
    }
    const afterExhaustion = await deliver({
      id: "fresh",
      hook: "failing",
      kind: "trigger",
      body: "{}",
    })
    deepStrictEqual((await queue.counts()).get("failing"), { pending: 0, deadLetters: 3 })
    const state = Object.fromEntries(
      await Promise.all(
        ["webhook_deliveries", "webhook_dead_letters", "webhook_schedules"].map(async (name) => [
          name,
          await meta.collection(name).find().sort({ _id: 1 }).toArray(),
        ]),
      ),
    )
    return await vectorFile(
      options,
      "deliveries.json",
      BSON.EJSON.serialize(
        {
          secret,
          triggers,
          cron: { scheduled, catchUp, adminRun },
          failures,
          afterExhaustion,
          state,
        },
        { relaxed: false },
      ),
    )
  } finally {
    receiver.closeAllConnections()
    await new Promise<void>((resolve) => receiver.close(() => resolve()))
    await app.dropDatabase()
    await meta.dropDatabase()
  }
}
