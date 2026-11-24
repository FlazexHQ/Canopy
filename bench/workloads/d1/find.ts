import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { cpus, platform } from "node:os"
import { fileURLToPath } from "node:url"
import { allow, auth, collection, createPolicySet } from "@canopy/policy"
import { findGatewayBinary, storedPolicies } from "@canopy/realtime"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { MongoClient } from "mongodb"
import { runtimeName } from "../d0/target.ts"
import { percentile } from "../rest/harness.ts"
import { type Order, OWNERS, STATUSES, seedTo } from "../rest/scenarios.ts"

/**
 * The D1 gate of plan 004 for the reads: the same `find`, `_query`, `_count`, `_distinct` and `_aggregate` requests on
 * `/rest/v1/orders`, with real JWTs, sent over HTTP to the TypeScript REST handler (its own process) and to the
 * gateway with `CANOPY_DATA_PLANE_ROUTES=find,count,distinct,aggregate,query`, which answers them in Rust. For each target and scenario it reports throughput, p50 and p99, and the
 * requests per CPU second of the server process alone (read from the operating system the same way for both,
 * so the load generator and MongoDB are left out). The gate asks for at least 1.5 times the TypeScript
 * requests per CPU second on simple reads. The answers of both targets are compared before measuring.
 *
 * Environment: `CANOPY_BENCH_MONGODB_URI` (or `CANOPY_TEST_MONGODB_URI`), `CANOPY_BENCH_DOCS` (default
 * 100000), `CANOPY_BENCH_SECONDS` (per scenario and target, default 8), `CANOPY_BENCH_CONCURRENCY` (default
 * 32), `CANOPY_BENCH_ROUNDS` (alternating rounds, default 3), `CANOPY_BENCH_CREDENTIALS` (`jwt` or `service`), `CANOPY_GATEWAY_BIN` (else the release or debug
 * build), `CANOPY_BENCH_OUT` (a file for the JSON report).
 */
const URI =
  process.env["CANOPY_BENCH_MONGODB_URI"] ??
  process.env["CANOPY_TEST_MONGODB_URI"] ??
  "mongodb://localhost:27017/?replicaSet=rs0"
const DOCS = Number(process.env["CANOPY_BENCH_DOCS"] ?? "100000")
const SECONDS = Number(process.env["CANOPY_BENCH_SECONDS"] ?? "8")
const CONCURRENCY = Number(process.env["CANOPY_BENCH_CONCURRENCY"] ?? "32")
const ROUNDS = Math.max(1, Number(process.env["CANOPY_BENCH_ROUNDS"] ?? "3"))
const OUT = process.env["CANOPY_BENCH_OUT"]
const ISSUER = "https://issuer.bench.test/"
const PUBLISHABLE = "canopy_pk_bench"
const SECRET = "canopy_sk_bench"

/** `jwt` (default): a publishable key and the owner's token; `service`: the secret key, which bypasses DLS. */
const CREDENTIALS = process.env["CANOPY_BENCH_CREDENTIALS"] === "service" ? "service" : "jwt"

function credentials(tokens: readonly string[], owner: number): Record<string, string> {
  return CREDENTIALS === "service"
    ? { apikey: SECRET }
    : { apikey: PUBLISHABLE, authorization: `Bearer ${tokens[owner]}` }
}

function log(text: string): void {
  process.stderr.write(`${text}\n`)
}

/** CPU milliseconds a process has used so far, from the operating system. */
function cpuMillis(pid: number): number {
  const os = platform()
  if (os === "linux") {
    const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.split(" ") ?? []
    const ticks = Number(fields[11]) + Number(fields[12])
    const hertz = Number(execFileSync("getconf", ["CLK_TCK"]).toString().trim())
    return (ticks * 1000) / hertz
  }
  if (os === "win32") {
    const text = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `[int64](Get-Process -Id ${pid}).TotalProcessorTime.TotalMilliseconds`,
      ],
      { windowsHide: true },
    )
    return Number(text.toString().trim())
  }
  const time = execFileSync("ps", ["-o", "time=", "-p", String(pid)])
    .toString()
    .trim()
  const [rest, fraction] = time.split(".")
  const parts = (rest ?? "").split(/[-:]/).map(Number)
  let seconds = 0
  for (const part of parts) seconds = seconds * 60 + part
  return (seconds + Number(`0.${fraction ?? "0"}`)) * 1000
}

