import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import type * as Policy from "@canopy/policy"
import type { MongoClient } from "mongodb"
import type * as Rest from "../src/index.ts"
import {
  closedLoop,
  emptySamples,
  interval,
  type Latency,
  log,
  reportLine,
  type Samples,
  serverOps,
  summarize,
} from "./harness.ts"
import {
  benchPolicies,
  canopyGroups,
  driverGroups,
  handlerOptions,
  type Order,
  type Scenario,
  seedTo,
  seedVictims,
  type TierState,
  VICTIM_BASE,
} from "./scenarios.ts"

/**
 * Before and after comparison of two checkouts of the repository, for example the merge base of a branch
 * and its tip. Both run the scenarios of `scale.ts` against the same database in the same alternating
 * rounds, next to the plain driver, so drift of the host or the server lands on both alike. For each
 * scenario it prints the throughput of base and head and the paired ratio head ÷ base with a 95% interval
 * over the rounds.
 *
 * Create the base checkout with a worktree and install it once:
 *
 *   git worktree add ../canopy-base <ref>
 *   cd ../canopy-base && bun install --frozen-lockfile
 *
 * Then, from this package:
 *
 *   node --conditions=@canopy/source bench/compare.ts --base ../../../canopy-base [--head <dir>]
 *
 * `--head` defaults to this checkout. Each checkout is loaded with its own `mongodb` driver, so error
 * classes match the code that checks them. The environment variables of `scale.ts` apply; the tiers default
 * to `100000` and the rounds to 5.
 */
const URI =
  process.env["CANOPY_BENCH_MONGODB_URI"] ??
  process.env["CANOPY_TEST_MONGODB_URI"] ??
  "mongodb://localhost:27017/?replicaSet=rs0"
const TIERS = (process.env["CANOPY_BENCH_TIERS"] ?? "100000")
  .split(",")
  .map((value) => Number(value.trim()))
const SECONDS = Number(process.env["CANOPY_BENCH_SECONDS"] ?? "10")
const CONCURRENCY = Number(process.env["CANOPY_BENCH_CONCURRENCY"] ?? "32")
const ROUNDS = Math.max(2, Number(process.env["CANOPY_BENCH_ROUNDS"] ?? "5"))
const ONLY = process.env["CANOPY_BENCH_ONLY"]
const OUT = process.env["CANOPY_BENCH_OUT"]

interface Checkout {
  readonly label: "base" | "head"
  readonly client: MongoClient
  readonly target: { reads: Rest.ReadPath; writes: Rest.WritePath; http: Rest.RestHandler }
}

