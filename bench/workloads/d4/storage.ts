import { deepStrictEqual, strictEqual } from "node:assert/strict"
import { type ChildProcess, execFile, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { cpus, platform, tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { Authenticator } from "@canopy/auth"
import { toNodeListener } from "@canopy/node-http"
import {
  allow,
  ContextResolver,
  collection,
  createPolicySet,
  fromStored,
  PolicyEngine,
} from "@canopy/policy"
import { findGatewayBinary, storedPolicies } from "@canopy/realtime"
import { MongoClient } from "mongodb"
import {
  createStorageHandler,
  localBackend,
  Storage,
  UrlSigner,
} from "../../../packages/storage/src/index.ts"
import { runtimeName } from "../d0/target.ts"
import { percentile } from "../rest/harness.ts"
import { cpuMillis, waitFor } from "../server-process.ts"

const MIB = 1024 * 1024
const RANGE_BYTES = 64 * 1024
const UPLOAD_BYTES = 16 * MIB
const MAX_UPLOADS_PER_WINDOW = 2048
const KEY = "canopy_pk_bench"
const PATH = "/storage/v1/object/files"
const SIGNING_KEY = "benchmark storage signing key"
const MEDIA_TYPE = "application/octet-stream"
const BUCKETS = {
  files: {
    public: false,
    maxFileSize: UPLOAD_BYTES,
    allowedTypes: [MEDIA_TYPE],
  },
}
const ISSUER = "https://issuer.bench.test/"
const storagePolicies = createPolicySet([
  collection("storage.objects", {
    exposed: true,
    policies: [
      allow.read("anon").where({ bucket: "files" }),
      allow.insert("anon").check({ bucket: "files" }),
    ],
  }),
])

interface Setup {
  readonly uri: string
  readonly metaDatabase: string
  readonly root: string
  readonly stored: readonly unknown[]
}

async function serve(): Promise<void> {
  const reader = createInterface({ input: process.stdin })
  const [line] = await once(reader, "line")
  reader.close()
  const setup = JSON.parse(String(line)) as Setup
  const client = new MongoClient(setup.uri)
  await client.connect()
  const engine = new PolicyEngine(createPolicySet(setup.stored.map(fromStored)))
  const policies = () => engine
  const handler = createStorageHandler({
    storage: new Storage({
      client,
      metaDatabase: setup.metaDatabase,
      policies,
      backend: await localBackend({ root: setup.root }),
      buckets: BUCKETS,
      signer: new UrlSigner(SIGNING_KEY),
    }),
    policies,
    authenticator: new Authenticator(
      { issuer: ISSUER, jwks: { keys: [] } },
      { publishable: [KEY], secret: [] },
    ),
    contexts: new ContextResolver({ reader: async () => [] }),
    onError: (error) => process.stderr.write(`${String(error)}\n`),
  })
  const server = createServer(toNodeListener((request, info) => handler.fetch(request, info)))
  server.keepAliveTimeout = 60_000
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  process.stdout.write(`${JSON.stringify({ port: (server.address() as AddressInfo).port })}\n`)
}

const scenarios = [
  { name: "upload 1 MiB", status: 201, bytes: MIB },
  { name: "download 1 MiB", status: 200, bytes: MIB },
  { name: "download range 64 KiB", status: 206, bytes: RANGE_BYTES },
] as const
type Scenario = (typeof scenarios)[number]
type TargetName = "typescript" | "rust"
type Target = {
  readonly name: TargetName
  readonly base: string
  readonly pid: number
}

function setting(name: string, fallback: number): number {
  const value = Number(process.env[`CANOPY_BENCH_${name}`] ?? fallback)
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`Invalid benchmark setting ${name}`)
  return value
}

async function transfer(target: Target, path: string, status: number, body?: Buffer<ArrayBuffer>) {
  const headers = new Headers({ apikey: KEY, "x-request-id": "d4" })
  if (body !== undefined) headers.set("content-type", MEDIA_TYPE)
  if (status === 206) headers.set("range", `bytes=0-${RANGE_BYTES - 1}`)
  const response = await fetch(`${target.base}${PATH}/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    ...(body === undefined ? {} : { body }),
    signal: AbortSignal.timeout(60_000),
  })
  const bytes = Buffer.from(await response.arrayBuffer())
  strictEqual(
    response.status,
    status,
    `${target.name} ${path}: ${response.status === status ? "" : bytes.toString()}`,
  )
  return { headers: response.headers, bytes, status: response.status }
}

const PARITY_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "cache-control",
  "content-disposition",
  "vary",
  "x-request-id",
]

async function parity(target: Target, path: string, payload: Buffer<ArrayBuffer>) {
  return Promise.all(
    scenarios.slice(1).map(async ({ status, bytes }) => {
      const answer = await transfer(target, path, status)
      deepStrictEqual(answer.bytes, payload.subarray(0, bytes))
      return {
        status: answer.status,
        headers: PARITY_HEADERS.map((name) => answer.headers.get(name)),
        bytes: answer.bytes,
      }
    }),
  )
}

async function measure(
  target: Target,
  scenario: Scenario,
  payload: Buffer<ArrayBuffer>,
  seconds: number,
  concurrency: number,
  round: number,
) {
  const upload = scenario.status === 201
  const latencies: number[] = []
  let issued = 0
  const cpuBefore = cpuMillis(target.pid)
  const start = performance.now()
  const deadline = start + seconds * 1000
  const worker = async () => {
    while (performance.now() < deadline && (!upload || issued < MAX_UPLOADS_PER_WINDOW)) {
      const sent = performance.now()
      const answer = await transfer(
        target,
        upload ? `${target.name}-${round}-${issued++}` : `seed-${target.name}`,
        scenario.status,
        upload ? payload : undefined,
      )
      if (!upload) strictEqual(answer.bytes.length, scenario.bytes)
      latencies.push(performance.now() - sent)
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  return {
    latencies,
    seconds: (performance.now() - start) / 1000,
    cpu: (cpuMillis(target.pid) - cpuBefore) / 1000,
  }
}

const run = promisify(execFile)

async function memory(pid: number) {
  if (platform() === "linux") {
    const status = await readFile(`/proc/${pid}/status`, "utf8")
    return {
      rss: Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1]) * 1024,
      peak: Number(/^VmHWM:\s+(\d+)/m.exec(status)?.[1]) * 1024,
    }
  }
  if (platform() === "win32") {
    const { stdout } = await run(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Get-Process -Id ${pid} | ForEach-Object { $_.WorkingSet64; $_.PeakWorkingSet64 }`,
      ],
      { windowsHide: true },
    )
    const [rss, peak] = stdout.trim().split(/\s+/).map(Number)
    return { rss: rss ?? 0, peak: peak ?? 0 }
  }
  const { stdout } = await run("ps", ["-o", "rss=", "-p", String(pid)])
  const rss = Number(stdout.trim()) * 1024
  return { rss, peak: rss }
}

