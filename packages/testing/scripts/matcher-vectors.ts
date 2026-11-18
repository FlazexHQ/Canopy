import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import fc from "fast-check"
import { BSON, type Document, MongoClient } from "mongodb"
import { arbitraries } from "../src/index.ts"

/**
 * Records filter vectors from MongoDB itself for the Rust matcher (`crates/canopy-matcher/tests`), so
 * `cargo test` checks the Rust matcher against MongoDB without a database. It inserts generated documents,
 * runs each generated filter with `find`, and writes the documents and filters as raw BSON (exactly the
 * bytes MongoDB stored and received, field order included) with MongoDB's answer: a bit per document that
 * matched, or the error MongoDB refused the filter with.
 *
 *   bun packages/testing/scripts/matcher-vectors.ts [--runs 2000] [--seed 20261106] [--out <file>]
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
    out: {
      type: "string",
      default: resolve(root, "crates/canopy-matcher/tests/vectors/filters.json"),
    },
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

function bitmask(ids: readonly number[]): string {
  const bits = new Uint8Array(Math.ceil(DOCS / 8))
  for (const id of ids) bits[id >> 3] = (bits[id >> 3] ?? 0) | (1 << (id & 7))
  return Buffer.from(bits).toString("hex")
}

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
      cases.push({ filter: bytes, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const out = {
    source: `MongoDB ${version}, seed ${seed}, ${DOCS} documents, ${runs} filters`,
    documents,
    cases,
  }
  await mkdir(dirname(values.out), { recursive: true })
  await writeFile(values.out, `${JSON.stringify(out, null, 1)}\n`)
  const refused = cases.filter((entry) => "error" in entry).length
  process.stdout.write(`${out.source}: ${cases.length - refused} answered, ${refused} refused\n`)
} finally {
  await db.dropDatabase().catch(() => undefined)
  await client.close()
}
