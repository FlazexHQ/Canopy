import { spawn } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { allow, auth, collection, createPolicySet } from "@canopy/policy"
import { encodeMessage } from "@canopy/protocol"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { MongoClient } from "mongodb"
import { createRealtime, type Realtime, type RealtimeSocket } from "../src/index.ts"

/**
 * Realtime fan out at scale: seeds one large collection, opens many in process connections (no network,
 * so the numbers are the engine's), subscribes them, then drives writes from a separate process and
 * measures the time from each write to its delivery on every subscribed socket.
 *
 * The `gate` section of the output, checked by `packages/testing/scripts/bench-gate.ts` against
 * `bench/baseline.json`, requires every subscriber to end with the final state of every document it may
 * read and compares the delivery latency with a plain change stream measured in the same run.
 *
 * Environment: `CANOPY_BENCH_MONGODB_URI` (or `CANOPY_TEST_MONGODB_URI`), `CANOPY_BENCH_DOCS` (default
 * 1000000), `CANOPY_BENCH_SECONDS` (write phase per scenario, default 8), `CANOPY_BENCH_ONLY` (scenarios
 * whose name contains one of these `|` separated parts) and `CANOPY_BENCH_OUT`.
 */
const URI =
  process.env["CANOPY_BENCH_MONGODB_URI"] ??
  process.env["CANOPY_TEST_MONGODB_URI"] ??
  "mongodb://localhost:27017/?replicaSet=rs0"
const DOCS = Number(process.env["CANOPY_BENCH_DOCS"] ?? "1000000")
const SECONDS = Number(process.env["CANOPY_BENCH_SECONDS"] ?? "8")
const OUT = process.env["CANOPY_BENCH_OUT"]
const OWNERS = 10_000
const HOT = 200
const ISSUER = "https://issuer.bench/"
const AUDIENCE = "https://api.bench"

const items = collection("items", {
  exposed: true,
  realtime: true,
  policies: [allow.read("authenticated").where({ ownerId: auth("sub") }), allow.read("viewer")],
})

const now = (): number => performance.timeOrigin + performance.now()
const log = (line: string): void => {
  process.stderr.write(`${line}\n`)
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, index)] ?? Number.NaN
}

function summary(values: number[]): {
  count: number
  p50: number
  p90: number
  p99: number
  max: number
} {
  values.sort((x, y) => x - y)
  return {
    count: values.length,
    p50: percentile(values, 50),
    p90: percentile(values, 90),
    p99: percentile(values, 99),
    max: values.at(-1) ?? Number.NaN,
  }
}

interface Frame {
  readonly t: string
  readonly m?: Frame[]
  readonly id?: unknown
  readonly set?: Record<string, unknown>
  readonly d?: Record<string, unknown>
}

