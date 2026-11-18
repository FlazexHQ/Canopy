/**
 * The documents and filters every matcher benchmark measures: `throughput.ts` on decoded documents and
 * `event-cost.ts` on BSON change events, so their numbers describe the same work.
 */
const STATUSES = ["open", "paid", "shipped", "closed"]

/** The benchmark document number `i`: about 220 bytes of BSON with strings, numbers, arrays and subdocuments. */
export function benchDocument(i: number) {
  return {
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
  }
}

/** A document built by {@link benchDocument}. */
export type BenchDocument = ReturnType<typeof benchDocument>

/** A benchmark filter and the hand written predicate that decides the same documents. */
export interface Scenario {
  readonly filter: unknown
  readonly handWritten: (doc: BenchDocument) => boolean
}

/** The matcher benchmark scenarios by name. */
export const SCENARIOS: Readonly<Record<string, Scenario>> = {
  "equality (DLS owner)": { filter: { ownerId: "u42" }, handWritten: (d) => d.ownerId === "u42" },
  "range and $in": {
    filter: { amount: { $gte: 100, $lt: 500 }, status: { $in: ["open", "paid"] } },
    handWritten: (d) =>
      d.amount >= 100 && d.amount < 500 && (d.status === "open" || d.status === "paid"),
  },
  "$or of 3 branches": {
    filter: { $or: [{ status: "open" }, { amount: { $gt: 900 } }, { tags: "k3" }] },
    handWritten: (d) => d.status === "open" || d.amount > 900 || d.tags.includes("k3"),
  },
  "dotted path": {
    filter: { "address.city": "Lisbon", "address.zip": { $regex: "^1" } },
    handWritten: (d) => d.address.city === "Lisbon" && /^1/.test(d.address.zip),
  },
  $elemMatch: {
    filter: { items: { $elemMatch: { sku: "s7", qty: { $gte: 2 } } } },
    handWritten: (d) => d.items.some((item) => item.sku === "s7" && item.qty >= 2),
  },
  "DLS and user filter": {
    filter: { $and: [{ tenantId: "t8" }, { status: "open", amount: { $lt: 250 } }] },
    handWritten: (d) => d.tenantId === "t8" && d.status === "open" && d.amount < 250,
  },
}

/** The runtime running the benchmark, as `bun 1.4.4` or `node v24.22.1`. */
export function runtimeName(): string {
  const bun = (globalThis as { Bun?: { version?: unknown } }).Bun
  return typeof bun?.version === "string" ? `bun ${bun.version}` : `node ${process.version}`
}
