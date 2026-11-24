import { type ChildProcess, spawn } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { cpus, platform } from "node:os"
import { fileURLToPath } from "node:url"
import { allow, auth, collection, createPolicySet } from "@canopy/policy"
import { findGatewayBinary, storedPolicies } from "@canopy/realtime"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { MongoClient } from "mongodb"
import { runtimeName } from "../d0/target.ts"
import { percentile } from "../rest/harness.ts"
import { cpuMillis, waitFor } from "../server-process.ts"

/**
 * The D2 gate of plan 004 for the writes: the same inserts, updates, replacements, deletes and batches on
 * `/rest/v1/notes`, with real JWTs and an owner policy whose checks MongoDB evaluates, sent over HTTP to the
 * TypeScript REST handler (its own process) and to the gateway with `CANOPY_DATA_PLANE_ROUTES=writes`, which
 * runs them in Rust. For each target and scenario it reports throughput, p50 and p99, and the requests per CPU
 * second of the server process alone. The gate asks for at least 1.5 times the TypeScript writes per CPU
 * second. The answers of both targets are compared before measuring. The collection is not a realtime one, so
 * the gateway's change stream leaves it out: the TypeScript handler runs no change stream, and the gate compares
 * the write paths alone.
 *
 * Environment: `CANOPY_BENCH_MONGODB_URI` (or `CANOPY_TEST_MONGODB_URI`), `CANOPY_BENCH_OWNERS` (default 200),
 * `CANOPY_BENCH_SECONDS` (per scenario and target, default 8), `CANOPY_BENCH_CONCURRENCY` (default 32),
 * `CANOPY_BENCH_ROUNDS` (alternating rounds, default 3), `CANOPY_GATEWAY_BIN` (else the release or debug build),
 * `CANOPY_BENCH_OUT` (a file for the JSON report).
 */
const URI =
  process.env["CANOPY_BENCH_MONGODB_URI"] ??
  process.env["CANOPY_TEST_MONGODB_URI"] ??
  "mongodb://localhost:27017/?replicaSet=rs0"
const OWNERS = Number(process.env["CANOPY_BENCH_OWNERS"] ?? "200")
const SECONDS = Number(process.env["CANOPY_BENCH_SECONDS"] ?? "8")
const CONCURRENCY = Number(process.env["CANOPY_BENCH_CONCURRENCY"] ?? "32")
const ROUNDS = Math.max(1, Number(process.env["CANOPY_BENCH_ROUNDS"] ?? "3"))
const OUT = process.env["CANOPY_BENCH_OUT"]
const ISSUER = "https://issuer.bench.test/"
const PUBLISHABLE = "canopy_pk_bench"
const SECRET = "canopy_sk_bench"
/** Documents per owner that the updates, replacements and batches write to. */
const OWN = 20

function log(text: string): void {
  process.stderr.write(`${text}\n`)
}

/** A request of a scenario: method, path, body, extra headers, and the statuses that count as done. */
interface Call {
  readonly method: string
  readonly path: string
  readonly body?: unknown
  readonly headers?: Readonly<Record<string, string>>
}

interface Scenario {
  readonly name: string
  /** The request for an owner; `n` is unique per request and `prefix` per target, so new ids never collide. */
  readonly call: (owner: number, n: number, prefix: string) => Call
}

const own = (owner: number, n: number, prefix: string): string => `${prefix}s-${owner}-${n % OWN}`