/** Reads a number sent as relaxed or canonical extended JSON. */
function numeric(value: unknown): number | undefined {
  if (typeof value === "number") return value
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>
    const wrapped = record["$numberDouble"] ?? record["$numberInt"] ?? record["$numberLong"]
    const n = Number(wrapped)
    return typeof wrapped === "string" && Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/**
 * One in process connection that records welcome, ready, the delivery time of stamped changes and the
 * last write counter (`n`) it holds for each document, to check that it converged.
 */
class BenchSocket implements RealtimeSocket {
  readonly bufferedAmount = 0
  welcomed: (() => void) | undefined
  readyAt: number | undefined
  onReady: (() => void) | undefined
  readonly deliveries: number[]
  readonly counters = new Map<number, number>()
  docs = 0
  bytes = 0
  handler: ReturnType<Realtime["connect"]> | undefined

  constructor(deliveries: number[]) {
    this.deliveries = deliveries
  }

  send(text: string): void {
    const received = now()
    this.bytes += text.length
    const raw = JSON.parse(text) as Frame
    const parts = raw.t === "batch" ? (raw.m ?? []) : [raw]
    for (const part of parts) {
      const id = numeric(part.id)
      const counter = numeric(part.set?.["n"] ?? part.d?.["n"])
      if (id !== undefined && counter !== undefined) this.counters.set(id, counter)
      switch (part.t) {
        case "welcome":
          this.welcomed?.()
          break
        case "added":
          this.docs += 1
          break
        case "ready":
          this.readyAt = received
          this.onReady?.()
          break
        case "nosub":
          throw new Error(`subscription refused: ${JSON.stringify(part)}`)
        case "changed": {
          const ts = numeric(part.set?.["ts"] ?? part.d?.["ts"])
          if (ts !== undefined) this.deliveries.push(received - ts)
          break
        }
        default:
          break
      }
    }
  }

  /** Like a WebSocket transport, reports the close back to the engine once the engine closes the socket. */
  close(): void {
    const handler = this.handler
    this.handler = undefined
    if (handler !== undefined) queueMicrotask(() => handler.close())
  }
}

async function seed(client: MongoClient, dbName: string): Promise<void> {
  const coll = client.db(dbName).collection<{ _id: number }>("items")
  const batch = 10_000
  let next = 0
  const started = performance.now()
  const worker = async (): Promise<void> => {
    while (next < DOCS) {
      const from = next
      next += batch
      const docs = []
      for (let i = from; i < Math.min(DOCS, from + batch); i += 1)
        docs.push({
          _id: i,
          ownerId: `u${i % OWNERS}`,
          hot: i < HOT,
          status: i % 3 === 0 ? "open" : "done",
          score: (i * 7919) % 10_007,
          title: `Item ${i} with a modest amount of text in it`,
          ts: 0,
          n: 0,
        })
      await coll.insertMany(docs, { ordered: false })
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker))
  await coll.createIndexes([{ key: { ownerId: 1 } }, { key: { hot: 1 } }])
  log(`seeded ${DOCS} documents in ${((performance.now() - started) / 1000).toFixed(1)} s`)
}

interface Scenario {
  readonly name: string
  readonly mode: "owners" | "hot"
  readonly connections: number
  readonly rate: number
}

interface WriterReport {
  readonly issued: number
  readonly errors: number
  /** Time from sending a write to its acknowledgement, in ms. */
  readonly ack: { readonly p50: number; readonly p99: number }
}

interface ProbeReport {
  readonly count: number
  readonly p50: number
  readonly p90: number
  readonly p99: number
  readonly max: number
}

interface ScenarioResult extends Scenario {
  readonly subscribeSeconds: number
  readonly ready: ReturnType<typeof summary>
  readonly snapshotDocs: number
  readonly writes: number
  readonly expectedDeliveries: number
  /**
   * Written documents a subscriber should see, counted once per subscriber, and how many of them it holds
   * at their final write. Two quick writes to one document may reach a subscriber as one change (the post
   * image is read after both), so deliveries can be fewer than writes; the final state may not differ.
   */
  readonly convergence: { readonly checked: number; readonly current: number }
  readonly delivery: ReturnType<typeof summary>
  /** Write start to arrival on a plain change stream in another process: the part Canopy does not add. */
  readonly stream: ProbeReport
  /** Write start to acknowledgement, from the writer. */
  readonly ack: WriterReport["ack"]
  /** Mean engine time per event, from receiving it to writing its frames, in ms. */
  readonly engineMs: number
  readonly deliveriesPerSecond: number
  readonly cpuPercent: number
  readonly rssMB: number
  readonly heapMB: number
}

/** Runs a script of this folder with the current runtime and returns its standard output. */
function child(
  name: string,
  args: readonly string[],
  onLine?: (line: string) => void,
): Promise<string> {
  const script = fileURLToPath(new URL(`./${name}`, import.meta.url))
  const proc = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "inherit"] })
  let out = ""
  proc.stdout.setEncoding("utf8")
  proc.stdout.on("data", (chunk: string) => {
    out += chunk
    if (onLine !== undefined) for (const line of chunk.split("\n")) if (line !== "") onLine(line)
  })
  return new Promise((resolve, reject) =>
    proc.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${name} exited with ${code}`)),
    ),
  )
}

/** Starts the plain change stream probe and resolves once its stream is open. */
async function startProbe(dbName: string): Promise<{ readonly report: Promise<ProbeReport> }> {
  let ready: () => void = () => undefined
  const opened = new Promise<void>((resolve) => {
    ready = resolve
  })
  const done = child("stream-probe.ts", [URI, dbName, String(SECONDS + 3)], (line) => {
    if (line === "ready") ready()
  }).then(
    (out) =>
      JSON.parse(
        out
          .split("\n")
          .filter((line) => line.startsWith("{"))
          .at(-1) ?? "{}",
      ) as ProbeReport,
  )
  await Promise.race([opened, done])
  return { report: done }
}

/** The count and sum of the engine's fan out latency histogram, in seconds. */
function fanoutTotals(realtime: Realtime): { count: number; sum: number } {
  const text = realtime.renderMetrics()
  const read = (name: string): number =>
    Number(new RegExp(`^${name} (\\S+)$`, "m").exec(text)?.[1] ?? 0)
  return {
    count: read("canopy_realtime_fanout_latency_seconds_count"),
    sum: read("canopy_realtime_fanout_latency_seconds_sum"),
  }
}

/** Compares what every subscriber holds with the final write counter of each document it can read. */
async function converged(
  client: MongoClient,
  dbName: string,
  scenario: Scenario,
  sockets: readonly BenchSocket[],
): Promise<ScenarioResult["convergence"]> {
  const written = await client
    .db(dbName)
    .collection<{ _id: number; ownerId: string; hot: boolean; n: number }>("items")
    .find({ n: { $gt: 0 } }, { projection: { ownerId: 1, hot: 1, n: 1 } })
    .toArray()
  let checked = 0
  let current = 0
  for (const [index, socket] of sockets.entries()) {
    for (const doc of written) {
      const visible = scenario.mode === "hot" ? doc.hot : doc.ownerId === `u${index}`
      if (!visible) continue
      checked += 1
      if (socket.counters.get(doc._id) === doc.n) current += 1
    }
  }
  return { checked, current }
}

async function runWriter(dbName: string, scenario: Scenario): Promise<WriterReport> {
  const args =
    scenario.mode === "hot"
      ? [URI, dbName, String(scenario.rate), String(SECONDS), "hot", String(HOT), "0", "1"]
      : [
          URI,
          dbName,
          String(scenario.rate),
          String(SECONDS),
          "owners",
          String(scenario.connections),
          String(DOCS / OWNERS),
          String(OWNERS),
        ]
  return JSON.parse(await child("writer.ts", args)) as WriterReport
}

async function main(): Promise<void> {
  const client = new MongoClient(URI, { maxPoolSize: 200 })
  await client.connect()
  const dbName = `canopy_fanout_${process.pid}`
  const buildInfo = await client.db(dbName).admin().command({ buildInfo: 1 })
  await seed(client, dbName)
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" })
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "EdDSA", use: "sig" }
  const realtime = await createRealtime({
    mongo: client,
    database: dbName,
    metaDatabase: `${dbName}_meta`,
    auth: { jwks: { keys: [jwk] }, issuer: ISSUER, audience: AUDIENCE, rolesClaim: "roles" },
    keys: { publishable: ["pk_bench"] },
    policies: { set: createPolicySet([items]) },
    checkpoints: "off",
    observerLingerMs: 0,
    heartbeatMs: 60_000,
  })
  const signToken = async (sub: string, roles: string[]): Promise<string> =>
    new SignJWT({ roles })
      .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
      .setSubject(sub)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("2h")
      .sign(privateKey)

  const scenarios: Scenario[] = [
    {
      name: "per user, 1k connections, 500 writes/s",
      mode: "owners",
      connections: 1000,
      rate: 500,
    },
    {
      name: "per user, 1k connections, 1k writes/s",
      mode: "owners",
      connections: 1000,
      rate: 1000,
    },
    {
      name: "per user, 1k connections, 2k writes/s",
      mode: "owners",
      connections: 1000,
      rate: 2000,
    },
    {
      name: "per user, 1k connections, 3k writes/s",
      mode: "owners",
      connections: 1000,
      rate: 3000,
    },
    {
      name: "per user, 1k connections, 4k writes/s",
      mode: "owners",
      connections: 1000,
      rate: 4000,
    },
    {
      name: "per user, 10k connections, 1k writes/s",
      mode: "owners",
      connections: 10_000,
      rate: 1000,
    },
    { name: "shared query, 100 connections, 20 writes/s", mode: "hot", connections: 100, rate: 20 },
    { name: "shared query, 1k connections, 20 writes/s", mode: "hot", connections: 1000, rate: 20 },
    {
      name: "shared query, 2.5k connections, 20 writes/s",
      mode: "hot",
      connections: 2500,
      rate: 20,
    },
    { name: "shared query, 5k connections, 20 writes/s", mode: "hot", connections: 5000, rate: 20 },
  ]
  const only = process.env["CANOPY_BENCH_ONLY"]?.split("|")
  const results: ScenarioResult[] = []
  try {
    for (const scenario of scenarios) {
      if (only !== undefined && !only.some((part) => scenario.name.includes(part))) continue
      log(`scenario: ${scenario.name}`)
      const deliveries: number[] = []
      const sockets: BenchSocket[] = []
      const subscribeStart = now()
      const readyLatencies: number[] = []
      let cursor = 0
      const opener = async (): Promise<void> => {
        while (cursor < scenario.connections) {
          const index = cursor
          cursor += 1
          const socket = new BenchSocket(deliveries)
          sockets.push(socket)
          const token =
            scenario.mode === "hot"
              ? await signToken(`v${index}`, ["viewer"])
              : await signToken(`u${index}`, [])
          const handler = realtime.connect(socket)
          socket.handler = handler
          const welcomed = new Promise<void>((resolve) => {
            socket.welcomed = resolve
          })
          handler.message(
            encodeMessage({ t: "hello", v: 1, key: "pk_bench", token, caps: ["diff"] }),
          )
          await welcomed
          await new Promise((resolve) => setImmediate(resolve))
          const ready = new Promise<void>((resolve) => {
            socket.onReady = resolve
          })
          const sent = now()
          handler.message(
            encodeMessage({
              t: "sub",
              id: "s1",
              c: "items",
              q: scenario.mode === "hot" ? { filter: { hot: true } } : {},
            }),
          )
          await ready
          readyLatencies.push((socket.readyAt ?? now()) - sent)
        }
      }
      await Promise.all(Array.from({ length: 64 }, opener))
      const subscribeSeconds = (now() - subscribeStart) / 1000
      const snapshotDocs = sockets.reduce((total, socket) => total + socket.docs, 0)
      log(
        `  subscribed ${scenario.connections} in ${subscribeSeconds.toFixed(2)} s, ${snapshotDocs} snapshot documents`,
      )
      await new Promise((resolve) => setTimeout(resolve, 1000))
      const probe = await startProbe(dbName)
      const engineBefore = fanoutTotals(realtime)
      const cpu = process.cpuUsage()
      const wallStart = performance.now()
      let rss = 0
      let heap = 0
      const sampler = setInterval(() => {
        const memory = process.memoryUsage()
        rss = Math.max(rss, memory.rss)
        heap = Math.max(heap, memory.heapUsed)
      }, 250)
      const writer = await runWriter(dbName, scenario)
      await new Promise((resolve) => setTimeout(resolve, 3000))
      clearInterval(sampler)
      const engineAfter = fanoutTotals(realtime)
      const stream = await probe.report
      const used = process.cpuUsage(cpu)
      const wall = (performance.now() - wallStart) / 1000
      const expected =
        scenario.mode === "hot" ? writer.issued * scenario.connections : writer.issued
      const delivered = deliveries.length
      const delivery = summary(deliveries)
      const convergence = await converged(client, dbName, scenario, sockets)
      const result: ScenarioResult = {
        ...scenario,
        subscribeSeconds,
        ready: summary(readyLatencies),
        snapshotDocs,
        writes: writer.issued,
        expectedDeliveries: expected,
        convergence,
        delivery,
        stream,
        ack: writer.ack,
        engineMs:
          ((engineAfter.sum - engineBefore.sum) /
            Math.max(1, engineAfter.count - engineBefore.count)) *
          1000,
        deliveriesPerSecond: Math.round(delivered / SECONDS),
        cpuPercent: Math.round(((used.user + used.system) / 1000 / (wall * 1000)) * 100),
        rssMB: Math.round(rss / 1024 / 1024),
        heapMB: Math.round(heap / 1024 / 1024),
      }
      results.push(result)
      log(
        `  writes ${writer.issued}, delivered ${delivered}/${expected}, converged ${convergence.current}/${convergence.checked}, p50 ${delivery.p50.toFixed(1)} ms, p99 ${delivery.p99.toFixed(1)} ms (plain change stream p50 ${Number(stream.p50).toFixed(1)}, p99 ${Number(stream.p99).toFixed(1)}; write ack p50 ${writer.ack.p50.toFixed(1)}; engine ${result.engineMs.toFixed(2)} ms per event), cpu ${result.cpuPercent}%, rss ${result.rssMB} MB`,
      )
      for (const socket of sockets) socket.handler?.message(encodeMessage({ t: "bye" }))
      for (const socket of sockets) socket.close()
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
  } finally {
    await realtime.close()
    await client.db(dbName).dropDatabase()
    await client.db(`${dbName}_meta`).dropDatabase()
    await client.close()
  }
  const runtime =
    typeof (globalThis as { Bun?: unknown }).Bun === "object"
      ? `bun ${(globalThis as unknown as { Bun: { version: string } }).Bun.version}`
      : `node ${process.version}`
  const gate = {
    ratios: Object.fromEntries(
      results.map((result) => [
        `fanout ${result.name}: plain change stream p50 ÷ delivery p50`,
        result.stream.p50 / result.delivery.p50,
      ]),
    ),
    required: Object.fromEntries(
      results.map((result) => [
        `fanout ${result.name}: subscribers holding the final state of each written document`,
        {
          value: result.convergence.current / Math.max(1, result.convergence.checked),
          min: 1,
        },
      ]),
    ),
  }
  const text = `${JSON.stringify({ runtime, mongodb: String(buildInfo["version"]), docs: DOCS, owners: OWNERS, hot: HOT, seconds: SECONDS, results, gate }, null, 2)}\n`
  if (OUT === undefined) process.stdout.write(text)
  else await writeFile(OUT, text)
}

await main()
setTimeout(() => {
  log("the event loop is still alive 30 s after closing everything")
  const info = (process as { getActiveResourcesInfo?: () => string[] }).getActiveResourcesInfo?.()
  if (info !== undefined) log(`active resources: ${JSON.stringify(info)}`)
  process.exit(3)
}, 30_000).unref()
