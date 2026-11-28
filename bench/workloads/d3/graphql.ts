import { deepStrictEqual } from "node:assert/strict"
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

const URI =
  process.env["CANOPY_BENCH_MONGODB_URI"] ??
  process.env["CANOPY_TEST_MONGODB_URI"] ??
  "mongodb://localhost:27017/?replicaSet=rs0"
const OWNERS = Number(process.env["CANOPY_BENCH_OWNERS"] ?? "200")
const SECONDS = Number(process.env["CANOPY_BENCH_SECONDS"] ?? "24")
const CONCURRENCY = Number(process.env["CANOPY_BENCH_CONCURRENCY"] ?? "32")
const ROUNDS = Math.max(1, Number(process.env["CANOPY_BENCH_ROUNDS"] ?? "3"))
const OUT = process.env["CANOPY_BENCH_OUT"]
const ISSUER = "https://issuer.bench.test/"
const PUBLISHABLE = "canopy_pk_bench"
const SECRET = "canopy_sk_bench"
const OWN = 20
const SEED_FILTER = 'filter: { kind: { eq: "seed" } }'
const LIST = `todos(${SEED_FILTER}, sort: [{ field: _id, direction: ASC }], limit: ${OWN})`
const COLLECTIONS = {
  todos: {
    relations: { comments: { to: "comments", local: "_id", foreign: "todoId", many: true } },
  },
}

function log(text: string): void {
  process.stderr.write(`${text}\n`)
}

interface Scenario {
  readonly name: string
  readonly query: (owner: number, id: string) => string
}

const SCENARIOS: readonly Scenario[] = [
  { name: "list todos", query: () => `{ ${LIST} { nodes { _id title } } }` },
  {
    name: "list todos with comments",
    query: () => `{ ${LIST} { nodes { _id title comments { _id body } } } }`,
  },
  {
    name: "insert one todo",
    query: (owner, id) =>
      `mutation { insertTodo(doc: { _id: "${id}", ownerId: "u${owner}", kind: "insert", title: "new" }) { _id title } }`,
  },
]

async function send(base: string, query: string, token: string) {
  const response = await fetch(`${base}/graphql/v1`, {
    method: "POST",
    headers: {
      apikey: PUBLISHABLE,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query }),
  })
  const body: unknown = await response.json()
  const ok =
    response.ok &&
    typeof body === "object" &&
    body !== null &&
    "data" in body &&
    body.data !== null &&
    !("errors" in body)
  return { status: response.status, ok, body }
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
  counter: { n: number },
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
      const sent = performance.now()
      const response = await send(
        target.base,
        scenario.query(owner, `${target.prefix}${counter.n++}`),
        tokens[owner] ?? "",
      )
      latencies.push(performance.now() - sent)
      if (response.ok) requests += 1
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

async function main(): Promise<void> {
  const gatewayBinary = findGatewayBinary(process.env)
  if (gatewayBinary === undefined)
    throw new Error("Build the gateway first: cargo build --release -p canopyd")
  const database = `canopy_d3_${process.pid}`
  const metaDatabase = `${database}_meta`
  const mongo = new MongoClient(URI)
  await mongo.connect()
  const children: ChildProcess[] = []
  try {
    const db = mongo.db(database)
    const todos = db.collection<{ _id: string; ownerId: string; kind: string; title: string }>(
      "todos",
    )
    const comments = db.collection<{ _id: string; todoId: string; ownerId: string; body: string }>(
      "comments",
    )
    const seeded = Array.from({ length: OWNERS * OWN }, (_, n) => ({
      _id: `seed${n}`,
      ownerId: `u${Math.floor(n / OWN)}`,
      kind: "seed",
      title: "seed",
    }))
    log(`seeding ${seeded.length} todos and ${seeded.length * 2} comments`)
    await todos.insertMany(seeded)
    await comments.insertMany(
      seeded.flatMap(({ _id, ownerId }) =>
        [0, 1].map((n) => ({ _id: `${_id}c${n}`, todoId: _id, ownerId, body: "comment" })),
      ),
    )
    await todos.createIndex({ ownerId: 1, kind: 1, _id: 1 })
    await comments.createIndex({ ownerId: 1, todoId: 1 })

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
      collection("todos", {
        exposed: true,
        realtime: false,
        policies: [
          allow.read("authenticated").where({ ownerId: auth("sub") }),
          allow.insert("authenticated").check({ ownerId: auth("sub") }),
        ],
      }),
      collection("comments", {
        exposed: true,
        realtime: false,
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
      `${JSON.stringify({ uri: URI, database, metaDatabase, issuer: ISSUER, jwks, publishable: [PUBLISHABLE], secret: [SECRET], stored, contexts, collections: COLLECTIONS })}\n`,
    )
    const tsBase = `http://127.0.0.1:${Number((await waitFor(typescript, /\{"port":(\d+)\}/))[1])}`

    const gateway = spawn(gatewayBinary, ["--config", "-"], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, CANOPY_DATA_PLANE_ROUTES: "graphql" },
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
        graphql: { collections: COLLECTIONS },
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
    const counter = { n: 0 }
    const owner = 7 % OWNERS
    for (const scenario of SCENARIOS) {
      const answers = []
      for (const target of targets) {
        const answer = await send(target.base, scenario.query(owner, "parity"), tokens[owner] ?? "")
        if (!answer.ok)
          throw new Error(`${target.name} failed ${scenario.name}: ${JSON.stringify(answer)}`)
        answers.push(answer)
        await todos.deleteOne({ _id: "parity" })
      }
      deepStrictEqual(answers[0], answers[1], `The targets answer ${scenario.name} differently`)
    }
    log("both targets answer the same")

    const report = []
    for (const scenario of SCENARIOS) {
      for (const target of targets) await closedLoop(target, scenario, tokens, 1, counter)
      const windows = new Map<string, Window[]>()
      for (let round = 0; round < ROUNDS; round += 1) {
        for (const target of round % 2 === 0 ? targets : [...targets].reverse()) {
          const window = await closedLoop(target, scenario, tokens, SECONDS / ROUNDS, counter)
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
        format: "canopy-d3-graphql/1",
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
        },
        gate: { requires: null, measure: "GraphQL requests per CPU second of the server process" },
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