async function load(
  label: "base" | "head",
  dir: string,
  dbName: string,
  metaName: string,
): Promise<Checkout> {
  const fromRest = createRequire(join(dir, "packages", "rest", "package.json"))
  const driver = (await import(pathToFileURL(fromRest.resolve("mongodb")).href)) as {
    MongoClient: typeof MongoClient
  }
  const rest = (await import(
    pathToFileURL(join(dir, "packages", "rest", "src", "index.ts")).href
  )) as typeof Rest
  const policy = (await import(
    pathToFileURL(join(dir, "packages", "policy", "src", "index.ts")).href
  )) as typeof Policy
  const client = new driver.MongoClient(URI, { maxPoolSize: 200 })
  await client.connect()
  const engine = benchPolicies(policy)
  const reads = new rest.ReadPath({ client, database: dbName, policies: engine })
  const writes = new rest.WritePath({
    client,
    database: dbName,
    metaDatabase: metaName,
    policies: engine,
  })
  await writes.ensureIndexes()
  const http = rest.createRestHandler(
    handlerOptions(client, dbName, metaName, engine) as unknown as Rest.RestHandlerOptions,
  )
  return { label, client, target: { reads, writes, http } }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { base: { type: "string" }, head: { type: "string" } },
  })
  if (values.base === undefined) throw new Error("--base <checkout> is required")
  const here = fileURLToPath(new URL("../../..", import.meta.url))
  const dbName = `canopy_compare_${process.pid}`
  const metaName = `${dbName}_meta`
  const base = await load("base", resolve(values.base), dbName, metaName)
  const head = await load("head", resolve(values.head ?? here), dbName, metaName)
  const db = head.client.db(dbName)
  const coll = db.collection<Order>("orders")
  await coll.createIndexes([
    { key: { ownerId: 1, createdAt: -1, _id: 1 } },
    { key: { tenantId: 1, status: 1, createdAt: -1, _id: 1 } },
  ])
  const report: Record<string, unknown>[] = []
  let size = 0
  const state: TierState = { coll, db, size: 0, nextInsert: 1_000_000_000, victims: [] }
  try {
    for (const tier of TIERS) {
      log(`tier ${tier}: seeding from ${size}`)
      await seedTo(coll, size, tier)
      size = tier
      const tierState: TierState = { ...state, size: tier, victims: [] }
      const drivers = driverGroups(tierState)
      const sides = [base, head].map((side) => ({
        side,
        groups: canopyGroups(tierState, side.target),
      }))
      for (const [groupName, driverMembers] of drivers) {
        const members: Scenario[] = [...driverMembers]
        for (const { side, groups } of sides)
          for (const [name, op] of groups.get(groupName) ?? [])
            members.push([`${side.label} ${name}`, op])
        const selected = members.filter(([name]) => ONLY === undefined || name.includes(ONLY))
        if (!selected.some(([name]) => !name.startsWith("driver:"))) continue
        if (groupName === "delete")
          tierState.victims = await seedVictims(
            coll,
            Math.ceil(selected.length * (SECONDS + 1) * 6000),
          )
        for (const [, op] of selected) await closedLoop(1, CONCURRENCY, op)
        const samples: Samples[] = selected.map(() => emptySamples())
        for (let round = 0; round < ROUNDS; round += 1)
          for (const [index, [, op]] of selected.entries()) {
            const into = samples[index] ?? emptySamples()
            const before = await serverOps(db)
            await closedLoop(SECONDS / ROUNDS, CONCURRENCY, op, into)
            into.serverOps += (await serverOps(db)) - before - 1
          }
        const results = new Map<string, Latency>()
        for (const [index, [name]] of selected.entries()) {
          const result = summarize(samples[index] ?? emptySamples())
          results.set(name, result)
          log(reportLine(name, result))
        }
        for (const [name, headResult] of results) {
          if (!name.startsWith("head ")) continue
          const scenario = name.slice("head ".length)
          const baseResult = results.get(`base ${scenario}`)
          if (baseResult === undefined) continue
          const ratios = headResult.rounds.map(
            (value, i) => value / (baseResult.rounds[i] ?? Number.NaN),
          )
          const logs = interval(ratios.map((value) => Math.log(value)))
          const ratio = {
            mean: Math.exp(logs.mean),
            low: Math.exp(logs.low),
            high: Math.exp(logs.high),
          }
          log(
            `  => ${scenario}: head ÷ base ${ratio.mean.toFixed(3)} (95% ${ratio.low.toFixed(3)} to ${ratio.high.toFixed(3)}), cpu ${baseResult.cpuPerOp.toFixed(3)} -> ${headResult.cpuPerOp.toFixed(3)} ms, srv ${baseResult.serverOpsPerOp.toFixed(2)} -> ${headResult.serverOpsPerOp.toFixed(2)}`,
          )
          report.push({ tier, scenario, base: baseResult, head: headResult, ratio })
        }
        if (groupName === "delete") await coll.deleteMany({ _id: { $gte: VICTIM_BASE } })
      }
      state.nextInsert = tierState.nextInsert
    }
  } finally {
    await db.dropDatabase()
    await head.client.db(metaName).dropDatabase()
    await base.client.close()
    await head.client.close()
  }
  const text = `${JSON.stringify({ concurrency: CONCURRENCY, rounds: ROUNDS, report }, null, 2)}\n`
  if (OUT !== undefined) {
    const { writeFile } = await import("node:fs/promises")
    await writeFile(OUT, text)
  } else process.stdout.write(text)
}

await main()
