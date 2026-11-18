import { writeFileSync } from "node:fs"
import { deserialize, serialize } from "bson"
import { compileFilter } from "../../../../packages/matcher/src/index.ts"
import { engine, Filter, FilterSet, noop, noopBytes } from "../index.js"

/**
 * The cost of the Node-API (or WebAssembly) boundary against the TypeScript matcher, on the documents and
 * filters of `packages/matcher/bench/event-cost.ts`. Every mode must count the same matches as the TypeScript
 * matcher, or the run fails. `CANOPY_NATIVE_ENGINE=wasm` measures the WebAssembly fallback.
 *
 * Environment: `CANOPY_BENCH_DOCS` (default 200000), `CANOPY_BENCH_OUT` (a JSON file for the results).
 */
const DOCS = Number(process.env["CANOPY_BENCH_DOCS"] ?? "200000")
const OUT = process.env["CANOPY_BENCH_OUT"]
const BATCH = 1000
const STATUSES = ["open", "paid", "shipped", "closed"]

const events = Array.from(
  { length: DOCS },
  (_, i) =>
    new Uint8Array(
      serialize({
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
      }),
    ),
)
const options = { promoteValues: false, bsonRegExp: true }
const decoded = events.map((bytes) => deserialize(bytes, options))

const filters: Record<string, string> = {
  "equality (DLS owner)": '{"ownerId":"u42"}',
  "range and $in": '{"amount":{"$gte":100,"$lt":500},"status":{"$in":["open","paid"]}}',
  "$or of 3 branches": '{"$or":[{"status":"open"},{"amount":{"$gt":900}},{"tags":"k3"}]}',
  "dotted path": '{"address.city":"Lisbon","address.zip":{"$regex":"^1"}}',
  $elemMatch: '{"items":{"$elemMatch":{"sku":"s7","qty":{"$gte":2}}}}',
  "DLS and user filter": '{"$and":[{"tenantId":"t8"},{"status":"open","amount":{"$lt":250}}]}',
}

function batches(size: number): { readonly arrays: Uint8Array[][]; readonly joined: Uint8Array[] } {
  const arrays: Uint8Array[][] = []
  const joined: Uint8Array[] = []
  for (let start = 0; start < events.length; start += size) {
    const slice = events.slice(start, start + size)
    arrays.push(slice)
    const buffer = new Uint8Array(slice.reduce((total, bytes) => total + bytes.length, 0))
    let offset = 0
    for (const bytes of slice) {
      buffer.set(bytes, offset)
      offset += bytes.length
    }
    joined.push(buffer)
  }
  return { arrays, joined }
}

function nsPerEvent(run: () => number, expected: number | undefined, label: string): number {
  run()
  let best = Number.POSITIVE_INFINITY
  for (let round = 0; round < 3; round += 1) {
    const start = performance.now()
    const matched = run()
    best = Math.min(best, performance.now() - start)
    if (expected !== undefined && matched !== expected) {
      throw new Error(`${label}: ${matched} matched, the TypeScript matcher matched ${expected}`)
    }
  }
  return (best * 1e6) / DOCS
}

const count = (results: Uint8Array): number => {
  let matched = 0
  for (const result of results) {
    if (result === 2) throw new Error("undecided result")
    matched += result
  }
  return matched
}

const runtime = (globalThis as { Deno?: { version: { deno: string } } }).Deno
  ? `Deno ${(globalThis as unknown as { Deno: { version: { deno: string } } }).Deno.version.deno}`
  : process.versions["bun"]
    ? `Bun ${process.versions["bun"]}`
    : `Node ${process.versions.node}`
const report: Record<string, unknown> = { runtime, engine: engine(), documents: DOCS, batch: BATCH }
const line = (text: string) => process.stdout.write(`${text}\n`)
line(`${runtime}, engine ${engine()}, ${DOCS} events of ${events[0]?.length ?? 0} bytes`)

const sample = events[0] ?? new Uint8Array()
const calls = 2_000_000
const boundary = {
  noop: nsPerEvent(
    () => {
      for (let i = 0; i < calls; i += 1) noop()
      return 0
    },
    undefined,
    "noop",
  ) * (DOCS / calls),
  noopBytes: nsPerEvent(
    () => {
      for (let i = 0; i < calls; i += 1) noopBytes(sample)
      return 0
    },
    undefined,
    "noopBytes",
  ) * (DOCS / calls),
}
report["boundary"] = boundary
line(`empty call ${boundary.noop.toFixed(1)} ns, call with a buffer ${boundary.noopBytes.toFixed(1)} ns`)

