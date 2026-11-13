import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { Miniflare } from "miniflare"
import WebSocket from "ws"

const N = Number(process.argv[2] ?? 10000)
const PER_DO = Number(process.argv[3] ?? 1000)
const SHARDS = Math.ceil(N / PER_DO)
const REPEAT = 7

const fnv = (text) => {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0
  return hash
}

function workerdMemoryMb() {
  try {
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq workerd.exe", "/FO", "CSV", "/NH"], { encoding: "utf8" })
    return out
      .trim()
      .split(/\r?\n/)
      .filter((line) => line.includes("workerd"))
      .reduce((sum, line) => sum + Number(line.split('","')[4].replace(/[^\d]/g, "")) / 1024, 0)
  } catch {
    return Number.NaN
  }
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

const mf = new Miniflare({
  modules: true,
  scriptPath: new URL("./worker.js", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"),
  compatibilityDate: "2026-07-01",
  durableObjects: { CONNECTION: "Connection", TOPIC: "Topic" },
  port: 0,
})
const base = await mf.ready
const wsBase = base.href.replace(/^http/, "ws")
const memoryIdle = workerdMemoryMb()

const users = Array.from({ length: N }, (_, i) => `u${i}`)
const received = new Map()
let total = 0
const sockets = []
const started = performance.now()
for (let offset = 0; offset < N; offset += 250) {
  await Promise.all(
    users.slice(offset, offset + 250).map(
      (user) =>
        new Promise((resolve, reject) => {
          const shard = fnv(user) % SHARDS
          const ws = new WebSocket(`${wsBase}connect?shard=${shard}&user=${user}&c=todos`)
          ws.on("open", () => resolve())
          ws.on("error", reject)
          ws.on("message", () => {
            total += 1
            received.set(user, (received.get(user) ?? 0) + 1)
          })
          sockets.push(ws)
        }),
    ),
  )
}
const connectMs = performance.now() - started
await new Promise((resolve) => setTimeout(resolve, 2000))
const memoryConnected = workerdMemoryMb()

async function waitFor(target, timeoutMs = 60000) {
  const start = performance.now()
  while (total < target) {
    if (performance.now() - start > timeoutMs) throw new Error(`timeout at ${total}/${target}`)
    await new Promise((resolve) => setImmediate(resolve))
  }
}

async function scenario(mode, name, makeEvents, expected) {
  const latencies = []
  const relays = []
  let last
  for (let run = 0; run < REPEAT; run += 1) {
    const events = makeEvents(run)
    const target = total + expected
    const start = performance.now()
    const response = await fetch(`${base}relay?c=todos&shards=${SHARDS}&mode=${mode}`, {
      method: "POST",
      body: JSON.stringify({ collection: "todos", events }),
    })
    last = await response.json()
    relays.push(performance.now() - start)
    await waitFor(target)
    latencies.push(performance.now() - start)
  }
  return { mode, name, relayP50Ms: median(relays), p50Ms: median(latencies), maxMs: Math.max(...latencies), ...last }
}

const pick = (run, k) => users[(run * 7919 + k * 104729) % N]
const results = []
for (const mode of ["broadcast", "index"]) {
  if (mode === "index") await fetch(`${base}relay?c=todos&shards=${SHARDS}&mode=index`, { method: "POST", body: JSON.stringify({ collection: "todos", events: [] }) })
  results.push(await scenario(mode, "1 private event", (run) => [{ id: run, owner: pick(run, 0), set: { done: true } }], 1))
  results.push(
    await scenario(mode, "100 private events", (run) => Array.from({ length: 100 }, (_, k) => ({ id: k, owner: pick(run, k), set: { done: true } })), 100),
  )
  results.push(
    await scenario(mode, "1000 private events", (run) => Array.from({ length: 1000 }, (_, k) => ({ id: k, owner: pick(run, k), set: { done: true } })), 1000),
  )
  results.push(await scenario(mode, "1 public event", (run) => [{ id: run, public: true, set: { title: "x" } }], N))
}

const inbound = Math.min(1000, N)
const ackTarget = total + inbound
const inboundStart = performance.now()
for (let i = 0; i < inbound; i += 1) sockets[i].send(JSON.stringify({ t: "sub", id: `s${i}` }))
await waitFor(ackTarget)
const inboundMs = performance.now() - inboundStart

const report = {
  sockets: N,
  socketsPerDo: PER_DO,
  connectionDOs: SHARDS,
  connectMs: Math.round(connectMs),
  workerdMemoryMb: { idle: Math.round(memoryIdle), connected: Math.round(memoryConnected) },
  memoryPerSocketKb: Math.round(((memoryConnected - memoryIdle) * 1024) / N * 10) / 10,
  inbound: { messages: inbound, allAckedMs: Math.round(inboundMs) },
  scenarios: results.map((r) => ({ ...r, relayP50Ms: Math.round(r.relayP50Ms * 10) / 10, p50Ms: Math.round(r.p50Ms * 10) / 10, maxMs: Math.round(r.maxMs * 10) / 10 })),
}
console.log(JSON.stringify(report, null, 2))
writeFileSync(new URL(`./result-${N}-${PER_DO}.json`, import.meta.url), JSON.stringify(report, null, 2))
for (const ws of sockets) ws.terminate()
await mf.dispose()
