import { writeFile } from "node:fs/promises"
import { compileFilter, compileSort, compileSortKeys } from "../src/index.ts"

/**
 * In process matcher throughput: compiles representative filters once and evaluates them against an
 * in memory array of documents, the work realtime does for every change event and candidate observer.
 *
 * Environment: `CANOPY_BENCH_DOCS` (default 1000000) and `CANOPY_BENCH_OUT`.
 */
const DOCS = Number(process.env["CANOPY_BENCH_DOCS"] ?? "1000000")
const OUT = process.env["CANOPY_BENCH_OUT"]
const STATUSES = ["open", "paid", "shipped", "closed"]

const docs = Array.from({ length: DOCS }, (_, i) => ({
  _id: i,
  ownerId: `u${i % 1000}`,
  tenantId: `t${i % 100}`,
  status: STATUSES[i % 4],
  amount: ((i * 2654435761) % 100_000) / 100,
  tags: [`k${i % 13}`, `k${i % 17}`],
  address: { city: i % 2 === 0 ? "Lisbon" : "Osaka", zip: String(10000 + (i % 89999)) },
  items: [
    { sku: `s${i % 50}`, qty: i % 5 },
    { sku: `s${(i + 7) % 50}`, qty: (i + 3) % 5 },
  ],
}))

const filters: Record<string, unknown> = {
  "equality (DLS owner)": { ownerId: "u42" },
  "range and $in": { amount: { $gte: 100, $lt: 500 }, status: { $in: ["open", "paid"] } },
  "$or of 3 branches": { $or: [{ status: "open" }, { amount: { $gt: 900 } }, { tags: "k3" }] },
  "dotted path": { "address.city": "Lisbon", "address.zip": { $regex: "^1" } },
  $elemMatch: { items: { $elemMatch: { sku: "s7", qty: { $gte: 2 } } } },
  "DLS and user filter": { $and: [{ tenantId: "t7" }, { status: "open", amount: { $lt: 250 } }] },
}

const results: { name: string; evalsPerSecond: number; nsPerEval: number; matched: number }[] = []
for (const [name, filter] of Object.entries(filters)) {
  const compiled = compileFilter(filter)
  for (let i = 0; i < Math.min(DOCS, 100_000); i += 1) compiled.matches(docs[i])
  let best = Number.POSITIVE_INFINITY
  let matched = 0
  for (let round = 0; round < 3; round += 1) {
    matched = 0
    const start = performance.now()
    for (const doc of docs) if (compiled.matches(doc)) matched += 1
    best = Math.min(best, performance.now() - start)
  }
  const evalsPerSecond = Math.round(DOCS / (best / 1000))
  results.push({ name, evalsPerSecond, nsPerEval: (best * 1e6) / DOCS, matched })
  process.stderr.write(
    `${name.padEnd(28)} ${(evalsPerSecond / 1e6).toFixed(2)} M evals/s, ${matched} matched\n`,
  )
}

const compileStart = performance.now()
const compileRounds = 100_000
for (let i = 0; i < compileRounds; i += 1)
  compileFilter({ ownerId: `u${i}`, amount: { $gte: i % 100 } })
const compileMicros = ((performance.now() - compileStart) * 1000) / compileRounds

const sortDocs = docs.slice(0, Math.min(DOCS, 200_000))
const comparator = compileSort({ amount: -1 })
const comparatorStart = performance.now()
;[...sortDocs].sort(comparator)
const comparatorMs = performance.now() - comparatorStart
const keyed = compileSortKeys({ amount: -1 })
const sortStart = performance.now()
keyed.sort([...sortDocs])
const sortMs = performance.now() - sortStart

const runtime =
  typeof (globalThis as { Bun?: unknown }).Bun === "object"
    ? `bun ${(globalThis as unknown as { Bun: { version: string } }).Bun.version}`
    : `node ${process.version}`
const text = `${JSON.stringify({ runtime, docs: DOCS, results, compileMicros, sort: { docs: sortDocs.length, ms: sortMs, comparatorMs } }, null, 2)}\n`
process.stderr.write(
  `compile ${compileMicros.toFixed(2)} us per filter, sort ${sortDocs.length}: ${sortMs.toFixed(0)} ms with keys, ${comparatorMs.toFixed(0)} ms with a comparator\n`,
)
if (OUT === undefined) process.stdout.write(text)
else await writeFile(OUT, text)
