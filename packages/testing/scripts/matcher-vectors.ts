import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import fc from "fast-check"
import { BSON, type Document, Long, MongoClient } from "mongodb"
import { arbitraries } from "../src/index.ts"

/**
 * Records matcher vectors from MongoDB itself for the Rust matcher (`crates/canopy-matcher/tests`), so
 * `cargo test` checks the Rust matcher against MongoDB without a database. It inserts generated documents
 * and writes them as raw BSON (exactly the bytes MongoDB stored, field order included) with three files of
 * cases, each with MongoDB's answer or the error MongoDB refused the case with. `filters.json` runs each
 * generated filter with `find` and keeps a bit per matching document. `sorts.json` runs each generated sort
 * with `find().sort()` and the `_id` tie breaker and keeps the order of the documents. `projections.json`
 * runs each generated projection with `find()` and keeps the projected documents as raw BSON.
 * `updates.json` applies each generated update (with array filters when it names `$[x]`) to one of the
 * documents with `updateOne` and keeps the updated document as raw BSON.
 *
 *   bun packages/testing/scripts/matcher-vectors.ts [--runs 2000] [--seed 20261106] [--dir <folder>]
 *
 * It needs a MongoDB server in `CANOPY_TEST_MONGODB_URI` (a standalone server is enough) and uses a
 * scratch database it drops afterwards.
 */
const DOCS = 300
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "2000" },
    seed: { type: "string", default: "20261106" },
    dir: { type: "string", default: resolve(root, "conformance/matcher") },
  },
})
const runs = Number(values.runs)
const seed = Number(values.seed)
const uri = process.env["CANOPY_TEST_MONGODB_URI"]
if (uri === undefined) {
  process.stderr.write("CANOPY_TEST_MONGODB_URI must name a MongoDB server\n")
  process.exit(1)
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64")
}

function reason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.split(" :: caused by :: ").at(-1) ?? message
}

function bitmask(ids: readonly number[]): string {
  const bits = new Uint8Array(Math.ceil(DOCS / 8))
  for (const id of ids) bits[id >> 3] = (bits[id >> 3] ?? 0) | (1 << (id & 7))
  return Buffer.from(bits).toString("hex")
}

const SORT_PATHS = ["a", "b", "c", "a.b", "a.c", "b.a", "a.0", "a.b.c", "a.0.b", "_id"] as const
const sortSpec = fc
  .uniqueArray(fc.tuple(fc.constantFrom(...SORT_PATHS), fc.constantFrom(1, -1)), {
    minLength: 1,
    maxLength: 3,
    selector: ([key]) => key,
  })
  .map((entries) => Object.fromEntries(entries) as Record<string, 1 | -1>)

const PROJECTION_PATHS = ["a", "b", "c", "a.b", "a.c", "b.a", "a.b.c", "a.0", "_id.x"] as const
const projectionSpec = fc
  .uniqueArray(fc.constantFrom(...PROJECTION_PATHS), { minLength: 1, maxLength: 3 })
  .chain((paths) =>
    fc
      .tuple(fc.constantFrom(0, 1, true, false), fc.constantFrom(undefined, 0, 1))
      .map(([flag, id]) => {
        const spec: Record<string, number | boolean> = Object.fromEntries(
          paths.map((p) => [p, flag]),
        )
        if (id !== undefined) spec["_id"] = id
        return spec
      }),
  )

const { value } = arbitraries
const operand = fc.oneof(
  value,
  fc.constantFrom(1, -1, 2, 0.5, 2147483647, Long.fromNumber(3), Long.fromBigInt(2n ** 62n)),
)
const updatePath = fc.constantFrom(
  "a",
  "b",
  "a.b",
  "a.c",
  "a.0",
  "a.1",
  "a.b.c",
  "d",
  "a.$[]",
  "a.$[x]",
)
const one = { minKeys: 1, maxKeys: 1 }
const updateOp = fc.oneof(
  fc.record({ $set: fc.dictionary(updatePath, value, { minKeys: 1, maxKeys: 2 }) }),
  fc.record({ $unset: fc.dictionary(updatePath, fc.constant(""), { minKeys: 1, maxKeys: 2 }) }),
  fc.record({ $inc: fc.dictionary(updatePath, operand, one) }),
  fc.record({ $mul: fc.dictionary(updatePath, operand, one) }),
  fc.record({ $min: fc.dictionary(updatePath, value, one) }),
  fc.record({ $max: fc.dictionary(updatePath, value, one) }),
  fc.record({ $push: fc.dictionary(updatePath, value, one) }),
  fc.record({
    $push: fc.dictionary(
      fc.constantFrom("a", "b", "a.b"),
      fc.record(
        {
          $each: fc.array(value, { maxLength: 3 }),
          $slice: fc.constantFrom(0, 1, 2, -1, -2),
          $position: fc.constantFrom(0, 1, -1),
          $sort: fc.constantFrom(1, -1, { a: 1 }, { b: -1, a: 1 }),
        },
        { requiredKeys: ["$each"] },
      ),
      one,
    ),
  }),
  fc.record({ $addToSet: fc.dictionary(updatePath, value, one) }),
  fc.record({
    $addToSet: fc.dictionary(
      fc.constantFrom("a", "b"),
      fc.record({ $each: fc.array(value, { maxLength: 3 }) }),
      one,
    ),
  }),
  fc.record({ $pop: fc.dictionary(updatePath, fc.constantFrom(1, -1), one) }),
  fc.record({
    $pull: fc.dictionary(
      fc.constantFrom("a", "b", "a.b"),
      fc.oneof(value, fc.record({ $gte: value }), fc.record({ b: value })),
      one,
    ),
  }),
  fc.record({
    $pullAll: fc.dictionary(fc.constantFrom("a", "b"), fc.array(value, { maxLength: 3 }), one),
  }),
  fc.record({
    $bit: fc.dictionary(
      fc.constantFrom("a", "b", "c"),
      fc.dictionary(
        fc.constantFrom("and", "or", "xor"),
        fc.constantFrom(1, 5, -1, Long.fromNumber(6)),
        one,
      ),
      one,
    ),
  }),
  fc.record({ $rename: fc.constantFrom({ a: "z" }, { b: "a.q" }, { "a.b": "y" }, { a: "b" }) }),
)
const updateCase = fc.tuple(fc.array(updateOp, { minLength: 1, maxLength: 2 }), fc.nat(DOCS - 1))

