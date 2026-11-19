import { writeFile } from "node:fs/promises"
import * as policy from "@canopy/policy"
import { type ClientSession, type CommandStartedEvent, MongoClient } from "mongodb"
import { createRestHandler, ReadPath, type RestHandlerOptions, WritePath } from "../src/index.ts"
import { closedLoop, emptySamples, profiled, summarize } from "./harness.ts"
import {
  benchPolicies,
  canopyGroups,
  driverGroups,
  handlerOptions,
  makeOrder,
  type Op,
  type Order,
  ownerOf,
  seedTo,
  seedVictims,
  type TierState,
  VICTIM_BASE,
} from "./scenarios.ts"

const URI = process.env["CANOPY_BENCH_MONGODB_URI"] ?? "mongodb://localhost:27017/?replicaSet=rs0"
const DOCS = Number(process.env["PROBE_DOCS"] ?? "100000")
const SECONDS = Number(process.env["PROBE_SECONDS"] ?? "3")
const ROUNDS = Number(process.env["PROBE_ROUNDS"] ?? "2")
const CONCURRENCY = Number(process.env["PROBE_CONCURRENCY"] ?? "32")
const PROFILE = process.env["PROBE_PROFILE"]
const ONLY = process.env["PROBE_ONLY"]?.split("|")
const OUT = process.env["PROBE_OUT"] ?? "probe.json"
const OWNERS = 1000
const rand = (n: number): number => Math.floor(Math.random() * n)

const monitor = new MongoClient(URI, { maxPoolSize: 200, monitorCommands: true })
const client = new MongoClient(URI, { maxPoolSize: 200 })
let counting = false
let commands: string[] = []
monitor.on("commandStarted", (event: CommandStartedEvent) => {
  if (!counting) return
  const name =
    event.commandName === "bulkWrite"
      ? "bulkWrite"
      : event.commandName === "aggregate" && Array.isArray(event.command["pipeline"])
        ? `aggregate(${Object.keys((event.command["pipeline"] as object[])[0] ?? {}).join("")})`
        : event.commandName
  const extras: string[] = []
  if (event.command["startTransaction"] === true) extras.push("+startTxn")
  const rc = event.command["readConcern"] as { level?: string } | undefined
  if (rc?.level !== undefined) extras.push(`rc=${rc.level}`)
  const wc = event.command["writeConcern"] as { w?: unknown } | undefined
  if (wc?.w !== undefined) extras.push(`w=${String(wc.w)}`)
  commands.push(extras.length === 0 ? name : `${name}[${extras.join(",")}]`)
})

interface Built {
  readonly name: string
  readonly op: Op
  readonly group: string
}