/** Reads lines from a child's stdout until `pattern` matches one. */
function waitFor(child: ChildProcess, pattern: RegExp): Promise<RegExpExecArray> {
  return new Promise((resolve, reject) => {
    let pending = ""
    child.stdout?.on("data", (chunk: Buffer) => {
      pending += chunk.toString()
      const match = pattern.exec(pending)
      if (match !== null) resolve(match)
    })
    child.once("exit", (code) => reject(new Error(`a server exited with ${code}`)))
  })
}

interface Scenario {
  readonly name: string
  readonly target: (owner: number) => string
  /** The JSON body of a `POST`; a scenario without one is a `GET`. */
  readonly body?: (owner: number) => unknown
}

const SCENARIOS: readonly Scenario[] = [
  { name: "page of 20, owner policy", target: () => "/rest/v1/orders?sort=-createdAt&limit=20" },
  { name: "page of 100, owner policy", target: () => "/rest/v1/orders?sort=-createdAt&limit=100" },
  {
    name: "filtered page of 20",
    target: (owner) =>
      `/rest/v1/orders?status=eq.${STATUSES[owner % STATUSES.length]}&sort=-createdAt&limit=20`,
  },
  {
    name: "query page of 20",
    target: () => "/rest/v1/orders/_query",
    body: (owner) => ({
      filter: { status: STATUSES[owner % STATUSES.length] },
      sort: { createdAt: -1 },
      limit: 20,
    }),
  },
  { name: "count, owner policy", target: () => "/rest/v1/orders/_count", body: () => ({}) },
  {
    name: "filtered count",
    target: () => "/rest/v1/orders/_count",
    body: (owner) => ({ filter: { status: STATUSES[owner % STATUSES.length] } }),
  },
  {
    name: "distinct statuses",
    target: () => "/rest/v1/orders/_distinct",
    body: () => ({ field: "status" }),
  },
  {
    name: "aggregate by status",
    target: () => "/rest/v1/orders/_aggregate",
    body: () => ({
      pipeline: [
        { $group: { _id: "$status", n: { $sum: 1 }, amount: { $sum: "$amount" } } },
        { $sort: { _id: 1 } },
      ],
    }),
  },
]