const SCENARIOS: readonly Scenario[] = [
  {
    name: "insert one",
    call: (owner, n, prefix) => ({
      method: "POST",
      path: "/rest/v1/notes",
      body: { _id: `${prefix}i${n}`, ownerId: `u${owner}`, title: "new", n: 0 },
    }),
  },
  {
    name: "update by id",
    call: (owner, n, prefix) => ({
      method: "PATCH",
      path: `/rest/v1/notes/${own(owner, n, prefix)}`,
      body: { $inc: { n: 1 } },
    }),
  },
  {
    name: "replace by id",
    call: (owner, n, prefix) => ({
      method: "PUT",
      path: `/rest/v1/notes/${own(owner, n, prefix)}`,
      body: { ownerId: `u${owner}`, title: `replaced ${n % 7}`, n: n % 5 },
    }),
  },
  {
    name: "delete by id",
    call: (owner, n, prefix) => ({
      method: "DELETE",
      path: `/rest/v1/notes/${prefix}d-${owner}-${n}`,
    }),
  },
  {
    name: "insert with an idempotency key",
    call: (owner, n, prefix) => ({
      method: "POST",
      path: "/rest/v1/notes",
      body: { _id: `${prefix}k${n}`, ownerId: `u${owner}`, title: "keyed" },
      headers: { "idempotency-key": `${prefix}key-${n}-${owner}` },
    }),
  },
  {
    name: "atomic batch of 4",
    call: (owner, n, prefix) => ({
      method: "POST",
      path: "/rest/v1/_batch",
      body: {
        atomic: true,
        ops: [
          { op: "insert", c: "notes", doc: { _id: `${prefix}b${n}`, ownerId: `u${owner}` } },
          { op: "update", c: "notes", id: own(owner, n, prefix), update: { $inc: { n: 1 } } },
          { op: "update", c: "notes", id: own(owner, n + 1, prefix), update: { $inc: { n: 1 } } },
          { op: "update", c: "notes", id: own(owner, n + 2, prefix), update: { $inc: { n: 1 } } },
        ],
      },
    }),
  },
  {
    name: "batch of 4, not atomic",
    call: (owner, n, prefix) => ({
      method: "POST",
      path: "/rest/v1/_batch",
      body: {
        ops: [0, 1, 2, 3].map((k) => ({
          op: "update",
          c: "notes",
          id: own(owner, n + k, prefix),
          update: { $set: { title: `each ${n % 3}` } },
        })),
      },
    }),
  },
]

/** The documents a delete scenario consumes, per target and owner. */
const DELETABLE = Number(process.env["CANOPY_BENCH_DELETABLE"] ?? "400")

function send(base: string, call: Call, token: string): Promise<Response> {
  return fetch(`${base}${call.path}`, {
    method: call.method,
    headers: {
      apikey: PUBLISHABLE,
      authorization: `Bearer ${token}`,
      ...(call.body === undefined ? {} : { "content-type": "application/json" }),
      ...call.headers,
    },
    ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
  })
}

interface Window {
  readonly requests: number
  readonly errors: number
  readonly seconds: number
  readonly cpuMillis: number
  readonly latencies: number[]
}