async function measureMemory(
  target: Target,
  concurrentUploads: number,
  payload: Buffer<ArrayBuffer>,
) {
  const before = await memory(target.pid)
  let peak = before.rss
  let active = true
  const updatePeak = async () => {
    const sample = await memory(target.pid)
    peak = Math.max(peak, sample.rss, sample.peak > before.peak ? sample.peak : 0)
  }
  const sample = async () => {
    while (active) {
      await updatePeak()
      await delay(10)
    }
  }
  const uploads = async () => {
    try {
      await Promise.all(
        Array.from({ length: concurrentUploads }, (_, index) =>
          transfer(target, `memory-${target.name}-${index}`, 201, payload),
        ),
      )
    } finally {
      active = false
    }
  }
  await Promise.all([sample(), uploads()])
  await updatePeak()
  if (!Number.isFinite(peak) || before.rss <= 0)
    throw new Error(`Invalid RSS sample for ${target.name}`)
  return {
    baselineRssBytes: before.rss,
    peakRssBytes: peak,
    peakIncreaseBytesPerUpload: Math.round((peak - before.rss) / concurrentUploads),
  }
}

function log(value: unknown): void {
  process.stderr.write(`${JSON.stringify(value)}\n`)
}

async function main(): Promise<void> {
  const uri =
    process.env["CANOPY_BENCH_MONGODB_URI"] ??
    process.env["CANOPY_TEST_MONGODB_URI"] ??
    "mongodb://localhost:27017/?replicaSet=rs0"
  const seconds = setting("SECONDS", 28)
  const concurrency = setting("CONCURRENCY", 8)
  const rounds = setting("ROUNDS", 2)
  const concurrentUploads = setting("MEMORY_UPLOADS", 8)
  const binary = findGatewayBinary(process.env)
  if (binary === undefined) throw new Error("Build canopy-gateway before running D4")
  const database = `canopy_d4_${process.pid}`
  const metaDatabase = `${database}_meta`
  await using mongo = new MongoClient(uri)
  await mongo.connect()
  const root = await mkdtemp(join(tmpdir(), "canopy-d4-"))
  const children: ChildProcess[] = []
  try {
    const collection = mongo.db(metaDatabase).collection("storage_objects")
    await collection.createIndex({ bucket: 1, path: 1 }, { unique: true })
    const { stored, contexts } = storedPolicies(storagePolicies)
    async function launch(
      name: TargetName,
      command: string,
      args: string[],
      setup: unknown,
      listening: RegExp,
    ): Promise<Target> {
      const child = spawn(command, args, {
        stdio: ["pipe", "pipe", "inherit"],
        env: { ...process.env, CANOPY_DATA_PLANE_ROUTES: "storage" },
      })
      children.push(child)
      const pid = child.pid
      if (pid === undefined) {
        await once(child, "spawn")
        throw new Error(`Missing process ID for ${name}`)
      }
      child.stdin.write(`${JSON.stringify(setup)}\n`)
      const port = (await waitFor(child, listening))[1]
      return { name, pid, base: `http://127.0.0.1:${port}` }
    }
    const ts = await launch(
      "typescript",
      process.execPath,
      ["--conditions=@canopy/source", fileURLToPath(import.meta.url), "--serve"],
      { uri, metaDatabase, root: join(root, "typescript"), stored },
      /\{"port":(\d+)\}/,
    )
    const rust = await launch(
      "rust",
      binary,
      ["--config", "-"],
      {
        mongodb: { uri, database, metaDatabase },
        server: { host: "127.0.0.1", port: 0, metricsPort: 0 },
        auth: { issuer: ISSUER, jwks: { keys: [] } },
        keys: { publishable: [KEY] },
        policies: { stored, contexts },
        realtime: { checkpoints: "off", drainWindowMs: 100 },
        rateLimits: false,
        storage: {
          buckets: BUCKETS,
          backend: { kind: "local", root: join(root, "rust") },
          signingMasterKey: SIGNING_KEY,
        },
        log: { level: "error" },
      },
      /\{"t":"listening","port":(\d+)\}/,
    )
    const targets = [ts, rust]
    const payload = randomBytes(MIB)
    const answers = []
    for (const target of targets) {
      const answer = await transfer(target, "parity", 201, payload)
      const body = answer.bytes
        .toString()
        .replace(
          /"(createdAt|updatedAt)":"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z"/g,
          '"$1":"<timestamp>"',
        )
      answers.push({
        upload: {
          status: answer.status,
          body,
          headers: PARITY_HEADERS.filter((name) => name !== "content-length").map((name) =>
            answer.headers.get(name),
          ),
        },
        downloads: await parity(target, "parity", payload),
      })
      await collection.deleteOne({ bucket: "files", path: "parity" })
      await transfer(target, `seed-${target.name}`, 201, payload)
    }
    deepStrictEqual(answers[0], answers[1], "Storage responses differ")
    log("Storage parity passed")

    const largePayload = randomBytes(UPLOAD_BYTES)
    const memoryResults = {
      typescript: await measureMemory(ts, concurrentUploads, largePayload),
      rust: await measureMemory(rust, concurrentUploads, largePayload),
    }
    log({ memory: memoryResults })
    const report = []
    for (const scenario of scenarios) {
      const windows: Record<TargetName, Awaited<ReturnType<typeof measure>>[]> = {
        typescript: [],
        rust: [],
      }
      for (let round = 0; round < rounds; round++) {
        for (const target of round % 2 === 0 ? targets : [...targets].reverse()) {
          windows[target.name].push(
            await measure(target, scenario, payload, seconds / rounds, concurrency, round),
          )
        }
      }
      function summarize(list: Awaited<ReturnType<typeof measure>>[]) {
        const latencies = list.flatMap((window) => window.latencies).sort((a, b) => a - b)
        const requests = latencies.length
        const cpu = list.reduce((sum, window) => sum + window.cpu, 0)
        const elapsed = list.reduce((sum, window) => sum + window.seconds, 0)
        if (requests === 0 || !Number.isFinite(cpu) || cpu <= 0)
          throw new Error(`Insufficient CPU sample for ${scenario.name}`)
        return {
          requests,
          errors: 0,
          perSecond: Math.round(requests / elapsed),
          mibPerSecond: (requests * scenario.bytes) / MIB / elapsed,
          serverCpuSeconds: cpu,
          requestsPerCpuSecond: requests / cpu,
          cpuMillisPerRequest: (cpu * 1000) / requests,
          p50: percentile(latencies, 50),
          p99: percentile(latencies, 99),
        }
      }
      const typescript = summarize(windows.typescript)
      const rust = summarize(windows.rust)
      const result = {
        scenario: scenario.name,
        typescript,
        rust,
        rustOverTypescriptPerCpu: rust.requestsPerCpuSecond / typescript.requestsPerCpuSecond,
      }
      report.push(result)
      log(result)
    }
    const output = `${JSON.stringify(
      {
        format: "canopy-d4-storage/1",
        measuredAt: new Date().toISOString(),
        runtime: runtimeName(),
        os: platform(),
        cpu: {
          model: cpus()[0]?.model.trim() ?? "unknown",
          count: cpus().length,
        },
        mongodb: String((await mongo.db("admin").command({ buildInfo: 1 }))["version"]),
        config: {
          seconds,
          concurrency,
          rounds,
          maxUploadsPerWindow: MAX_UPLOADS_PER_WINDOW,
          concurrentUploads,
          uploadBytes: UPLOAD_BYTES,
        },
        gate: {
          requires: null,
          measure: "Storage requests per server CPU second, MiB per second and peak upload RSS",
        },
        scenarios: report,
        memory: memoryResults,
      },
      null,
      2,
    )}\n`
    const out = process.env["CANOPY_BENCH_OUT"]
    if (out === undefined) process.stdout.write(output)
    else await writeFile(out, output)
  } finally {
    await Promise.all(
      children.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return
        const exited = once(child, "exit")
        child.kill()
        await exited
      }),
    )
    await Promise.all([
      mongo.db(database).dropDatabase(),
      mongo.db(metaDatabase).dropDatabase(),
      rm(root, { recursive: true, force: true, maxRetries: 3 }),
    ])
  }
}

if (process.argv[2] === "--serve") await serve()
else await main()