/** Sends one request of a scenario for an owner. */
function send(
  base: string,
  scenario: Scenario,
  tokens: readonly string[],
  owner: number,
): Promise<Response> {
  const headers = credentials(tokens, owner)
  if (scenario.body === undefined) return fetch(`${base}${scenario.target(owner)}`, { headers })
  return fetch(`${base}${scenario.target(owner)}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(scenario.body(owner)),
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
  base: string,
  scenario: Scenario,
  tokens: readonly string[],
  seconds: number,
  pid: number,
): Promise<Window> {
  const latencies: number[] = []
  let requests = 0
  let errors = 0
  const cpuBefore = cpuMillis(pid)
  const started = performance.now()
  const deadline = started + seconds * 1000
  const worker = async (): Promise<void> => {
    while (performance.now() < deadline) {
      const owner = Math.floor(Math.random() * OWNERS)
      const sent = performance.now()
      const response = await send(base, scenario, tokens, owner)
      await response.arrayBuffer()
      latencies.push(performance.now() - sent)
      if (response.status === 200) requests += 1
      else errors += 1
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  const elapsed = (performance.now() - started) / 1000
  return {
    requests,
    errors,
    seconds: elapsed,
    cpuMillis: cpuMillis(pid) - cpuBefore,
    latencies,
  }
}

/** The data part of a body, without its cluster time. */
function dataOf(text: string): string {
  return text.replace(/,"ct":"\d+"\}$/, "}")
}

async function main(): Promise<void> {
  const gatewayBinary = findGatewayBinary(process.env)
  if (gatewayBinary === undefined)
    throw new Error("Build the gateway first: cargo build --release -p canopy-gateway")
  const database = `canopy_d1_${process.pid}`
  const metaDatabase = `${database}_meta`
  const mongo = new MongoClient(URI)
  await mongo.connect()
  const children: ChildProcess[] = []
  try {
    const orders = mongo.db(database).collection<Order>("orders")
    await orders.createIndex({ ownerId: 1, createdAt: -1, _id: 1 })
    await orders.createIndex({ ownerId: 1, status: 1, createdAt: -1, _id: 1 })
    log(`seeding ${DOCS} orders`)
    await seedTo(orders, 0, DOCS)

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
      collection("orders", {
        exposed: true,
        policies: [allow.read("authenticated").where({ ownerId: auth("sub") })],
      }),
    ])
    const { stored, contexts } = storedPolicies(set)
    const jwks = { keys: [jwk] }

    const typescript = spawn(
      process.execPath,
      ["--conditions=@canopy/source", fileURLToPath(new URL("./ts-server.ts", import.meta.url))],
      { stdio: ["pipe", "pipe", "inherit"] },
    )
    children.push(typescript)
    typescript.stdin?.write(
      `${JSON.stringify({ uri: URI, database, metaDatabase, issuer: ISSUER, jwks, publishable: [PUBLISHABLE], secret: [SECRET], stored, contexts })}\n`,
    )
    const tsPort = Number((await waitFor(typescript, /\{"port":(\d+)\}/))[1])
    const tsBase = `http://127.0.0.1:${tsPort}`

    const gateway = spawn(gatewayBinary, ["--config", "-"], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, CANOPY_DATA_PLANE_ROUTES: "find,count,distinct,aggregate,query" },
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
    const rustBase = `http://127.0.0.1:${gatewayPort}`

    const targets = [
      { name: "typescript", base: tsBase, pid: typescript.pid ?? 0 },
      { name: "rust", base: rustBase, pid: gateway.pid ?? 0 },
    ]
    for (const scenario of SCENARIOS) {
      for (const owner of [0, 1, 517]) {
        const bodies = await Promise.all(
          targets.map(async ({ base }) => {
            const response = await send(base, scenario, tokens, owner)
            return { status: response.status, data: dataOf(await response.text()) }
          }),
        )
        const [ts, rust] = bodies
        if (ts?.status !== 200 || ts.data !== rust?.data || ts.status !== rust.status)
          throw new Error(`The targets answer ${scenario.name} differently for owner ${owner}`)
      }
    }
    log("both targets answer the same")

    const report = []
    for (const scenario of SCENARIOS) {
      for (const target of targets) await closedLoop(target.base, scenario, tokens, 1, target.pid)
      const windows = new Map<string, Window[]>()
      for (let round = 0; round < ROUNDS; round += 1) {
        for (const target of round % 2 === 0 ? targets : [...targets].reverse()) {
          const window = await closedLoop(
            target.base,
            scenario,
            tokens,
            SECONDS / ROUNDS,
            target.pid,
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
        `${scenario.name.padEnd(28)} rust ÷ typescript per CPU second ${ratio.toFixed(2)}  ${JSON.stringify(results)}`,
      )
    }
    const text = `${JSON.stringify(
      {
        format: "canopy-d1-find/1",
        measuredAt: new Date().toISOString(),
        runtime: runtimeName(),
        os: platform(),
        cpu: { model: cpus()[0]?.model.trim() ?? "unknown", count: cpus().length },
        mongodb: String((await mongo.db("admin").command({ buildInfo: 1 }))["version"]),
        config: {
          docs: DOCS,
          seconds: SECONDS,
          concurrency: CONCURRENCY,
          rounds: ROUNDS,
          credentials: CREDENTIALS,
        },
        gate: { requires: 1.5, measure: "requests per CPU second of the server process" },
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