function build(
  c: MongoClient,
  dbName: string,
  metaName: string,
  state: TierState,
): { scenarios: Built[]; writes: WritePath } {
  const engine = benchPolicies(policy)
  const db = c.db(dbName)
  const coll = db.collection<Order>("orders")
  const reads = new ReadPath({ client: c, database: dbName, policies: engine })
  const writes = new WritePath({
    client: c,
    database: dbName,
    metaDatabase: metaName,
    policies: engine,
  })
  const http = createRestHandler(
    handlerOptions(c, dbName, metaName, engine) as unknown as RestHandlerOptions,
  )
  const s: TierState = { ...state, coll, db }
  const out: Built[] = []
  const drivers = driverGroups(s)
  const canopy = canopyGroups(s, { reads, writes, http })
  for (const group of ["findById", "owner page", "update", "replace", "insert", "delete", "http"]) {
    for (const [name, op] of drivers.get(group) ?? []) out.push({ name, op, group })
    for (const [name, op] of canopy.get(group) ?? []) out.push({ name, op, group })
  }
  const withSession = async <T>(
    options: Parameters<MongoClient["startSession"]>[0],
    run: (session: ClientSession) => Promise<T>,
  ): Promise<T> => {
    const session = c.startSession(options)
    try {
      return await run(session)
    } finally {
      await session.endSession()
    }
  }
  const extra: Built[] = [
    {
      group: "findById",
      name: "driver+: findById in a snapshot session",
      op: () => {
        const id = rand(s.size)
        return withSession({ snapshot: true }, (session) =>
          coll.findOne({ _id: id, ownerId: `u${id % OWNERS}` }, { session }),
        )
      },
    },
    {
      group: "findById",
      name: "driver+: findById, promoteValues false",
      op: () => {
        const id = rand(s.size)
        return coll.findOne(
          { _id: id, ownerId: `u${id % OWNERS}` },
          { promoteValues: false, bsonRegExp: true },
        )
      },
    },
    {
      group: "owner page",
      name: "driver+: owner page in a snapshot session",
      op: () =>
        withSession({ snapshot: true }, (session) =>
          coll
            .find({ ownerId: `u${rand(OWNERS)}` }, { session })
            .sort({ createdAt: -1, _id: 1 })
            .limit(51)
            .toArray(),
        ),
    },
    {
      group: "owner page",
      name: "driver+: owner page, promoteValues false",
      op: () =>
        coll
          .find({ ownerId: `u${rand(OWNERS)}` }, { promoteValues: false, bsonRegExp: true })
          .sort({ createdAt: -1, _id: 1 })
          .limit(51)
          .toArray(),
    },
    {
      group: "update",
      name: "driver+: updateOne in an explicit causal session",
      op: () => {
        const id = rand(s.size)
        return withSession({ causalConsistency: true }, (session) =>
          coll.updateOne(
            { _id: id, ownerId: `u${id % OWNERS}` },
            { $inc: { n: 1 } },
            { session, writeConcern: { w: "majority" } },
          ),
        )
      },
    },
    {
      group: "update",
      name: "driver+: findOneAndUpdate returning the document",
      op: () => {
        const id = rand(s.size)
        return coll.findOneAndUpdate(
          { _id: id, ownerId: `u${id % OWNERS}` },
          { $inc: { n: 1 } },
          { returnDocument: "after", writeConcern: { w: "majority" } },
        )
      },
    },
    {
      group: "update",
      name: "driver+: updateOne then findOne (what canopy sends)",
      op: async () => {
        const id = rand(s.size)
        await coll.updateOne(
          { _id: id, ownerId: `u${id % OWNERS}` },
          { $inc: { n: 1 } },
          { writeConcern: { w: "majority" } },
        )
        return coll.findOne({ _id: id, ownerId: `u${id % OWNERS}` })
      },
    },
    {
      group: "update",
      name: "driver+: transaction, updateOne + find + commit",
      op: () => {
        const id = rand(s.size)
        return withSession({}, (session) =>
          session.withTransaction(
            async () => {
              await coll.updateOne(
                { _id: id, tenantId: `t${(id % OWNERS) % 100}` },
                { $set: { status: "paid" } },
                { session },
              )
              return coll.findOne(
                { _id: id, status: { $in: ["open", "paid", "shipped", "closed"] } },
                { session },
              )
            },
            { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } },
          ),
        )
      },
    },
    {
      group: "update",
      name: "canopy+: update, fast path, return=minimal",
      op: () => {
        const id = rand(s.size)
        return writes.execute(
          ownerOf(id % OWNERS),
          { op: "update", collection: "orders", id, update: { $inc: { n: 1 } } },
          { returnDocuments: false },
        )
      },
    },
    {
      group: "update",
      name: "canopy+: update with mutation ID, return=minimal (realtime SDK path)",
      op: (i) => {
        const id = rand(s.size)
        return writes.execute(
          ownerOf(id % OWNERS),
          { op: "update", collection: "orders", id, update: { $inc: { n: 1 } } },
          {
            mutationId: `p_${process.pid}_${Date.now().toString(36)}_${i}_${rand(1e9)}`,
            returnDocuments: false,
          },
        )
      },
    },
    {
      group: "insert",
      name: "canopy+: insert, return=minimal",
      op: () => {
        s.nextInsert += 1
        const doc = makeOrder(s.nextInsert)
        return writes.execute(
          ownerOf(1),
          { op: "insert", collection: "orders", doc: { ...doc, ownerId: "u1", tenantId: "t1" } },
          { returnDocuments: false },
        )
      },
    },
  ]
  for (const e of extra) {
    const at = out.findLastIndex((b) => b.group === e.group)
    out.splice(at + 1, 0, e)
  }
  return {
    scenarios: out.filter((b) => ONLY === undefined || ONLY.some((p) => b.name.includes(p))),
    writes,
  }
}