const client = new MongoClient(uri)
const db = client.db(`canopy_vectors_${process.pid}`)
try {
  const version = String((await db.admin().serverInfo())["version"])
  const coll = db.collection<Document>("filters")
  const generated = fc.sample(arbitraries.document, { numRuns: DOCS, seed })
  await coll.insertMany(generated.map((doc, index) => ({ _id: index, ...doc })))
  const stored = await coll.find({}, { raw: true, sort: { _id: 1 } }).toArray()
  const documents = stored.map((bytes) => base64(bytes as unknown as Uint8Array))

  const cases: Record<string, unknown>[] = []
  for (const filter of fc.sample(arbitraries.filter(2), { numRuns: runs, seed })) {
    const bytes = base64(BSON.serialize(filter))
    try {
      const found = await coll.find(filter, { projection: { _id: 1 } }).toArray()
      cases.push({ filter: bytes, matches: bitmask(found.map((doc) => Number(doc["_id"]))) })
    } catch (error: unknown) {
      cases.push({ filter: bytes, error: reason(error) })
    }
  }

  const sorts: Record<string, unknown>[] = []
  for (const spec of fc.sample(sortSpec, { numRuns: Math.max(50, runs / 10), seed })) {
    const bytes = base64(BSON.serialize(spec))
    try {
      const found = await coll
        .find({}, { projection: { _id: 1 } })
        .sort("_id" in spec ? spec : { ...spec, _id: 1 })
        .toArray()
      sorts.push({ sort: bytes, order: found.map((doc) => Number(doc["_id"])) })
    } catch (error: unknown) {
      sorts.push({ sort: bytes, error: reason(error) })
    }
  }

  const projections: Record<string, unknown>[] = []
  for (const spec of fc.sample(projectionSpec, { numRuns: Math.max(50, runs / 10), seed })) {
    const bytes = base64(BSON.serialize(spec))
    try {
      const found = await coll.find({}, { projection: spec, raw: true, sort: { _id: 1 } }).toArray()
      projections.push({
        projection: bytes,
        documents: found.map((doc) => base64(doc as unknown as Uint8Array)),
      })
    } catch (error: unknown) {
      projections.push({
        projection: bytes,
        error: reason(error),
      })
    }
  }

  const target = db.collection<Document>("updates")
  const updates: Record<string, unknown>[] = []
  for (const [ops, index] of fc.sample(updateCase, { numRuns: runs, seed })) {
    const update = Object.assign({}, ...ops) as Document
    const usesFilter = Object.values(update).some((fields) =>
      Object.keys(fields as Document).some((path) => path.includes("$[x]")),
    )
    const arrayFilters = usesFilter ? [{ x: { $gte: 1 } }] : undefined
    const entry: Record<string, unknown> = {
      document: index,
      update: base64(BSON.serialize(update)),
    }
    if (arrayFilters !== undefined)
      entry["arrayFilters"] = base64(BSON.serialize({ list: arrayFilters }))
    await target.deleteMany({})
    await target.insertOne({ _id: index, ...(generated[index] ?? {}) })
    try {
      await target.updateOne(
        { _id: index },
        update,
        arrayFilters === undefined ? {} : { arrayFilters },
      )
      const [after] = await target.find({ _id: index }, { raw: true }).toArray()
      entry["result"] = base64(after as unknown as Uint8Array)
    } catch (error: unknown) {
      entry["error"] = reason(error)
    }
    updates.push(entry)
  }

  await mkdir(values.dir, { recursive: true })
  const write = async (name: string, kind: string, entries: Record<string, unknown>[]) => {
    const source = `MongoDB ${version}, seed ${seed}, ${DOCS} documents, ${entries.length} ${kind}`
    const out = { source, documents, cases: entries }
    await writeFile(resolve(values.dir, name), `${JSON.stringify(out, null, 1)}\n`)
    const refused = entries.filter((entry) => "error" in entry).length
    process.stdout.write(`${source}: ${entries.length - refused} answered, ${refused} refused\n`)
  }
  await write("filters.json", "filters", cases)
  await write("sorts.json", "sorts", sorts)
  await write("projections.json", "projections", projections)
  await write("updates.json", "updates", updates)
} finally {
  await db.dropDatabase().catch(() => undefined)
  await client.close()
}