async function closedLoop(
  target: { readonly base: string; readonly pid: number; readonly prefix: string },
  scenario: Scenario,
  tokens: readonly string[],
  seconds: number,
  counter: { n: number; deletes: number[] },
): Promise<Window> {
  const latencies: number[] = []
  let requests = 0
  let errors = 0
  const cpuBefore = cpuMillis(target.pid)
  const started = performance.now()
  const deadline = started + seconds * 1000
  const worker = async (): Promise<void> => {
    while (performance.now() < deadline) {
      const owner = Math.floor(Math.random() * OWNERS)
      let n: number
      if (scenario.name === "delete by id") {
        n = counter.deletes[owner] ?? 0
        counter.deletes[owner] = n + 1
      } else {
        n = counter.n
        counter.n += 1
      }
      if (scenario.name === "delete by id" && n >= DELETABLE) continue
      const sent = performance.now()
      const response = await send(
        target.base,
        scenario.call(owner, n, target.prefix),
        tokens[owner] ?? "",
      )
      await response.arrayBuffer()
      latencies.push(performance.now() - sent)
      if (response.status < 300) requests += 1
      else errors += 1
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  const elapsed = (performance.now() - started) / 1000
  return {
    requests,
    errors,
    seconds: elapsed,
    cpuMillis: cpuMillis(target.pid) - cpuBefore,
    latencies,
  }
}

/** A body without its cluster times, with the target's id prefix replaced, so both targets compare. */
function comparable(text: string, prefix: string): string {
  return text.replace(/"ct":"\d+"/g, '"ct":"<ct>"').replaceAll(prefix, "<prefix>")
}

async function main(): Promise<void> {
  const gatewayBinary = findGatewayBinary(process.env)
  if (gatewayBinary === undefined)
    throw new Error("Build the gateway first: cargo build --release -p canopy-gateway")
  const database = `canopy_d2_${process.pid}`
  const metaDatabase = `${database}_meta`
  const mongo = new MongoClient(URI)
  await mongo.connect()
  const children: ChildProcess[] = []
  try {
    const notes = mongo.db(database).collection<{ _id: string; ownerId: string }>("notes")
    const seeded = []
    for (let owner = 0; owner < OWNERS; owner += 1) {
      for (const prefix of ["ts", "rs"]) {
        for (let k = 0; k < OWN; k += 1)
          seeded.push({
            _id: `${prefix}s-${owner}-${k}`,
            ownerId: `u${owner}`,
            title: "seed",
            n: 0,
          })
        for (let k = 0; k < DELETABLE; k += 1)
          seeded.push({ _id: `${prefix}d-${owner}-${k}`, ownerId: `u${owner}` })
      }
    }
    log(`seeding ${seeded.length} notes`)
    for (let at = 0; at < seeded.length; at += 10_000)
      await notes.insertMany(seeded.slice(at, at + 10_000))

    const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" })
    const jwk = { ...(await exportJWK(publicKey)), kid: "bench", alg: "EdDSA" }
    const tokens = await Promise.all(
      Array.from({ length: OWNERS }, (_, n) =>
        new SignJWT({})
          .setProtectedHeader({ alg: "EdDSA", kid: "bench" })
          .setSubject(`u${n}`)
          .setIssuer(ISSUER)
          .setIssuedAt()
          .setExpirationTime("2h")
          .sign(privateKey),
      ),
    )
    const set = createPolicySet([
      collection("notes", {
        exposed: true,
        realtime: false,
        policies: [
          allow.read("authenticated").where({ ownerId: auth("sub") }),
          allow.insert("authenticated").check({ ownerId: auth("sub") }),
          allow
            .update("authenticated")
            .where({ ownerId: auth("sub") })
            .check({ ownerId: auth("sub") }),
          allow.delete("authenticated").where({ ownerId: auth("sub") }),
        ],
      }),
    ])
    const { stored, contexts } = storedPolicies(set)
    const jwks = { keys: [jwk] }

    const typescript = spawn(
      process.execPath,
      [
        "--conditions=@canopy/source",
        fileURLToPath(new URL("../d1/ts-server.ts", import.meta.url)),
      ],
      { stdio: ["pipe", "pipe", "inherit"] },
    )
    children.push(typescript)
    typescript.stdin?.write(
      `${JSON.stringify({ uri: URI, database, metaDatabase, issuer: ISSUER, jwks, publishable: [PUBLISHABLE], secret: [SECRET], stored, contexts })}\n`,
    )
    const tsBase = `http://127.0.0.1:${Number((await waitFor(typescript, /\{"port":(\d+)\}/))[1])}`

    const gateway = spawn(gatewayBinary, ["--config", "-"], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, CANOPY_DATA_PLANE_ROUTES: "writes" },
    })
    children.push(gateway)
    gateway.stdin?.write(
      `${JSON.stringify({
        mongodb: { uri: URI, database, metaDatabase },
        server: { host: "127.0.0.1", port: 0, metricsPort: 0 },
        auth: { issuer: ISSUER, jwks },
        keys: { publishable: [PUBLISHABLE], secret: [SECRET] },
        policies: { stored, contexts },
        realtime: { checkpoints: "off", drainWindowMs: 100 },
        rateLimits: false,
        proxy: { url: tsBase },
        log: { level: "error" },
      })}\n`,
    )
    const gatewayPort = Number((await waitFor(gateway, /\{"t":"listening","port":(\d+)\}/))[1])
    const targets = [
      { name: "typescript", base: tsBase, pid: typescript.pid ?? 0, prefix: "ts" },
      {
        name: "rust",
        base: `http://127.0.0.1:${gatewayPort}`,
        pid: gateway.pid ?? 0,
        prefix: "rs",
      },
    ]
    const counters = new Map(
      targets.map((target) => [target.name, { n: 1_000_000, deletes: [] as number[] }]),
    )

    for (const scenario of SCENARIOS) {
      const answers = await Promise.all(
        targets.map(async (target) => {
          const counter = counters.get(target.name) ?? { n: 0, deletes: [] }
          const n = scenario.name === "delete by id" ? DELETABLE - 1 : counter.n++
          const owner = 7 % OWNERS
          const response = await send(
            target.base,
            scenario.call(owner, n, target.prefix),
            tokens[owner] ?? "",
          )
          return {
            status: response.status,
            servedBy: target.name,
            body: comparable(await response.text(), target.prefix),
          }
        }),
      )
      const [ts, rust] = answers
      if (
        ts === undefined ||
        rust === undefined ||
        ts.status >= 300 ||
        ts.status !== rust.status ||
        ts.body !== rust.body
      )
        throw new Error(
          `The targets answer ${scenario.name} differently: ${JSON.stringify(answers)}`,
        )
    }
    log("both targets answer the same")

    const report = []
    for (const scenario of SCENARIOS) {
      for (const target of targets)
        await closedLoop(
          target,
          scenario,
          tokens,
          1,
          counters.get(target.name) ?? { n: 0, deletes: [] },
        )
      const windows = new Map<string, Window[]>()
      for (let round = 0; round < ROUNDS; round += 1) {
        for (const target of round % 2 === 0 ? targets : [...targets].reverse()) {
          const window = await closedLoop(
            target,
            scenario,
            tokens,
            SECONDS / ROUNDS,
            counters.get(target.name) ?? { n: 0, deletes: [] },
          )
          windows.set(target.name, [...(windows.get(target.name) ?? []), window])
        }
      }
      const results: Record<string, unknown> = {}
      const perCpu: Record<string, number> = {}
      for (const [name, list] of windows) {
        const requests = list.reduce((sum, window) => sum + window.requests, 0)
        const errors = list.reduce((sum, window) => sum + window.errors, 0)
        const seconds = list.reduce((sum, window) => sum + window.seconds, 0)
        const cpu = list.reduce((sum, window) => sum + window.cpuMillis, 0) / 1000
        const latencies = list.flatMap((window) => window.latencies).sort((a, b) => a - b)
        perCpu[name] = requests / cpu
        results[name] = {
          requests,
          errors,
          perSecond: Math.round(requests / seconds),
          serverCpuSeconds: Math.round(cpu * 100) / 100,
          requestsPerCpuSecond: Math.round(requests / cpu),
          cpuMillisPerRequest: Math.round(((cpu * 1000) / requests) * 1000) / 1000,
          p50: Math.round(percentile(latencies, 50) * 100) / 100,
          p99: Math.round(percentile(latencies, 99) * 100) / 100,
        }
      }
      const ratio = (perCpu["rust"] ?? 0) / (perCpu["typescript"] ?? 1)
      report.push({ scenario: scenario.name, ...results, rustOverTypescriptPerCpu: ratio })
      log(
        `${scenario.name.padEnd(32)} rust ÷ typescript per CPU second ${ratio.toFixed(2)}  ${JSON.stringify(results)}`,
      )
    }
    const text = `${JSON.stringify(
      {
        format: "canopy-d2-writes/1",
        measuredAt: new Date().toISOString(),
        runtime: runtimeName(),
        os: platform(),
        cpu: { model: cpus()[0]?.model.trim() ?? "unknown", count: cpus().length },
        mongodb: String((await mongo.db("admin").command({ buildInfo: 1 }))["version"]),
        config: {
          owners: OWNERS,
          seconds: SECONDS,
          concurrency: CONCURRENCY,
          rounds: ROUNDS,
          deletable: DELETABLE,
        },
        gate: { requires: 1.5, measure: "write requests per CPU second of the server process" },
        scenarios: report,
      },
      null,
      2,
    )}\n`
    if (OUT === undefined) process.stdout.write(text)
    else await writeFile(OUT, text)
  } finally {
    for (const child of children) child.kill()
    await mongo.db(database).dropDatabase()
    await mongo.db(metaDatabase).dropDatabase()
    await mongo.close()
  }
}

await main()