async function main(): Promise<void> {
  await client.connect()
  await monitor.connect()
  const dbName = `canopy_probe_${process.pid}`
  const metaName = `${dbName}_meta`
  const db = client.db(dbName)
  const coll = db.collection<Order>("orders")
  await coll.createIndexes([
    { key: { ownerId: 1, createdAt: -1, _id: 1 } },
    { key: { tenantId: 1, status: 1, createdAt: -1, _id: 1 } },
  ])
  process.stderr.write(`seeding ${DOCS}\n`)
  await seedTo(coll, 0, DOCS)
  const state: TierState = { coll, db, size: DOCS, nextInsert: 1_000_000_000, victims: [] }
  state.victims = await seedVictims(coll, Number(process.env["PROBE_VICTIMS"] ?? "150000"))
  const main = build(client, dbName, metaName, state)
  const mon = build(monitor, dbName, metaName, { ...state, nextInsert: 1_500_000_000 })
  await main.writes.ensureIndexes()
  const results: Record<string, unknown>[] = []
  try {
    for (const [index, scenario] of main.scenarios.entries()) {
      const monitored = mon.scenarios[index]
      if (monitored === undefined) continue
      commands = []
      counting = true
      const n = 40
      for (let i = 0; i < n; i += 1) await monitored.op(i)
      counting = false
      const perOp = new Map<string, number>()
      for (const c of commands) perOp.set(c, (perOp.get(c) ?? 0) + 1 / n)
      const sequential = await closedLoop(Math.min(2, SECONDS), 1, scenario.op)
      await closedLoop(1, CONCURRENCY, scenario.op)
      const loaded = emptySamples()
      for (let r = 0; r < ROUNDS; r += 1)
        await closedLoop(SECONDS / ROUNDS, CONCURRENCY, scenario.op, loaded)
      const seq = summarize(sequential)
      const load = summarize(loaded)
      const row = {
        group: scenario.group,
        name: scenario.name,
        commands: Object.fromEntries([...perOp].map(([k, v]) => [k, Math.round(v * 100) / 100])),
        commandsPerOp: Math.round((commands.length / n) * 100) / 100,
        sequentialP50: seq.p50,
        sequentialCpuPerOp: seq.cpuPerOp,
        loadedPerSecond: load.perSecond,
        loadedP50: load.p50,
        loadedCpuPerOp: load.cpuPerOp,
        cpuShare: (load.cpuPerOp * load.perSecond) / 1000,
      }
      results.push(row)
      process.stderr.write(
        `${scenario.name.padEnd(70)} cmds ${String(row.commandsPerOp).padStart(4)}  seq p50 ${seq.p50.toFixed(2).padStart(6)} ms  cpu ${seq.cpuPerOp.toFixed(3)}  |  loaded ${String(load.perSecond).padStart(6)}/s  cpu ${load.cpuPerOp.toFixed(3)} ms  ${JSON.stringify(row.commands)}\n`,
      )
      if (PROFILE !== undefined)
        await profiled(PROFILE, scenario.name, () => closedLoop(SECONDS, CONCURRENCY, scenario.op))
    }
  } finally {
    await writeFile(OUT, JSON.stringify(results, null, 2))
    await coll.deleteMany({ _id: { $gte: VICTIM_BASE } })
    await db.dropDatabase()
    await client.db(metaName).dropDatabase()
    await client.close()
    await monitor.close()
  }
}

await main()
