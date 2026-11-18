import { deserialize, serialize } from "bson"
import { compileFilter } from "../src/index.ts"

/**
 * The matcher's cost per change event as the realtime engine pays it: the driver hands over each event as
 * BSON, which is deserialized (with exact BSON types, as the engine reads them) and then matched. The
 * documents and filters are those of `throughput.ts`; `crates/canopy-matcher/examples/throughput.rs` runs
 * the same work in Rust, so the two can be compared on one machine.
 *
 * Environment: `CANOPY_BENCH_DOCS` (default 200000).
 */
const DOCS = Number(process.env["CANOPY_BENCH_DOCS"] ?? "200000")
const STATUSES = ["open", "paid", "shipped", "closed"]

const events = Array.from({ length: DOCS }, (_, i) =>
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
)

const filters: Record<string, unknown> = {
  "equality (DLS owner)": { ownerId: "u42" },
  "range and $in": { amount: { $gte: 100, $lt: 500 }, status: { $in: ["open", "paid"] } },
  "$or of 3 branches": { $or: [{ status: "open" }, { amount: { $gt: 900 } }, { tags: "k3" }] },
  "dotted path": { "address.city": "Lisbon", "address.zip": { $regex: "^1" } },
  $elemMatch: { items: { $elemMatch: { sku: "s7", qty: { $gte: 2 } } } },
  "DLS and user filter": { $and: [{ tenantId: "t8" }, { status: "open", amount: { $lt: 250 } }] },
}

const options = { promoteValues: false, bsonRegExp: true }
for (const [name, filter] of Object.entries(filters)) {
  const compiled = compileFilter(filter)
  for (const bytes of events.slice(0, 20_000)) compiled.matches(deserialize(bytes, options))
  let best = Number.POSITIVE_INFINITY
  let matched = 0
  for (let round = 0; round < 3; round += 1) {
    matched = 0
    const start = performance.now()
    for (const bytes of events) if (compiled.matches(deserialize(bytes, options))) matched += 1
    best = Math.min(best, performance.now() - start)
  }
  process.stdout.write(
    `${name.padEnd(28)} ${((best * 1e6) / DOCS).toFixed(0)} ns per event, ${matched} matched\n`,
  )
}
