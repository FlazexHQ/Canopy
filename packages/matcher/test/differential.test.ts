import { stringify } from "@canopy/protocol"
import { arbitraries, DIFF_RUNS, describeWithMongo } from "@canopy/testing"
import fc from "fast-check"
import type { Collection, Document } from "mongodb"
import { beforeAll, expect, it } from "vitest"
import {
  applyUpdate,
  compileFilter,
  compileProjection,
  compileSort,
  compileSortKeys,
  UnsupportedQueryError,
} from "../src/index.ts"

const SEED = Number(process.env["CANOPY_DIFF_SEED"] ?? "20261106")
const DOCS = 300

type Outcome<T> = { ok: true; value: T } | { ok: false; unsupported: boolean; message: string }

async function mongoOutcome<T>(run: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await run() }
  } catch (error: unknown) {
    return {
      ok: false,
      unsupported: false,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

function localOutcome<T>(run: () => T): Outcome<T> {
  try {
    return { ok: true, value: run() }
  } catch (error: unknown) {
    return {
      ok: false,
      unsupported: error instanceof UnsupportedQueryError,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

describeWithMongo("differential: matcher against MongoDB", (db) => {
  let coll: Collection<Document>
  let docs: Document[]

  beforeAll(async () => {
    coll = db().collection("filters")
    const generated = fc.sample(arbitraries.document, { numRuns: DOCS, seed: SEED })
    await coll.insertMany(generated.map((doc, index) => ({ _id: index, ...doc }) as Document))
    docs = await coll
      .find({}, { promoteValues: false, bsonRegExp: true })
      .sort({ _id: 1 })
      .toArray()
  })

  it(`filters agree with find() on ${DOCS} documents per filter (seed ${SEED})`, async () => {
    const filters = fc.sample(arbitraries.filter(2), { numRuns: DIFF_RUNS, seed: SEED })
    const mismatches: string[] = []
    let cases = 0
    let unsupported = 0
    for (const query of filters) {
      const expected = await mongoOutcome(async () =>
        (await coll.find(query, { projection: { _id: 1 } }).toArray()).map((doc) =>
          Number(doc["_id"]),
        ),
      )
      const compiled = localOutcome(() => compileFilter(query))
      if (!compiled.ok && compiled.unsupported) {
        unsupported += 1
        continue
      }
      if (!expected.ok || !compiled.ok) {
        cases += 1
        if (expected.ok !== compiled.ok) {
          mismatches.push(
            `filter ${stringify(query)}: MongoDB ${expected.ok ? "accepted it" : `rejected it (${expected.message})`}, matcher ${compiled.ok ? "accepted it" : `rejected it (${compiled.message})`}`,
          )
        }
        continue
      }
      const want = new Set(expected.value)
      for (const doc of docs) {
        cases += 1
        const got = localOutcome(() => compiled.value.matches(doc))
        const id = Number(doc["_id"])
        if (!got.ok || got.value !== want.has(id)) {
          mismatches.push(
            `filter ${stringify(query)} on ${stringify(doc)}: MongoDB ${want.has(id)}, matcher ${got.ok ? got.value : got.message}`,
          )
        }
      }
      if (mismatches.length > 20) break
    }
    expect(mismatches.slice(0, 20), `${mismatches.length} mismatches in ${cases} cases`).toEqual([])
    expect(unsupported).toBeLessThan(filters.length / 4)
  }, 600_000)

  it("sort order agrees with find().sort()", async () => {
    const specs = fc.sample(
      fc
        .uniqueArray(
          fc.tuple(
            fc.constantFrom("a", "b", "a.b", "c", "a.0", "a.c", "a.0.b", "a.b.c"),
            fc.constantFrom(1, -1),
          ),
          {
            minLength: 1,
            maxLength: 2,
            selector: ([key]) => key,
          },
        )
        .map((entries) => Object.fromEntries(entries) as Record<string, 1 | -1>),
      { numRuns: Math.max(20, Math.floor(DIFF_RUNS / 10)), seed: SEED },
    )
    let compared = 0
    for (const spec of specs) {
      const expected = await mongoOutcome(async () =>
        (
          await coll
            .find({}, { projection: { _id: 1 } })
            .sort({ ...spec, _id: 1 })
            .toArray()
        ).map((doc) => doc["_id"]),
      )
      const compare = compileSort(spec)
      const actual = localOutcome(() => [...docs].sort(compare).map((doc) => Number(doc["_id"])))
      const keyed = localOutcome(() =>
        compileSortKeys(spec)
          .sort([...docs])
          .map((doc) => Number(doc["_id"])),
      )
      expect(actual.ok, `sort ${JSON.stringify(spec)} succeeds in both or fails in both`).toBe(
        expected.ok,
      )
      expect(keyed.ok, `keyed sort ${JSON.stringify(spec)} succeeds in both or fails in both`).toBe(
        expected.ok,
      )
      if (expected.ok && actual.ok && keyed.ok) {
        compared += 1
        expect(actual.value, `sort ${JSON.stringify(spec)}`).toEqual(expected.value)
        expect(keyed.value, `keyed sort ${JSON.stringify(spec)}`).toEqual(expected.value)
      }
    }
    expect(compared).toBeGreaterThan(0)
  }, 120_000)

  it("projections agree with find() projections", async () => {
    const specs = fc.sample(
      fc.oneof(
        fc
          .uniqueArray(fc.constantFrom("a", "b", "a.b", "a.c", "c", "a.b.c"), {
            minLength: 1,
            maxLength: 2,
          })
          .filter(
            (paths) => !paths.some((p) => paths.some((q) => q !== p && q.startsWith(`${p}.`))),
          )
          .chain((paths) =>
            fc.tuple(fc.constantFrom(0, 1), fc.boolean()).map(([flag, hideId]) => {
              const spec: Record<string, number> = Object.fromEntries(paths.map((p) => [p, flag]))
              if (hideId) spec["_id"] = 0
              return spec
            }),
          ),
      ),
      { numRuns: Math.max(20, Math.floor(DIFF_RUNS / 10)), seed: SEED },
    )
    for (const spec of specs) {
      const expected = await coll.find({}, { projection: spec }).sort({ _id: 1 }).toArray()
      const projection = compileProjection(spec)
      const actual = docs.map((doc) => projection.apply(doc))
      expect(
        actual.map((doc) => stringify(doc)),
        `projection ${JSON.stringify(spec)}`,
      ).toEqual(expected.map((doc) => stringify(doc)))
    }
  }, 120_000)

  it("updates agree with findOneAndUpdate()", async () => {
    const target = db().collection("updates")
    const { value } = arbitraries
    const operand = fc.oneof(value, fc.constantFrom(1, -1, 2, 0.5))
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
    const op = fc.oneof(
      fc.record({ $set: fc.dictionary(updatePath, value, { minKeys: 1, maxKeys: 2 }) }),
      fc.record({ $unset: fc.dictionary(updatePath, fc.constant(""), { minKeys: 1, maxKeys: 2 }) }),
      fc.record({ $inc: fc.dictionary(updatePath, operand, { minKeys: 1, maxKeys: 1 }) }),
      fc.record({ $mul: fc.dictionary(updatePath, operand, { minKeys: 1, maxKeys: 1 }) }),
      fc.record({ $min: fc.dictionary(updatePath, value, { minKeys: 1, maxKeys: 1 }) }),
      fc.record({ $max: fc.dictionary(updatePath, value, { minKeys: 1, maxKeys: 1 }) }),
      fc.record({ $push: fc.dictionary(updatePath, value, { minKeys: 1, maxKeys: 1 }) }),
      fc.record({
        $push: fc.dictionary(
          fc.constantFrom("a", "b", "a.b"),
          fc.record(
            {
              $each: fc.array(value, { maxLength: 3 }),
              $slice: fc.constantFrom(0, 1, 2, -1, -2),
              $position: fc.constantFrom(0, 1, -1),
              $sort: fc.constantFrom(1, -1),
            },
            { requiredKeys: ["$each"] },
          ),
          { minKeys: 1, maxKeys: 1 },
        ),
      }),
      fc.record({ $addToSet: fc.dictionary(updatePath, value, { minKeys: 1, maxKeys: 1 }) }),
      fc.record({
        $pop: fc.dictionary(updatePath, fc.constantFrom(1, -1), { minKeys: 1, maxKeys: 1 }),
      }),
      fc.record({
        $pull: fc.dictionary(
          fc.constantFrom("a", "b", "a.b"),
          fc.oneof(value, fc.record({ $gte: value })),
          { minKeys: 1, maxKeys: 1 },
        ),
      }),
      fc.record({
        $pullAll: fc.dictionary(fc.constantFrom("a", "b"), fc.array(value, { maxLength: 3 }), {
          minKeys: 1,
          maxKeys: 1,
        }),
      }),
      fc.record({ $rename: fc.constantFrom({ a: "z" }, { b: "a.q" }, { "a.b": "y" }, { a: "b" }) }),
    )
    const updates = fc.sample(
      fc.tuple(fc.array(op, { minLength: 1, maxLength: 2 }), fc.nat({ max: DOCS - 1 })),
      { numRuns: DIFF_RUNS, seed: SEED },
    )
    const mismatches: string[] = []
    for (const [ops, index] of updates) {
      const update = Object.assign({}, ...ops) as Record<string, unknown>
      const usesFilter = JSON.stringify(
        Object.keys(update).map((key) => Object.keys(update[key] as object)),
      ).includes("$[x]")
      const arrayFilters = usesFilter ? [{ x: { $gte: 1 } }] : undefined
      const original = docs[index] as Document
      await target.deleteMany({})
      await target.insertOne(original)
      const expected = await mongoOutcome(async () => {
        const result = await target.findOneAndUpdate({ _id: original["_id"] }, update, {
          returnDocument: "after",
          ...(arrayFilters === undefined ? {} : { arrayFilters }),
        })
        return result
      })
      const actual = localOutcome(() =>
        applyUpdate(original, update, arrayFilters === undefined ? {} : { arrayFilters }),
      )
      if (!actual.ok && actual.unsupported) continue
      const describe = `update ${stringify(update)} on ${stringify(original)}`
      if (expected.ok !== actual.ok) {
        mismatches.push(
          `${describe}: MongoDB ${expected.ok ? stringify(expected.value) : `failed (${expected.message})`}, updater ${actual.ok ? stringify(actual.value) : `failed (${actual.message})`}`,
        )
      } else if (
        expected.ok &&
        actual.ok &&
        stringify(expected.value) !== stringify(actual.value)
      ) {
        mismatches.push(
          `${describe}: MongoDB ${stringify(expected.value)}, updater ${stringify(actual.value)}`,
        )
      }
      if (mismatches.length > 20) break
    }
    expect(mismatches.slice(0, 20), `${mismatches.length} mismatches`).toEqual([])
  }, 600_000)
})