const { arrays, joined } = batches(BATCH)
const perFilter: Record<string, Record<string, number>> = {}
const expectedCounts: Record<string, number> = {}
line(
  `${"filter".padEnd(22)} ${"ts decode+match".padStart(16)} ${"ts match".padStart(9)} ${"single".padStart(8)} ${"many".padStart(7)} ${"joined".padStart(7)}  (ns per event)`,
)
for (const [name, text] of Object.entries(filters)) {
  const ts = compileFilter(JSON.parse(text))
  const native = Filter.fromEjson(text)
  let expected = 0
  for (const document of decoded) if (ts.matches(document)) expected += 1
  expectedCounts[name] = expected
  const row = {
    tsDecodeAndMatch: nsPerEvent(
      () => {
        let matched = 0
        for (const bytes of events) if (ts.matches(deserialize(bytes, options))) matched += 1
        return matched
      },
      expected,
      `${name} ts`,
    ),
    tsMatchOnly: nsPerEvent(
      () => {
        let matched = 0
        for (const document of decoded) if (ts.matches(document)) matched += 1
        return matched
      },
      expected,
      `${name} ts objects`,
    ),
    single: nsPerEvent(
      () => {
        let matched = 0
        for (const bytes of events) if (native.matches(bytes)) matched += 1
        return matched
      },
      expected,
      `${name} single`,
    ),
    many: nsPerEvent(
      () => arrays.reduce((total, batch) => total + count(native.matchMany(batch)), 0),
      expected,
      `${name} many`,
    ),
    joined: nsPerEvent(
      () => joined.reduce((total, batch) => total + count(native.matchConcatenated(batch)), 0),
      expected,
      `${name} joined`,
    ),
  }
  perFilter[name] = row
  line(
    `${name.padEnd(22)} ${row.tsDecodeAndMatch.toFixed(0).padStart(16)} ${row.tsMatchOnly.toFixed(0).padStart(9)} ${row.single.toFixed(0).padStart(8)} ${row.many.toFixed(0).padStart(7)} ${row.joined.toFixed(0).padStart(7)}`,
  )
}
report["filters"] = perFilter

const sweep: Record<string, Record<string, number>> = {}
const equality = Filter.fromEjson(filters["equality (DLS owner)"] ?? "{}")
const equalityCount = expectedCounts["equality (DLS owner)"]
for (const size of [1, 10, 100, 1000, 10000]) {
  const shaped = batches(size)
  sweep[size] = {
    many: nsPerEvent(
      () => shaped.arrays.reduce((total, batch) => total + count(equality.matchMany(batch)), 0),
      equalityCount,
      `sweep many ${size}`,
    ),
    joined: nsPerEvent(
      () => shaped.joined.reduce((total, batch) => total + count(equality.matchConcatenated(batch)), 0),
      equalityCount,
      `sweep joined ${size}`,
    ),
  }
}
report["batchSweep"] = sweep
line(
  `batch size sweep (equality): ${Object.entries(sweep)
    .map(([size, row]) => `${size}: many ${row["many"]?.toFixed(0)}, joined ${row["joined"]?.toFixed(0)}`)
    .join("; ")} ns per event`,
)

const texts = Object.values(filters)
const set = FilterSet.fromEjson(texts)
const tsSet = texts.map((text) => compileFilter(JSON.parse(text)))
const singles = texts.map((text) => Filter.fromEjson(text))
let setExpected = 0
for (const document of decoded) for (const filter of tsSet) if (filter.matches(document)) setExpected += 1
const subscriptions = {
  tsDecodeOnceMatchAll: nsPerEvent(
    () => {
      let matched = 0
      for (const bytes of events) {
        const document = deserialize(bytes, options)
        for (const filter of tsSet) if (filter.matches(document)) matched += 1
      }
      return matched
    },
    setExpected,
    "ts set",
  ),
  nativeOneCallPerFilter: nsPerEvent(
    () => {
      let matched = 0
      for (const bytes of events) for (const filter of singles) if (filter.matches(bytes)) matched += 1
      return matched
    },
    setExpected,
    "single per filter",
  ),
  nativeFilterSet: nsPerEvent(
    () => events.reduce((total, bytes) => total + count(set.matchDocument(bytes)), 0),
    setExpected,
    "filter set",
  ),
}
report["sixSubscriptionsPerEvent"] = subscriptions
line(
  `one event against all 6 filters: ts decode once ${subscriptions.tsDecodeOnceMatchAll.toFixed(0)} ns, native 6 calls ${subscriptions.nativeOneCallPerFilter.toFixed(0)} ns, native FilterSet 1 call ${subscriptions.nativeFilterSet.toFixed(0)} ns per event`,
)

if (OUT !== undefined) writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`)
